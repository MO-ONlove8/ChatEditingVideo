import { Injectable } from '@nestjs/common';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { AuxiliaryPolicy, parseSrt, type AuxiliaryInfo, type AssetKind } from '@cev/shared';
import { MediaTools } from '../media/media-tools.service.js';
import { StorageService } from '../storage/storage.service.js';

@Injectable()
export class AuxiliaryTools {
  constructor(
    private readonly tools: MediaTools,
    private readonly storage: StorageService,
  ) {}
  async prepare(
    file: string,
    kind: Exclude<AssetKind, 'video'>,
    name: string,
    prefix: string,
    signal?: AbortSignal,
  ): Promise<AuxiliaryInfo> {
    await mkdir(this.storage.resolve(prefix), { recursive: true });
    if (kind === 'image') {
      const image = sharp(file, { animated: true, limitInputPixels: 8192 ** 2, failOn: 'warning' });
      const meta = await image.metadata();
      if (meta.format === 'png') {
        const bytes = await readFile(file);
        let offset = 8;
        while (offset + 12 <= bytes.length) {
          const length = bytes.readUInt32BE(offset),
            type = bytes.toString('ascii', offset + 4, offset + 8);
          if (type === 'acTL') throw new Error('不支持APNG动画');
          if (length > bytes.length - offset - 12) throw new Error('PNG文件已截断');
          offset += length + 12;
          if (type === 'IEND') break;
        }
      }
      const format = meta.format;
      if (!['png', 'jpeg', 'webp'].includes(format ?? '') || (meta.pages ?? 1) !== 1)
        throw new Error('仅接受PNG、JPEG、静态WebP，不支持动画');
      const extensions: Record<string, RegExp> = {
        png: /\.png$/i,
        jpeg: /\.jpe?g$/i,
        webp: /\.webp$/i,
      };
      if (!format || !extensions[format]!.test(name)) throw new Error('文件实际格式与扩展名不一致');
      if (
        !meta.width ||
        !meta.height ||
        Math.max(meta.width, meta.height) > AuxiliaryPolicy.image.maxEdge
      )
        throw new Error('图像长边不能超过8192像素');
      const workingKey = `${prefix}/image.png`;
      const output = await sharp(file, { limitInputPixels: 8192 ** 2 })
        .autoOrient()
        .toColourspace('srgb')
        .png()
        .toFile(this.storage.resolve(workingKey));
      return { width: output.width, height: output.height, workingKey, mime: 'image/png' };
    }
    if (kind === 'srt') {
      const bytes = await readFile(file);
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return { cues: parseSrt(text), mime: 'application/x-subrip' };
    }
    const raw = JSON.parse(
      await this.tools.run(
        this.tools.env.FFPROBE_PATH,
        [
          '-v',
          'error',
          '-protocol_whitelist',
          'file,pipe',
          '-show_streams',
          '-show_format',
          '-of',
          'json',
          file,
        ],
        signal,
      ),
    ) as {
      format: { format_name: string };
      streams: { index: number; codec_type: string; duration?: string }[];
    };
    const audioTrack = raw.streams.find((s) => s.codec_type === 'audio');
    if (!audioTrack) throw new Error('文件没有可解码音轨');
    const allowed = /\.mp3$/i.test(name)
      ? raw.format.format_name.includes('mp3')
      : /\.wav$/i.test(name)
        ? raw.format.format_name.includes('wav')
        : /\.m4a$/i.test(name) && raw.format.format_name.includes('mov');
    if (!allowed) throw new Error('声音实际格式与扩展名不一致');
    const workingKey = `${prefix}/audio.wav`;
    await this.tools.run(
      this.tools.env.FFMPEG_PATH,
      [
        '-v',
        'error',
        '-xerror',
        '-err_detect',
        'explode',
        '-nostdin',
        '-y',
        '-protocol_whitelist',
        'file,pipe',
        '-i',
        file,
        '-map',
        `0:${audioTrack.index}`,
        '-vn',
        '-t',
        '1800.034',
        '-ar',
        '48000',
        '-ac',
        '2',
        '-c:a',
        'pcm_f32le',
        this.storage.resolve(workingKey),
      ],
      signal,
    );
    const info = JSON.parse(
      await this.tools.run(
        this.tools.env.FFPROBE_PATH,
        ['-v', 'error', '-show_streams', '-of', 'json', this.storage.resolve(workingKey)],
        signal,
      ),
    ) as { streams: { duration_ts: number; sample_rate: string }[] };
    const samples = Number(info.streams[0]?.duration_ts);
    if (!Number.isSafeInteger(samples) || samples <= 0 || samples > 1800 * 48000)
      throw new Error('音频必须大于0且不超过30分钟');
    const frames = Math.ceil(samples / 1600);
    return { workingKey, frames, audioTrackIndex: audioTrack.index, mime: 'audio/wav' };
  }
  async paddedAudio(info: AuxiliaryInfo, signal?: AbortSignal) {
    if (!info.workingKey || !info.frames) throw new Error('音频工作文件不可用');
    const padded = path.posix.join(path.posix.dirname(info.workingKey), 'padded.wav');
    await this.tools.run(
      this.tools.env.FFMPEG_PATH,
      [
        '-v',
        'error',
        '-nostdin',
        '-y',
        '-i',
        this.storage.resolve(info.workingKey),
        '-af',
        `apad,atrim=end_sample=${info.frames * 1600}`,
        '-c:a',
        'pcm_f32le',
        this.storage.resolve(padded),
      ],
      signal,
    );
    return { ...info, workingKey: padded };
  }
}
