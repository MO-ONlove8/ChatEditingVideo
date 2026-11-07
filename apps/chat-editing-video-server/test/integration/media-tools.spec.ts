import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MediaTools } from '../../src/media/media-tools.service.js';
import { loadEnv } from '../../src/config/env.js';
import { execute, videoFixture } from '../support/video.js';

describe('native FFmpeg media processing', () => {
  const root = path.resolve('storage', `tools-${randomUUID()}`);
  const env = loadEnv();
  const tools = new MediaTools(env);
  const signal = new AbortController().signal;
  const run = (args: string[]) =>
    execute(env.FFMPEG_PATH, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
      windowsHide: true,
    });
  beforeAll(async () => {
    await mkdir(root, { recursive: true });
    await tools.check();
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  for (const rate of [24, 30, 60])
    it(`normalizes ${rate} fps to CFR 30 with silent stereo AAC`, async () => {
      const source = await videoFixture(path.join(root, `source-${rate}.mp4`), [], rate);
      const info = await tools.probe(source);
      const output = path.join(root, `edit-${rate}.mp4`);
      await tools.normalize(source, output, info, signal, () => {});
      const result = await tools.probe(output, true);
      expect(result).toMatchObject({
        width: 320,
        height: 180,
        hasAudio: true,
        rotation: 0,
        hdr: false,
        frameCount: 36,
      });
      const raw = JSON.parse(
        await tools.run(env.FFPROBE_PATH, ['-v', 'error', '-show_streams', '-of', 'json', output]),
      );
      expect(raw.streams[0]).toMatchObject({
        r_frame_rate: '30/1',
        avg_frame_rate: '30/1',
        pix_fmt: 'yuv420p',
      });
      expect(raw.streams[1]).toMatchObject({
        codec_name: 'aac',
        sample_rate: '48000',
        channels: 2,
      });
    });

  it('accepts MOV, applies rotation and creates one representative thumbnail per real second', async () => {
    const original = await videoFixture(path.join(root, 'source.mov'), [], 30, 2.2);
    const rotated = path.join(root, 'rotated.mov');
    await run(['-display_rotation:v:0', '90', '-i', original, '-c', 'copy', rotated]);
    const info = await tools.probe(rotated);
    expect(info.width).toBe(180);
    expect(info.height).toBe(320);
    const output = path.join(root, 'rotated-edit.mp4');
    await tools.normalize(rotated, output, info, signal, () => {});
    const normalized = await tools.probe(output, true);
    expect(normalized).toMatchObject({ width: 180, height: 320, rotation: 0, frameCount: 66 });
    const sprites = path.join(root, 'sprites');
    await tools.thumbnails(output, sprites, normalized.frameCount!, signal);
    expect(await readdir(sprites)).toEqual(['thumb-0.jpg']);
    expect((await readFile(path.join(sprites, 'thumb-0.jpg'))).length).toBeGreaterThan(100);
  });

  it('handles variable timestamps, anamorphic pixels, audio and HDR metadata', async () => {
    const source = path.join(root, 'hdr-vfr.mp4');
    await run([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x180:rate=60:duration=1.2',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=44100:duration=1.2',
      '-vf',
      'select=not(mod(n\\,3)),setsar=2/1',
      '-fps_mode',
      'vfr',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p10le',
      '-x264-params',
      'colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc',
      '-c:a',
      'aac',
      '-threads',
      '1',
      source,
    ]);
    const info = await tools.probe(source);
    expect(info).toMatchObject({ hdr: true, hasAudio: true, width: 640 });
    const output = path.join(root, 'hdr-edit.mp4');
    await tools.normalize(source, output, info, signal, () => {});
    expect(await tools.probe(output, true)).toMatchObject({
      hdr: false,
      hasAudio: true,
      width: 640,
      height: 180,
    });
  });

  it('rejects corrupted files with a useful validation error and honors cancellation', async () => {
    const file = path.join(root, 'broken.mp4');
    await writeFile(file, 'not a video');
    await expect(tools.probe(file)).rejects.toThrow('无法读取视频');
    const abort = new AbortController();
    abort.abort();
    await expect(tools.run(env.FFMPEG_PATH, ['-version'], abort.signal)).rejects.toThrow('取消');
  });
});
