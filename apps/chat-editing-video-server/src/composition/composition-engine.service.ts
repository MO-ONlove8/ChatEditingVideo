import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import {
  clipFrames,
  defaultAudio,
  effectiveRange,
  emptyPackaging,
  plannedRange,
  timelineFrames,
  validatePackaging,
  type CompositionManifest,
  type MediaAsset,
  type Timeline,
  type AudioSettings,
} from '@cev/shared';
import { LayoutService } from './layout.service.js';
import { StorageService } from '../storage/storage.service.js';
import { MediaTools } from '../media/media-tools.service.js';

export const RENDER_CONFIG = 'd1-2:h264-crf18:aac192:48k-stereo';
export const contentHash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const envelope = (a: AudioSettings, length: number) =>
  [
    ...(a.fadeIn ? [`afade=t=in:ss=0:ns=${a.fadeIn * 1600}:curve=tri`] : []),
    ...(a.fadeOut
      ? [`afade=t=out:ss=${(length - a.fadeOut) * 1600}:ns=${a.fadeOut * 1600}:curve=tri`]
      : []),
    `volume=${a.muted ? 0 : a.volume / 100}:precision=double`,
  ].join(',');
@Injectable()
export class CompositionEngine {
  constructor(
    private readonly layout: LayoutService,
    private readonly storage: StorageService,
    private readonly tools: MediaTools,
  ) {}
  get fontHash() {
    return this.layout.fontHash;
  }
  validate(t: Timeline, assets: MediaAsset[], includeLayout = true) {
    const p = t.packaging ?? emptyPackaging(),
      frames = timelineFrames(t);
    validatePackaging(p, frames);
    const asset = (id: string, generation: number, kind: string) => {
      const a = assets.find(
        (v) =>
          v.id === id &&
          v.generation === generation &&
          v.kind === kind &&
          v.status === 'ready' &&
          !v.deleting,
      );
      if (!a) throw new Error('引用素材尚未就绪或文件版本已变化');
      return a;
    };
    for (const c of t.clips) {
      asset(c.source, c.generation, 'video');
      const a = c.audio ?? defaultAudio();
      if (a.fadeIn + a.fadeOut > clipFrames(c)) throw new Error('原声淡化超过Clip长度');
    }
    if (!t.canvas) return;
    if (includeLayout)
      for (const s of p.subtitles) this.layout.text(s.text, p.subtitleStyle, t.canvas, 2, false);
    for (const o of p.overlays) {
      if (o.kind === 'text') {
        if (includeLayout) this.layout.text(o.text, o.style, t.canvas, 4, false);
      } else {
        const a = asset(o.assetId, o.generation, 'image'),
          info = a.auxiliary;
        if (!info?.width || !info.height) throw new Error('图像尺寸不可用');
        const width = (t.canvas.width * o.width) / 100,
          height = (width * info.height) / info.width;
        const x = (t.canvas.width * o.x) / 100 - width / 2,
          y = (t.canvas.height * o.y) / 100 - height / 2;
        if (x < 0 || y < 0 || x + width > t.canvas.width || y + height > t.canvas.height)
          throw new Error(`I${o.number}整体超出画布，请调整宽度或位置`);
      }
    }
    for (const a of p.audio) {
      const source = asset(a.assetId, a.generation, 'audio');
      if (!source.auxiliary?.frames || a.sourceEnd >= source.auxiliary.frames)
        throw new Error(`A${a.number}源选段超出可用帧`);
    }
  }
  async prepare(t: Timeline, assets: MediaAsset[], projectId: string, signal?: AbortSignal) {
    this.validate(t, assets);
    const hash = contentHash({
      projectId,
      timeline: { ...t, revision: 0 },
      assets: assets
        .filter(
          (a) =>
            t.clips.some((c) => c.source === a.id) ||
            t.packaging?.overlays.some((o) => o.kind === 'image' && o.assetId === a.id) ||
            t.packaging?.audio.some((v) => v.assetId === a.id),
        )
        .map((a) => ({
          id: a.id,
          generation: a.generation,
          storageKey: a.storageKey,
          auxiliary: a.auxiliary,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      font: this.fontHash,
      config: RENDER_CONFIG,
    });
    return this.build(t, assets, projectId, hash, signal);
  }
  private async publish(key: string, data: string | Uint8Array) {
    const temp = key + '.' + randomUUID() + '.tmp';
    try {
      await this.storage.write(temp, data);
      await this.storage.moveIn(this.storage.resolve(temp), key);
    } finally {
      await this.storage.remove(temp);
    }
  }
  private async build(
    t: Timeline,
    assets: MediaAsset[],
    projectId: string,
    hash: string,
    signal?: AbortSignal,
  ): Promise<CompositionManifest> {
    const prefix = `projects/${projectId}/composition/${hash}`,
      manifestKey = `${prefix}/manifest.json`;
    if (await this.storage.exists(manifestKey)) {
      const m = JSON.parse(
        await readFile(this.storage.resolve(manifestKey), 'utf8'),
      ) as CompositionManifest;
      if (
        (
          await Promise.all(
            [m.audioKey, ...m.overlays.map((o) => o.key)].map((k) => this.storage.exists(k)),
          )
        ).every(Boolean)
      )
        return m;
    }
    const frames = timelineFrames(t),
      canvas = t.canvas;
    if (!frames || !canvas) throw new Error('暂无主视频，无法准备合成预览');
    const p = t.packaging ?? emptyPackaging(),
      overlays: CompositionManifest['overlays'] = [];
    await this.storage.write(`${prefix}/.keep`, '');
    const textImage = async (
      text: string,
      style: Parameters<LayoutService['text']>[1],
      label: string,
      range: Parameters<typeof effectiveRange>[0],
      maxLines: number,
    ) => {
      const result = this.layout.text(text, style, canvas, maxLines),
        r = effectiveRange(range, frames);
      if (!r) return;
      const key = `${prefix}/${label}.png`;
      await this.publish(key, result.png);
      overlays.push({
        key,
        label,
        x: result.x,
        y: result.y,
        width: result.width,
        height: result.height,
        ...r,
      });
    };
    for (const o of p.overlays) {
      signal?.throwIfAborted();
      if (o.kind === 'text') await textImage(o.text, o.style, `T${o.number}`, o.range, 4);
      else {
        const r = effectiveRange(o.range, frames);
        if (!r) continue;
        const source = assets.find((a) => a.id === o.assetId)!,
          info = source.auxiliary!;
        const width = Math.max(1, Math.round((canvas.width * o.width) / 100)),
          height = Math.max(1, Math.round((width * info.height!) / info.width!));
        const x = (canvas.width * o.x) / 100 - width / 2,
          y = (canvas.height * o.y) / 100 - height / 2;
        const key = `${prefix}/I${o.number}.png`;
        const pixels = await sharp(this.storage.resolve(info.workingKey!))
          .resize(width, height)
          .ensureAlpha()
          .raw()
          .toBuffer();
        for (let i = 3; i < pixels.length; i += 4)
          pixels[i] = Math.round((pixels[i]! * o.opacity) / 100);
        await this.publish(
          key,
          await sharp(pixels, { raw: { width, height, channels: 4 } })
            .png()
            .toBuffer(),
        );
        overlays.push({ key, label: `I${o.number}`, x, y, width, height, ...r });
      }
    }
    for (const s of p.subtitles)
      await textImage(
        s.text,
        p.subtitleStyle,
        `S${s.number}`,
        { mode: 'fixed', startFrame: s.startFrame, endFrame: s.endFrame },
        2,
      );
    const audioHash = contentHash({
      clips: t.clips,
      audio: p.audio,
      assets: assets
        .filter(
          (a) => t.clips.some((c) => c.source === a.id) || p.audio.some((v) => v.assetId === a.id),
        )
        .map((a) => ({
          id: a.id,
          generation: a.generation,
          key: a.auxiliary?.workingKey ?? a.editingKey ?? a.normalizedKey ?? a.storageKey,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      config: RENDER_CONFIG,
    });
    const mixPrefix = 'projects/' + projectId + '/composition/' + audioHash + '/mix';
    const audioKey = await this.cachedMix(t, assets, mixPrefix, signal);
    const manifest = { hash, frames, canvas, overlays, audioKey, fontHash: this.fontHash };
    signal?.throwIfAborted();
    await this.publish(manifestKey, JSON.stringify(manifest));
    return manifest;
  }
  private async ff(args: string[], signal?: AbortSignal) {
    return this.tools.run(
      this.tools.env.FFMPEG_PATH,
      [
        '-hide_banner',
        '-v',
        'error',
        '-nostdin',
        '-y',
        '-threads',
        String(this.tools.env.MEDIA_THREADS),
        ...args,
      ],
      signal,
    );
  }
  private async peak(key: string, signal?: AbortSignal) {
    const result = await this.ff(
      [
        '-i',
        this.storage.resolve(key),
        '-af',
        'astats=metadata=1:reset=0,ametadata=print:key=lavfi.astats.Overall.Peak_level:file=-',
        '-f',
        'null',
        '-',
      ],
      signal,
    );
    const peaks = [...result.matchAll(/lavfi\.astats\.Overall\.Peak_level=(-?[\d.]+|-inf)/g)];
    if (!peaks.length) throw new Error('无法校验声音峰值');
    const value = peaks.at(-1)![1];
    return value === '-inf' ? Number.NEGATIVE_INFINITY : Number(value);
  }
  private async cachedMix(t: Timeline, assets: MediaAsset[], prefix: string, signal?: AbortSignal) {
    if (await this.storage.exists(prefix + '/audio.m4a')) return prefix + '/audio.m4a';
    // Each execution owns its scratch files, including across worker processes.
    // Cancelling an obsolete candidate cannot abort a newer candidate's mix.
    return this.mix(t, assets, prefix, signal);
  }
  private async mix(t: Timeline, assets: MediaAsset[], prefix: string, signal?: AbortSignal) {
    const finalKey = prefix + '/audio.m4a';
    prefix = prefix + '/work-' + randomUUID();
    const count = timelineFrames(t),
      baseFiles: string[] = [];
    await this.storage.write(`${prefix}/.keep`, '');
    const pcm = ['-ar', '48000', '-ac', '2', '-c:a', 'pcm_f32le'];
    try {
      for (let i = 0; i < t.clips.length; i++) {
        const c = t.clips[i]!,
          asset = assets.find((a) => a.id === c.source)!,
          source =
            asset.editing?.kind === 'original'
              ? asset.storageKey
              : ((asset as MediaAsset & { editingKey?: string; normalizedKey?: string })
                  .editingKey ?? (asset as MediaAsset & { normalizedKey?: string }).normalizedKey);
        if (!source) throw new Error('视频音频来源文件不可用');
        const n = clipFrames(c),
          sec = Math.floor(c.startFrame / 30),
          start = c.startFrame - sec * 30,
          hasAudio =
            asset.editing?.info.hasAudio ?? asset.normalized?.hasAudio ?? asset.original?.hasAudio;
        const key = `${prefix}/${i}.wav`;
        await this.ff(
          [
            ...(hasAudio
              ? ['-ss', String(sec), '-i', this.storage.resolve(source), '-map', '0:a:0']
              : ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo']),
            '-vn',
            '-af',
            `aresample=48000,atrim=start_sample=${hasAudio ? start * 1600 : 0}:end_sample=${(hasAudio ? start + n : n) * 1600},asetpts=PTS-STARTPTS,apad,atrim=end_sample=${n * 1600},${envelope(c.audio ?? defaultAudio(), n)}`,
            ...pcm,
            this.storage.resolve(key),
          ],
          signal,
        );
        baseFiles.push(`file '${i}.wav'`);
      }
      await this.storage.write(
        `${prefix}/base.ffconcat`,
        `ffconcat version 1.0\n${baseFiles.join('\n')}\n`,
      );
      const base = `${prefix}/base.wav`;
      await this.ff(
        [
          '-f',
          'concat',
          '-safe',
          '1',
          '-i',
          this.storage.resolve(`${prefix}/base.ffconcat`),
          '-c:a',
          'copy',
          this.storage.resolve(base),
        ],
        signal,
      );
      const tracks = [base];
      for (const a of t.packaging?.audio ?? []) {
        const effective = effectiveRange(a.range, count);
        if (!effective) continue;
        const r = plannedRange(a.range, count),
          length = r.endFrame - r.startFrame + 1,
          source = assets.find((s) => s.id === a.assetId)!;
        const key = `${prefix}/A${a.number}.wav`,
          sourceLength = a.sourceEnd - a.sourceStart + 1;
        await this.ff(
          [
            '-i',
            this.storage.resolve(source.auxiliary!.workingKey!),
            '-af',
            `atrim=start_sample=${a.sourceStart * 1600}:end_sample=${(a.sourceEnd + 1) * 1600},asetpts=PTS-STARTPTS,${a.loop ? `aloop=loop=-1:size=${sourceLength * 1600},` : ''}apad,atrim=end_sample=${length * 1600},${envelope(a.settings, length)},adelay=${r.startFrame * 1600}S:all=1,apad,atrim=end_sample=${count * 1600}`,
            ...pcm,
            this.storage.resolve(key),
          ],
          signal,
        );
        tracks.push(key);
      }
      const mixed = `${prefix}/mixed.wav`;
      await this.ff(
        [
          ...tracks.flatMap((key) => ['-i', this.storage.resolve(key)]),
          '-filter_complex',
          `${tracks.map((_, i) => `[${i}:a]`).join('')}amix=inputs=${tracks.length}:duration=longest:normalize=0,apad,atrim=end_sample=${count * 1600}[mix]`,
          '-map',
          '[mix]',
          ...pcm,
          this.storage.resolve(mixed),
        ],
        signal,
      );
      const initial = await this.peak(mixed, signal);
      let gain = initial > -0.18 ? 10 ** ((-0.18 - initial) / 20) : 1;
      const output = prefix + '/candidate.m4a';
      for (let attempt = 0; attempt < 4; attempt++) {
        await this.ff(
          [
            '-i',
            this.storage.resolve(mixed),
            '-af',
            `volume=${gain}:precision=double`,
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
            this.storage.resolve(output),
          ],
          signal,
        );
        const peak = await this.peak(output, signal);
        if (peak <= -0.02) {
          signal?.throwIfAborted();
          await this.storage.moveIn(this.storage.resolve(output), finalKey);
          return finalKey;
        }
        gain *= 10 ** ((-0.25 - peak) / 20);
      }
      throw new Error('编码后峰值保护校验未通过，请重试');
    } finally {
      // The encoded mix is shared by the player and MP4; scratch PCM never becomes a dependency.
      await this.storage.removeTree(prefix);
    }
  }
}
