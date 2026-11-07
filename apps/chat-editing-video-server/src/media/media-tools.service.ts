import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import type { MediaInfo } from '@cev/shared';
import { APP_CONFIG } from '../config/config.module.js';
import type { Env } from '../config/env.js';

export interface ProbeInfo extends MediaInfo {
  audioOffset: number;
}

@Injectable()
export class MediaTools {
  private readonly logger = new Logger(MediaTools.name);
  constructor(@Inject(APP_CONFIG) readonly env: Env) {}

  async check() {
    const version = await this.run(this.env.FFMPEG_PATH, ['-version']);
    await this.run(this.env.FFPROBE_PATH, ['-version']);
    const encoders = await this.run(this.env.FFMPEG_PATH, ['-hide_banner', '-encoders']);
    if (!encoders.includes('libx264') || !encoders.includes(' aac '))
      throw new Error('FFmpeg 需要 libx264 和 AAC 编码器');
    this.logger.log(version.split('\n')[0]);
  }

  run(
    program: string,
    args: string[],
    signal?: AbortSignal,
    progress?: (seconds: number) => void,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('处理已取消'));
        return;
      }
      const child = spawn(program, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      let errors = '';
      let buffer = '';
      let timedOut = false;
      const abort = () => child.kill('SIGKILL');
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(
        () => {
          timedOut = true;
          abort();
        },
        60 * 60 * 1000,
      );
      child.stdout.on('data', (data: Buffer) => {
        const text = data.toString();
        output = (output + text).slice(-4_000_000);
        buffer += text;
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines)
          if (line.startsWith('out_time_us=')) progress?.(Number(line.slice(12)) / 1e6);
      });
      child.stderr.on('data', (data: Buffer) => {
        errors = (errors + data.toString()).slice(-8000);
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        reject(error);
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (signal?.aborted) reject(new Error('处理已取消'));
        else if (timedOut) reject(new Error('视频处理超时，请重试'));
        else if (code !== 0) {
          this.logger.warn(errors);
          reject(new Error('无法解码或处理此视频，请检查文件后重试'));
        } else resolve(output);
      });
    });
  }

  async probe(file: string, count = false, signal?: AbortSignal): Promise<ProbeInfo> {
    const raw = await this.run(
      this.env.FFPROBE_PATH,
      [
        '-v',
        'error',
        '-protocol_whitelist',
        'file,pipe',
        ...(count ? ['-count_frames'] : []),
        '-show_streams',
        '-show_format',
        '-of',
        'json',
        file,
      ],
      signal,
    ).catch((error: unknown) => {
      if (signal?.aborted || (error instanceof Error && 'code' in error)) throw error;
      throw new BadRequestException('无法读取视频，文件可能已损坏或编码不受支持');
    });
    const data = JSON.parse(raw) as {
      format: { format_name: string; duration?: string };
      streams: Array<{
        codec_type: string;
        width?: number;
        height?: number;
        duration?: string;
        start_time?: string;
        sample_aspect_ratio?: string;
        color_transfer?: string;
        nb_read_frames?: string;
        disposition?: { attached_pic?: number };
        side_data_list?: Array<{ rotation?: number }>;
        tags?: { rotate?: string };
      }>;
    };
    const video = data.streams.find(
      (s) => s.codec_type === 'video' && !s.disposition?.attached_pic,
    );
    const audio = data.streams.find((s) => s.codec_type === 'audio');
    if (
      !video ||
      !video.width ||
      !video.height ||
      !data.format.format_name.split(',').some((f) => ['mov', 'mp4'].includes(f))
    ) {
      throw new BadRequestException('文件必须是包含视频流的 MP4 / MOV');
    }
    const duration = Number(video.duration ?? data.format.duration);
    if (!Number.isFinite(duration) || duration <= 0)
      throw new BadRequestException('无法读取视频时长，文件可能已损坏');
    const rotation = Number(
      video.side_data_list?.find((s) => s.rotation !== undefined)?.rotation ??
        video.tags?.rotate ??
        0,
    );
    const [sarN, sarD] = (video.sample_aspect_ratio ?? '1:1').split(':').map(Number);
    let width = Math.round(video.width * (sarN && sarD ? sarN / sarD : 1));
    let height = video.height;
    if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width];
    const frameCount = count ? Number(video.nb_read_frames) : undefined;
    return {
      duration,
      width,
      height,
      rotation,
      hasAudio: Boolean(audio),
      hdr: ['smpte2084', 'arib-std-b67'].includes(video.color_transfer ?? ''),
      ...(frameCount && Number.isFinite(frameCount) ? { frameCount } : {}),
      audioOffset:
        Number(audio?.start_time ?? video.start_time ?? 0) - Number(video.start_time ?? 0),
    };
  }

  async normalize(
    input: string,
    output: string,
    info: ProbeInfo,
    signal: AbortSignal,
    progress: (seconds: number) => void,
  ) {
    await mkdir(path.dirname(output), { recursive: true });
    const ratio = Math.min(1, 1920 / Math.max(info.width, info.height));
    const width = Math.max(2, Math.floor((info.width * ratio) / 2) * 2);
    const height = Math.max(2, Math.floor((info.height * ratio) / 2) * 2);
    const frameCount = Math.max(1, Math.round(info.duration * 30));
    const duration = frameCount / 30;
    const tone = info.hdr
      ? 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,'
      : '';
    const vf = `${tone}scale=${width}:${height},setsar=1,setpts=PTS-STARTPTS,fps=fps=30:start_time=0,tpad=stop_mode=clone:stop_duration=1,trim=end_frame=${frameCount},format=yuv420p`;
    const audio = `asetpts=PTS-STARTPTS,${info.audioOffset < 0 ? `atrim=start=${-info.audioOffset},asetpts=PTS-STARTPTS,` : info.audioOffset > 0 ? `adelay=${Math.round(info.audioOffset * 1000)}:all=1,` : ''}aresample=48000,apad,atrim=duration=${duration}`;
    await this.run(
      this.env.FFMPEG_PATH,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        '-y',
        '-protocol_whitelist',
        'file,pipe',
        '-threads',
        String(this.env.MEDIA_THREADS),
        '-i',
        input,
        ...(!info.hasAudio ? ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo'] : []),
        '-map',
        '0:v:0',
        '-map',
        info.hasAudio ? '0:a:0' : '1:a:0',
        '-vf',
        vf,
        '-af',
        audio,
        '-t',
        String(duration),
        '-c:v',
        'libx264',
        '-preset',
        'medium',
        '-crf',
        '18',
        '-threads',
        String(this.env.MEDIA_THREADS),
        '-filter_threads',
        String(this.env.MEDIA_THREADS),
        '-g',
        '30',
        '-keyint_min',
        '30',
        '-sc_threshold',
        '0',
        '-fps_mode',
        'cfr',
        ...(info.hdr
          ? [
              '-color_primaries',
              'bt709',
              '-color_trc',
              'bt709',
              '-colorspace',
              'bt709',
              '-color_range',
              'tv',
            ]
          : []),
        '-c:a',
        'aac',
        '-ar',
        '48000',
        '-ac',
        '2',
        '-b:a',
        '192k',
        '-map_metadata',
        '-1',
        '-metadata:s:v:0',
        'rotate=0',
        '-movflags',
        '+faststart',
        '-progress',
        'pipe:1',
        output,
      ],
      signal,
      progress,
    );
  }

  async thumbnails(input: string, prefix: string, count: number, signal: AbortSignal) {
    await mkdir(prefix, { recursive: true });
    for (let page = 0; page < Math.ceil(count / 900); page++) {
      const frames = Math.min(30, Math.ceil((count - page * 900) / 30));
      await this.run(
        this.env.FFMPEG_PATH,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-nostdin',
          '-y',
          '-ss',
          String(page * 30),
          '-i',
          input,
          '-an',
          '-vf',
          `select=not(mod(n\\,30)),scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2,tile=10x3:nb_frames=${frames}`,
          '-frames:v',
          '1',
          '-threads',
          '1',
          path.join(prefix, `thumb-${page}.jpg`),
        ],
        signal,
      );
    }
  }
}
