import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { readdir, stat, rm, writeFile } from 'node:fs/promises';
import { describe, it, expect } from 'vitest';
import {
  MediaAssetSchema,
  emptyPackaging,
  defaultTextStyle,
  defaultAudio,
  type Timeline,
} from '@cev/shared';
import { StorageService } from '../../src/storage/storage.service.js';
import { MediaTools } from '../../src/media/media-tools.service.js';
import { loadEnv } from '../../src/config/env.js';
import { LayoutService } from '../../src/composition/layout.service.js';
import { CompositionEngine } from '../../src/composition/composition-engine.service.js';
import { videoFixture } from '../support/video.js';

// Explicit opt-in: decodes/encodes a real 30-minute mix and measures disk/RSS.
describe.skipIf(process.env.CEV_D1_PERFORMANCE !== '1')('D1 maximum document composition', () => {
  it('prepares 100 clips, 1000 subtitles and 20 overlays without unbounded scratch retention', async () => {
    const env = loadEnv(),
      root = path.resolve('storage', 'd1-load-' + randomUUID()),
      storage = new StorageService({ ...env, STORAGE_DIR: root });
    const tools = new MediaTools(env),
      engine = new CompositionEngine(new LayoutService(), storage, tools),
      projectId = randomUUID(),
      id = randomUUID();
    const disk = async (dir: string): Promise<number> => {
      let n = 0;
      for (const item of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, item.name);
        n += item.isDirectory() ? await disk(full) : (await stat(full)).size;
      }
      return n;
    };
    let peakDisk = 0;
    const timer = setInterval(
      () =>
        void disk(root)
          .then((n) => {
            peakDisk = Math.max(peakDisk, n);
          })
          .catch(() => {}),
      1000,
    );
    try {
      await videoFixture(storage.resolve('source.mp4'), [], 30, 18);
      const info = await tools.probe(storage.resolve('source.mp4'), true);
      const asset = MediaAssetSchema.parse({
        id,
        projectId,
        fileName: 'source.mp4',
        mimeType: 'video/mp4',
        sizeBytes: (await stat(storage.resolve('source.mp4'))).size,
        storageKey: 'source.mp4',
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
      await tools.run(env.FFMPEG_PATH, [
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=48000:duration=1',
        '-ac',
        '2',
        '-c:a',
        'pcm_f32le',
        storage.resolve('voice.wav'),
      ]);
      const audio = MediaAssetSchema.parse({
        ...asset,
        id: randomUUID(),
        kind: 'audio',
        fileName: 'voice.wav',
        storageKey: 'voice.wav',
        original: null,
        editing: null,
        auxiliary: { frames: 30, workingKey: 'voice.wav' },
      });
      const t: Timeline = {
        revision: 1,
        fps: 30,
        canvas: { width: 1920, height: 1080 },
        clips: Array.from({ length: 100 }, () => ({
          id: randomUUID(),
          source: id,
          generation: 1,
          startFrame: 0,
          endFrame: 539,
        })),
        packaging: emptyPackaging(),
      };
      t.packaging!.subtitles = Array.from({ length: 1000 }, (_, i) => ({
        id: randomUUID(),
        number: i + 1,
        text: '真实中文负载验证 ' + i,
        startFrame: i * 54,
        endFrame: i * 54 + 29,
      }));
      t.packaging!.overlays = Array.from({ length: 20 }, (_, i) => ({
        id: randomUUID(),
        number: i + 1,
        kind: 'text',
        text: '标题 ' + i,
        range: { mode: 'whole' },
        style: defaultTextStyle(),
      }));
      t.packaging!.audio = [
        {
          id: randomUUID(),
          number: 1,
          role: 'bgm',
          assetId: audio.id,
          generation: 1,
          sourceStart: 0,
          sourceEnd: 29,
          range: { mode: 'whole' },
          settings: { ...defaultAudio(), volume: 20 },
          loop: true,
        },
        {
          id: randomUUID(),
          number: 2,
          role: 'narration',
          assetId: audio.id,
          generation: 1,
          sourceStart: 0,
          sourceEnd: 29,
          range: { mode: 'fixed', startFrame: 60, endFrame: 299 },
          settings: defaultAudio(),
          loop: false,
        },
      ];
      const started = performance.now(),
        manifest = await engine.prepare(t, [asset, audio], projectId),
        elapsed = performance.now() - started;
      expect(manifest.frames).toBe(54000);
      expect(manifest.overlays).toHaveLength(1020);
      const cached = performance.now();
      expect((await engine.prepare(t, [asset, audio], projectId)).hash).toBe(manifest.hash);
      const cachedPrepareMs = Math.round(performance.now() - cached);
      const audioInfo = JSON.parse(
        await tools.run(env.FFPROBE_PATH, [
          '-v',
          'error',
          '-show_streams',
          '-of',
          'json',
          storage.resolve(manifest.audioKey),
        ]),
      );
      expect(Number(audioInfo.streams[0].duration)).toBeCloseTo(1800, 1);
      const retained = await disk(root);
      const report = {
        node: process.version,
        platform: process.platform,
        canvas: t.canvas,
        clips: 100,
        subtitles: 1000,
        overlays: 20,
        frames: 54000,
        prepareMs: Math.round(elapsed),
        cachedPrepareMs,
        maxRssKiB: process.resourceUsage().maxRSS,
        peakDiskBytes: Math.max(peakDisk, retained),
        retainedBytes: retained,
      };
      await writeFile(
        path.resolve('storage', 'd1-performance.json'),
        JSON.stringify(report, null, 2),
      );
      console.info('D1_PERFORMANCE', JSON.stringify(report));
      expect(retained).toBeLessThan(200 * 1024 * 1024);
    } finally {
      clearInterval(timer);
      await rm(root, { recursive: true, force: true });
    }
  }, 600000);
});
