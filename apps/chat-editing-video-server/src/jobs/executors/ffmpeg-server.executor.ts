import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  clipFrames,
  type EditExecutor,
  type ExecuteOptions,
  type ExecuteResult,
  type CompositeRenderPlan,
  exportSrt,
  timelineFrames,
} from '@cev/shared';
import sharp from 'sharp';
import { CompositionEngine } from '../../composition/composition-engine.service.js';
import { StorageService } from '../../storage/storage.service.js';
import { MediaTools } from '../../media/media-tools.service.js';

@Injectable()
export class FfmpegServerExecutor implements EditExecutor {
  readonly kind = 'server' as const;
  constructor(
    private readonly storage: StorageService,
    private readonly tools: MediaTools,
    private readonly composition: CompositionEngine,
  ) {}
  async execute({
    jobId,
    executionId = randomUUID(),
    plan,
    onEvent,
    signal,
  }: ExecuteOptions): Promise<ExecuteResult> {
    if (plan.version === 1) throw new Error('历史占位方案不可生成，请按当前剪辑重新下载');
    if (plan.version === 4) return this.composite({ jobId, executionId, plan, onEvent, signal });
    const prefix = `renders/${jobId}/${executionId}`;
    const temp = `${prefix}/segments`;
    await this.storage.write(`${temp}/video.ffconcat`, 'ffconcat version 1.0\n');
    const total = plan.clips.reduce((n, c) => n + clipFrames(c), 0);
    const { width, height } = plan.output;
    const threads = String(this.tools.env.MEDIA_THREADS);
    const videos: string[] = [],
      audios: string[] = [];
    let done = 0;
    try {
      for (let i = 0; i < plan.clips.length; i++) {
        signal?.throwIfAborted();
        const c = plan.clips[i]!,
          count = clipFrames(c),
          second = Math.floor(c.startFrame / 30),
          start = c.startFrame - second * 30;
        const hasAudio = !('hasAudio' in c) || c.hasAudio;
        const name = String(i).padStart(3, '0');
        const vf = `trim=start_frame=${start}:end_frame=${start + count},setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p`;
        const af = `aresample=48000,atrim=start_sample=${start * 1600}:end_sample=${(start + count) * 1600},asetpts=PTS-STARTPTS,apad,atrim=end_sample=${count * 1600}`;
        await this.tools.run(
          this.tools.env.FFMPEG_PATH,
          [
            '-hide_banner',
            '-loglevel',
            'error',
            '-nostdin',
            '-y',
            '-protocol_whitelist',
            'file,pipe',
            '-threads',
            threads,
            '-ss',
            String(second),
            '-i',
            this.storage.resolve(c.sourceKey),
            ...(!hasAudio ? ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo'] : []),
            '-map',
            '0:v:0',
            '-an',
            '-vf',
            vf,
            '-c:v',
            'libx264',
            '-preset',
            'medium',
            '-crf',
            '18',
            '-profile:v',
            'high',
            '-level:v',
            '5.1',
            '-threads',
            threads,
            '-filter_threads',
            threads,
            '-g',
            '30',
            '-keyint_min',
            '30',
            '-sc_threshold',
            '0',
            '-r',
            '30',
            '-fps_mode',
            'cfr',
            '-video_track_timescale',
            '90000',
            '-frames:v',
            String(count),
            this.storage.resolve(`${temp}/${name}.mp4`),
            '-map',
            hasAudio ? '0:a:0' : '1:a:0',
            '-vn',
            '-af',
            af,
            '-c:a',
            'pcm_s16le',
            '-ar',
            '48000',
            '-ac',
            '2',
            this.storage.resolve(`${temp}/${name}.wav`),
            '-progress',
            'pipe:1',
            '-nostats',
          ],
          signal,
          (seconds) =>
            onEvent?.({
              type: 'progress',
              jobId,
              progress: Math.min(
                90,
                Math.floor(((done + Math.min(count, seconds * 30)) / total) * 90),
              ),
            }),
        );
        done += count;
        videos.push(`file '${name}.mp4'`);
        audios.push(`file '${name}.wav'`);
      }
      await this.storage.write(
        `${temp}/video.ffconcat`,
        `ffconcat version 1.0\n${videos.join('\n')}\n`,
      );
      await this.storage.write(
        `${temp}/audio.ffconcat`,
        `ffconcat version 1.0\n${audios.join('\n')}\n`,
      );
      const output = `${prefix}/output.mp4`;
      await this.tools.run(
        this.tools.env.FFMPEG_PATH,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-nostdin',
          '-y',
          '-protocol_whitelist',
          'file,pipe',
          '-f',
          'concat',
          '-safe',
          '1',
          '-i',
          this.storage.resolve(`${temp}/video.ffconcat`),
          '-f',
          'concat',
          '-safe',
          '1',
          '-i',
          this.storage.resolve(`${temp}/audio.ffconcat`),
          '-map',
          '0:v:0',
          '-map',
          '1:a:0',
          '-c:v',
          'copy',
          '-af',
          `apad,atrim=end_sample=${total * 1600}`,
          '-c:a',
          'aac',
          '-b:a',
          '192k',
          '-ar',
          '48000',
          '-ac',
          '2',
          '-movflags',
          '+faststart',
          '-video_track_timescale',
          '90000',
          '-progress',
          'pipe:1',
          '-nostats',
          this.storage.resolve(output),
        ],
        signal,
        (seconds) =>
          onEvent?.({
            type: 'progress',
            jobId,
            progress: Math.min(99, 90 + Math.floor((seconds / (total / 30)) * 9)),
          }),
      );
      const info = await this.tools.probe(this.storage.resolve(output), true, signal);
      if (info.frameCount !== total || info.width !== width || info.height !== height)
        throw new Error('生成成品的帧数或尺寸校验失败，请重试');
      return { output };
    } catch (error) {
      await this.storage.removeTree(prefix);
      throw error;
    } finally {
      await this.storage.removeTree(temp);
    }
  }
  private async composite({
    jobId,
    executionId,
    plan,
    onEvent,
    signal,
  }: ExecuteOptions & { plan: CompositeRenderPlan }): Promise<ExecuteResult> {
    const prefix = `renders/${jobId}/${executionId}`,
      temp = `${prefix}/overlays`;
    if (plan.outputType === 'srt') {
      const text = exportSrt(
        plan.timeline.packaging?.subtitles ?? [],
        timelineFrames(plan.timeline),
      );
      if (!text) throw new Error('没有有效字幕');
      const output = `${prefix}/output.srt`;
      await this.storage.write(output, text);
      return { output };
    }
    if (plan.fontHash !== this.composition.fontHash)
      throw new Error('快照字体版本不匹配，请恢复原字体版本后重试');
    try {
      const manifest = await this.composition.prepare(
        plan.timeline,
        plan.assets,
        plan.projectId,
        signal,
      );
      const base = await this.execute({
        jobId,
        executionId,
        plan: { version: 3, revision: plan.revision, clips: plan.clips, output: plan.output },
        signal,
        onEvent: (e) => {
          if (e.type === 'progress') onEvent?.({ ...e, progress: Math.floor(e.progress * 0.65) });
        },
      });
      const { width, height } = manifest.canvas,
        total = manifest.frames;
      const events = [
        ...new Set([0, total, ...manifest.overlays.flatMap((o) => [o.startFrame, o.endFrame + 1])]),
      ].sort((a, b) => a - b);
      const entries: string[] = [];
      await this.storage.write(`${temp}/.keep`, '');
      for (let i = 0; i < events.length - 1; i++) {
        signal?.throwIfAborted();
        const frame = events[i]!,
          next = events[i + 1]!,
          name = `${i}.png`;
        const layers = manifest.overlays
          .filter((o) => o.startFrame <= frame && o.endFrame >= frame)
          .map((o) => ({
            input: this.storage.resolve(o.key),
            left: Math.round(o.x),
            top: Math.round(o.y),
          }));
        await sharp({
          create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
        })
          .composite(layers)
          .png()
          .toFile(this.storage.resolve(`${temp}/${name}`));
        entries.push(`file '${name}'\noption framerate 30\nduration ${(next - frame) / 30}`);
      }
      entries.push(`file '${events.length - 2}.png'\noption framerate 30`);
      await this.storage.write(
        `${temp}/layers.ffconcat`,
        `ffconcat version 1.0\n${entries.join('\n')}\n`,
      );
      const output = `${prefix}/composite.mp4`,
        threads = String(this.tools.env.MEDIA_THREADS);
      await this.tools.run(
        this.tools.env.FFMPEG_PATH,
        [
          '-hide_banner',
          '-v',
          'error',
          '-nostdin',
          '-y',
          '-threads',
          threads,
          '-i',
          this.storage.resolve(base.output),
          '-f',
          'concat',
          '-safe',
          '0',
          '-protocol_whitelist',
          'file,pipe',
          '-i',
          this.storage.resolve(`${temp}/layers.ffconcat`),
          '-i',
          this.storage.resolve(manifest.audioKey),
          '-filter_complex_threads',
          threads,
          '-filter_complex',
          '[0:v][1:v]overlay=x=0:y=0:format=auto:shortest=1,format=yuv420p[v]',
          '-map',
          '[v]',
          '-map',
          '2:a:0',
          '-c:v',
          'libx264',
          '-preset',
          'medium',
          '-crf',
          '18',
          '-threads',
          threads,
          '-r',
          '30',
          '-fps_mode',
          'cfr',
          '-frames:v',
          String(total),
          '-c:a',
          'copy',
          '-movflags',
          '+faststart',
          '-video_track_timescale',
          '90000',
          '-progress',
          'pipe:1',
          '-nostats',
          this.storage.resolve(output),
        ],
        signal,
        (seconds) =>
          onEvent?.({
            type: 'progress',
            jobId,
            progress: Math.min(99, 65 + Math.floor((seconds / (total / 30)) * 34)),
          }),
      );
      const info = await this.tools.probe(this.storage.resolve(output), true, signal);
      if (info.frameCount !== total || info.width !== width || info.height !== height)
        throw new Error('合成成品帧数或尺寸校验失败');
      await this.storage.remove(base.output);
      return { output };
    } catch (e) {
      await this.storage.removeTree(prefix);
      throw e;
    } finally {
      await this.storage.removeTree(temp);
    }
  }
}
