import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { readFile, rm, stat } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  MediaAssetSchema,
  defaultAudio,
  defaultTextStyle,
  emptyPackaging,
  type Timeline,
  type CompositeRenderPlan,
} from '@cev/shared';
import { StorageService } from '../../src/storage/storage.service.js';
import { MediaTools } from '../../src/media/media-tools.service.js';
import { loadEnv } from '../../src/config/env.js';
import { LayoutService } from '../../src/composition/layout.service.js';
import { CompositionEngine } from '../../src/composition/composition-engine.service.js';
import { AuxiliaryTools } from '../../src/composition/auxiliary-tools.service.js';
import { FfmpegServerExecutor } from '../../src/jobs/executors/ffmpeg-server.executor.js';

describe('D1 real signal and portrait composition', () => {
  it('shares the identical encoded three-track mix with MP4 and keeps one-frame portrait events exact', async () => {
    const env = loadEnv(),
      root = path.resolve('storage', 'd1-signal-' + randomUUID()),
      storage = new StorageService({ ...env, STORAGE_DIR: root });
    const tools = new MediaTools(env),
      layout = new LayoutService(),
      engine = new CompositionEngine(layout, storage, tools),
      aux = new AuxiliaryTools(tools, storage);
    const ff = (args: string[]) => tools.run(env.FFMPEG_PATH, ['-v', 'error', '-y', ...args]);
    const projectId = randomUUID(),
      ownerId = randomUUID();
    try {
      await storage.write('.keep', '');
      await ff([
        '-f',
        'lavfi',
        '-i',
        'color=c=black:size=180x320:rate=30:duration=2',
        '-f',
        'lavfi',
        '-i',
        'aevalsrc=if(eq(n\\,1600)\\,0.4\\,0):s=48000:d=2',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'pcm_s16le',
        '-threads',
        '1',
        storage.resolve('original.mov'),
      ]);
      const info = await tools.probe(storage.resolve('original.mov'), true);
      const video = MediaAssetSchema.parse({
        id: randomUUID(),
        projectId,
        kind: 'video',
        fileName: 'original.mov',
        mimeType: 'video/quicktime',
        sizeBytes: (await stat(storage.resolve('original.mov'))).size,
        storageKey: 'original.mov',
        number: 1,
        status: 'ready',
        stage: 'ready',
        progress: 100,
        error: null,
        generation: 1,
        deleting: false,
        original: info,
        normalized: null,
        editing: { kind: 'original', info },
        createdAt: new Date().toISOString(),
      });
      await ff([
        '-f',
        'lavfi',
        '-i',
        'aevalsrc=if(eq(n\\,2940)\\,0.6\\,0):s=44100:d=1',
        '-c:a',
        'pcm_s16le',
        storage.resolve('narration.wav'),
      ]);
      await ff([
        '-f',
        'lavfi',
        '-i',
        'aevalsrc=if(eq(n\\,6400)\\,0.9\\,0):s=48000:d=1',
        '-ac',
        '2',
        '-c:a',
        'pcm_f32le',
        storage.resolve('bgm.wav'),
      ]);
      const audio = await Promise.all(
        ['narration', 'bgm'].map(async (name, i) =>
          MediaAssetSchema.parse({
            ...video,
            id: randomUUID(),
            kind: 'audio',
            fileName: name + '.wav',
            storageKey: name + '.wav',
            number: i + 1,
            original: null,
            editing: null,
            auxiliary: await aux.paddedAudio(
              await aux.prepare(
                storage.resolve(name + '.wav'),
                'audio',
                name + '.wav',
                'working/' + name,
              ),
            ),
          }),
        ),
      );
      const t: Timeline = {
        revision: 7,
        fps: 30,
        canvas: { width: 180, height: 320 },
        clips: [
          {
            id: randomUUID(),
            source: video.id,
            generation: 1,
            startFrame: 0,
            endFrame: 59,
            audio: defaultAudio(),
          },
        ],
        packaging: emptyPackaging(),
      };
      t.packaging!.overlays = [
        {
          id: randomUUID(),
          number: 1,
          kind: 'text',
          text: '中文竖屏',
          style: defaultTextStyle(),
          range: { mode: 'fixed', startFrame: 10, endFrame: 10 },
        },
      ];
      t.packaging!.audio = audio.map((a, i) => ({
        id: randomUUID(),
        number: i + 1,
        role: i ? 'bgm' : 'narration',
        assetId: a.id,
        generation: 1,
        sourceStart: 0,
        sourceEnd: 29,
        range: i ? { mode: 'whole' } : { mode: 'fixed', startFrame: 0, endFrame: 59 },
        settings: { ...defaultAudio(), volume: i ? 200 : 100 },
        loop: !!i,
      }));
      const assets = [video, ...audio],
        manifest = await engine.prepare(t, assets, projectId);
      const plan: CompositeRenderPlan = {
        version: 4,
        projectId,
        ownerId,
        projectName: '三类声音',
        outputType: 'mp4',
        configHash: 'test',
        fontHash: engine.fontHash,
        timeline: t,
        assets,
        revision: 7,
        clips: [
          { ...t.clips[0]!, sourceKey: video.storageKey, sourceMode: 'original', hasAudio: true },
        ],
        output: { container: 'mp4', width: 180, height: 320 },
      };
      const { output } = await new FfmpegServerExecutor(storage, tools, engine).execute({
        jobId: randomUUID(),
        plan,
      });
      expect(await tools.probe(storage.resolve(output), true)).toMatchObject({
        width: 180,
        height: 320,
        frameCount: 60,
        hasAudio: true,
        sampleRate: 48000,
        channels: 2,
      });
      const decode = async (key: string, name: string) => {
        await ff([
          '-i',
          storage.resolve(key),
          '-map',
          '0:a:0',
          '-f',
          'f32le',
          '-c:a',
          'pcm_f32le',
          storage.resolve(name),
        ]);
        return readFile(storage.resolve(name));
      };
      const mix = await decode(manifest.audioKey, 'mix.f32'),
        exported = await decode(output, 'export.f32');
      expect(exported.equals(mix)).toBe(true);
      let peak = 0;
      const event = (sample: number) => {
        let value = 0,
          position = 0;
        for (let n = Math.max(0, sample - 800); n < sample + 800; n++) {
          const v = Math.abs(mix.readFloatLE(n * 8));
          if (v > value) {
            value = v;
            position = n;
          }
        }
        expect(value).toBeGreaterThan(0.01);
        expect(Math.abs(position - sample)).toBeLessThanOrEqual(1600);
      };
      for (let n = 0; n < mix.length; n += 4) peak = Math.max(peak, Math.abs(mix.readFloatLE(n)));
      expect(peak).toBeLessThanOrEqual(1);
      [1600, 3200, 6400, 54400].forEach(event);
      // Narration never loops: its impulse at 3200 must not reappear one second later.
      let tail = 0;
      for (let n = 51000; n < 51400; n++) tail = Math.max(tail, Math.abs(mix.readFloatLE(n * 8)));
      expect(tail).toBeLessThan(0.01);
      await ff([
        '-i',
        storage.resolve(output),
        '-vf',
        'select=between(n\\,9\\,11)',
        '-fps_mode',
        'passthrough',
        storage.resolve('frame-%d.png'),
      ]);
      const image = await sharp(storage.resolve(manifest.overlays[0]!.key))
        .raw()
        .toBuffer({ resolveWithObject: true });
      let p = 0;
      for (let n = 0; n < image.data.length; n += 4)
        if (image.data[n]! > 220 && image.data[n + 3]! > 220) {
          p = n / 4;
          break;
        }
      const layer = manifest.overlays[0]!,
        x = Math.round(layer.x) + (p % image.info.width),
        y = Math.round(layer.y) + Math.floor(p / image.info.width);
      const pixel = async (n: number) => {
        const { data, info } = await sharp(storage.resolve('frame-' + n + '.png'))
          .raw()
          .toBuffer({ resolveWithObject: true });
        return data[(y * info.width + x) * info.channels]!;
      };
      expect(await pixel(2)).toBeGreaterThan(150);
      expect(await pixel(1)).toBeLessThan(30);
      expect(await pixel(3)).toBeLessThan(30);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60000);
});
