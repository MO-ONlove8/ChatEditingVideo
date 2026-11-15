import 'reflect-metadata';
import { randomUUID, randomInt } from 'node:crypto';
import path from 'node:path';
import { readFile, rm, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { eq, inArray } from 'drizzle-orm';
import {
  defaultSubtitleStyle,
  defaultTextStyle,
  ElementEditSchema,
  type EditorState,
  type MediaAsset,
} from '@cev/shared';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/bootstrap.js';
import { loadEnv } from '../../src/config/env.js';
import { DB, type Database } from '../../src/database/database.module.js';
import { users, loginCodes, mediaAssets, timelines, editJobs } from '../../src/database/schema.js';
import { ProjectsService } from '../../src/projects/projects.service.js';
import { StorageService } from '../../src/storage/storage.service.js';
import { MediaTools } from '../../src/media/media-tools.service.js';
import { LayoutService } from '../../src/composition/layout.service.js';
import { AuxiliaryTools } from '../../src/composition/auxiliary-tools.service.js';
import { videoFixture } from '../support/video.js';

describe('D1 complete composition and operation protocol', () => {
  const root = path.resolve('storage', 'd1-' + randomUUID()),
    phone = '198' + randomInt(10000000, 99999999);
  let app: INestApplication,
    db: Database,
    storage: StorageService,
    tools: MediaTools,
    token: string,
    owner: string,
    projectId: string,
    videoId: string;
  const auth = () => ({ Authorization: 'Bearer ' + token });
  const state = async () =>
    (
      await request(app.getHttpServer())
        .get('/api/projects/' + projectId + '/editor-state')
        .set(auth())
        .expect(200)
    ).body as EditorState;
  const upload = async (kind: string, name: string, data: Buffer) => {
    const id = randomUUID();
    await request(app.getHttpServer())
      .post('/api/uploads')
      .set(auth())
      .send({
        contextId: randomUUID(),
        projectId,
        files: [{ id, fileName: name, sizeBytes: data.length, kind }],
      })
      .expect(201);
    const result = await request(app.getHttpServer())
      .put('/api/uploads/' + id + '/content')
      .set(auth())
      .set('Content-Type', 'application/octet-stream')
      .send(data)
      .expect(200);
    return result.body.asset as MediaAsset;
  };
  const propose = async (patch: Record<string, unknown>, replace?: string) => {
    const input = ElementEditSchema.parse({
      requestId: randomUUID(),
      expectedRevision: (await state()).timeline.revision,
      ...patch,
    });
    const response = await request(app.getHttpServer())
      .post(
        '/api/projects/' + projectId + '/proposals' + (replace ? '/' + replace + '/update' : ''),
      )
      .set(auth())
      .send(input)
      .expect(201);
    return { input, state: response.body as EditorState };
  };
  const prepare = async (id: string) => {
    let s = await state();
    await expect
      .poll(
        async () => {
          s = await state();
          const c = s.turns.find((t) => t.proposal?.id === id)!.proposal!;
          if (c.previewStatus === 'failed') throw new Error(c.previewError ?? '候选失败');
          return c.previewStatus;
        },
        { timeout: 25000, interval: 100 },
      )
      .toBe('ready');
    return s;
  };
  const confirm = async (s: EditorState) => {
    const turn = s.turns.find((t) => t.status === 'pending')!,
      card = turn.proposal!;
    return (
      await request(app.getHttpServer())
        .post('/api/projects/' + projectId + '/proposals/' + card.id + '/confirm')
        .set(auth())
        .send({
          requestId: turn.requestId,
          contentHash: card.contentHash,
          generation: card.generation,
        })
        .expect(201)
    ).body as EditorState;
  };
  beforeAll(async () => {
    const env = {
      ...loadEnv(),
      NODE_ENV: 'test' as const,
      STORAGE_DIR: root,
      QUEUE_PREFIX: 'd1-' + randomUUID(),
    };
    const module = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] }).compile();
    app = configureApp(module.createNestApplication(), env);
    await app.listen(0, '127.0.0.1');
    db = app.get(DB);
    storage = app.get(StorageService);
    tools = app.get(MediaTools);
    await request(app.getHttpServer()).post('/api/auth/code').send({ phone }).expect(200);
    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ phone, code: '123456' })
      .expect(200);
    token = login.body.token;
    owner = login.body.user.id;
    projectId = (
      await request(app.getHttpServer())
        .post('/api/projects')
        .set(auth())
        .send({ name: 'D1真实样例' })
        .expect(201)
    ).body.id;
    const data = await readFile(await videoFixture(path.join(root, 'fixture.mp4'), [], 30, 3));
    const video = await upload('video', 'source.mp4', data);
    videoId = video.id;
    await vi.waitFor(
      async () => {
        const [a] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, videoId));
        expect(a?.status).toBe('ready');
      },
      { timeout: 20000, interval: 100 },
    );
    await db.insert(timelines).values({
      projectId,
      state: {
        revision: 1,
        fps: 30,
        canvas: { width: 320, height: 180 },
        clips: [{ id: randomUUID(), source: videoId, generation: 1, startFrame: 0, endFrame: 89 }],
      },
    });
  }, 60000);
  afterAll(async () => {
    try {
      if (projectId) await app.get(ProjectsService).remove(projectId, owner);
      if (db) {
        await db.delete(loginCodes).where(eq(loginCodes.phone, phone));
        await db.delete(users).where(eq(users.phone, phone));
      }
    } finally {
      await app?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  it('uses archived Chinese glyphs, rejects missing glyphs, lines and canvas overflow', () => {
    const layout = app.get(LayoutService),
      canvas = { width: 1920, height: 1080 };
    expect(
      layout.text('中文字幕与 English', defaultSubtitleStyle(), canvas, 2).png.length,
    ).toBeGreaterThan(100);
    expect(() => layout.text('A\nB\nC', defaultSubtitleStyle(), canvas, 2)).toThrow('最多2行');
    expect(() =>
      layout.text(String.fromCodePoint(0x10ffff), defaultTextStyle(), canvas, 4),
    ).toThrow('缺少字符');
    expect(() => layout.text('标题', { ...defaultTextStyle(), x: 0 }, canvas, 4)).toThrow(
      '超出画布',
    );
  });
  it('validates actual image type, alpha, size and UTF8 rather than trusting file extensions', async () => {
    const aux = app.get(AuxiliaryTools),
      png = await sharp({
        create: {
          width: 32,
          height: 16,
          channels: 4,
          background: { r: 255, g: 255, b: 255, alpha: 0.5 },
        },
      })
        .png()
        .toBuffer();
    const a = await upload('image', 'logo.png', png);
    expect(a.auxiliary).toMatchObject({ width: 32, height: 16 });
    expect((await sharp(storage.resolve(a.auxiliary!.workingKey!)).metadata()).hasAlpha).toBe(true);
    const file = storage.resolve('bad.png');
    await writeFile(file, png);
    await expect(aux.prepare(file, 'image', 'bad.jpg', 'invalid/type')).rejects.toThrow('实际格式');
    await writeFile(
      file,
      await sharp({ create: { width: 8193, height: 1, channels: 3, background: 'white' } })
        .png()
        .toBuffer(),
    );
    await expect(aux.prepare(file, 'image', 'bad.png', 'invalid/edge')).rejects.toThrow('8192');
    await writeFile(
      file,
      await sharp({ create: { width: 8192, height: 1, channels: 3, background: 'white' } })
        .png()
        .toBuffer(),
    );
    expect((await aux.prepare(file, 'image', 'edge.png', 'valid/edge')).width).toBe(8192);
    const oriented = storage.resolve('orientation.jpg');
    await writeFile(
      oriented,
      await sharp({ create: { width: 32, height: 16, channels: 3, background: 'white' } })
        .jpeg()
        .withMetadata({ orientation: 6 })
        .toBuffer(),
    );
    expect(
      await aux.prepare(oriented, 'image', 'orientation.jpg', 'valid/orientation'),
    ).toMatchObject({ width: 16, height: 32 });
    const animated = storage.resolve('animated.png');
    await tools.run(tools.env.FFMPEG_PATH, [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=16x16:rate=2:duration=1',
      '-plays',
      '0',
      '-f',
      'apng',
      animated,
    ]);
    await expect(
      aux.prepare(animated, 'image', 'animated.png', 'invalid/animation'),
    ).rejects.toThrow('APNG');
    await writeFile(file, Buffer.from([0xff, 0xfe, 0x00]));
    await expect(aux.prepare(file, 'srt', 'bad.srt', 'invalid/utf')).rejects.toThrow();
  });
  it('fences candidate generations, freezes identity, checks unknown results and commits only once', async () => {
    const proposed = await propose({
        kind: 'subtitle',
        text: '你好，世界',
        startFrame: 0,
        endFrame: 29,
      }),
      card = proposed.state.turns.at(-1)!.proposal!;
    const early = await request(app.getHttpServer())
      .post('/api/projects/' + projectId + '/proposals/' + card.id + '/confirm')
      .set(auth())
      .send({
        requestId: proposed.input.requestId,
        contentHash: 'wrong',
        generation: card.generation,
      });
    expect(early.status).toBe(409);
    const updated = await propose({ ...proposed.input, text: '更新后的字幕' }, card.id),
      next = updated.state.turns.at(-1)!.proposal!;
    expect(next.generation).toBe(card.generation + 1);
    if (next.operation.kind !== 'subtitle' || card.operation.kind !== 'subtitle')
      throw new Error('类型不符');
    expect(next.operation.item.id).toBe(card.operation.item.id);
    expect(next.operation.item.number).toBe(card.operation.item.number);
    const ready = await prepare(card.id),
      saved = await confirm(ready);
    expect(saved.timeline.revision).toBe(2);
    expect(saved.timeline.packaging?.subtitles).toHaveLength(1);
    const duplicate = await confirm(ready);
    expect(duplicate.timeline.revision).toBe(2);
    const status = await request(app.getHttpServer())
      .get('/api/projects/' + projectId + '/operations/' + proposed.input.requestId)
      .set(auth())
      .expect(200);
    expect(status.body).toMatchObject({ status: 'committed', revision: 2 });
    await request(app.getHttpServer())
      .post('/api/projects/' + projectId + '/proposals')
      .set(auth())
      .send({ ...proposed.input, text: '不同参数' })
      .expect(400);
  }, 60000);
  it('imports SRT atomically and keeps parsed text independent of its source file', async () => {
    const source = await upload(
      'srt',
      '中文.srt',
      Buffer.from(
        '\uFEFF8\r\n00:00:01,000 --> 00:00:02,001\r\n字幕一\r\n\r\n2\r\n00:00:02,001 --> 00:00:03,000\r\n字幕二',
      ),
    );
    const proposed = await propose({ kind: 'subtitle-replace', assetId: source.id });
    expect(proposed.state.turns.at(-1)!.proposal!.details.join(' ')).toContain('原条目');
    await request(app.getHttpServer())
      .delete('/api/media/' + source.id)
      .set(auth())
      .expect(409);
    const saved = await confirm(await prepare(proposed.state.turns.at(-1)!.proposal!.id));
    expect(saved.timeline.packaging?.subtitles.map((s) => [s.startFrame, s.endFrame])).toEqual([
      [30, 59],
      [60, 89],
    ]);
    await request(app.getHttpServer())
      .delete('/api/media/' + source.id)
      .set(auth())
      .expect(204);
    expect((await state()).timeline.packaging?.subtitles).toHaveLength(2);
    const bad = await upload(
      'srt',
      '越界.srt',
      Buffer.from('1\n00:00:03,000 --> 00:00:04,000\n越界'),
    );
    await request(app.getHttpServer())
      .post('/api/projects/' + projectId + '/proposals')
      .set(auth())
      .send({
        kind: 'subtitle-replace',
        assetId: bad.id,
        requestId: randomUUID(),
        expectedRevision: saved.timeline.revision,
      })
      .expect(400);
    expect((await state()).timeline.revision).toBe(saved.timeline.revision);
  }, 60000);
  it('prepares Chinese, transparent logo and mixed audio, exports exact event frames and a distinct SRT job', async () => {
    const logo = await upload(
      'image',
      'red.png',
      await sharp({
        create: {
          width: 32,
          height: 18,
          channels: 4,
          background: { r: 255, g: 0, b: 0, alpha: 1 },
        },
      })
        .png()
        .toBuffer(),
    );
    let s = (
      await propose({ kind: 'image', assetId: logo.id, startFrame: 10, endFrame: 10, width: 20 })
    ).state;
    s = await confirm(await prepare(s.turns.at(-1)!.proposal!.id));
    const wav = storage.resolve('pulse.wav');
    await tools.run(tools.env.FFMPEG_PATH, [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'aevalsrc=if(eq(n\\,1600)\\,0.9\\,0):s=48000:d=1',
      '-c:a',
      'pcm_s16le',
      wav,
    ]);
    const aud = await upload('audio', 'pulse.wav', await readFile(wav));
    expect(aud.auxiliary?.frames).toBe(30);
    expect(aud.auxiliary?.audioTrackIndex).toBe(0);
    s = (
      await propose({
        kind: 'audio',
        assetId: aud.id,
        role: 'bgm',
        sourceStart: 0,
        sourceEnd: 29,
        range: { mode: 'whole' },
        settings: { volume: 200 },
        loop: true,
      })
    ).state;
    s = await confirm(await prepare(s.turns.at(-1)!.proposal!.id));
    await request(app.getHttpServer())
      .delete('/api/media/' + logo.id)
      .set(auth())
      .expect(409);
    await request(app.getHttpServer())
      .delete('/api/media/' + aud.id)
      .set(auth())
      .expect(409);
    const create = async (outputType: string) =>
      (
        await request(app.getHttpServer())
          .post('/api/jobs')
          .set(auth())
          .send({
            projectId,
            expectedRevision: s.timeline.revision,
            requestId: randomUUID(),
            outputType,
          })
          .expect(201)
      ).body;
    const mp4 = await create('mp4'),
      srt = await create('srt');
    expect(srt.id).not.toBe(mp4.id);
    expect((await create('mp4')).id).toBe(mp4.id);
    await expect
      .poll(
        async () => {
          const rows = await db
            .select()
            .from(editJobs)
            .where(inArray(editJobs.id, [mp4.id, srt.id]));
          const failed = rows.find((r) => r.status === 'failed');
          if (failed) throw new Error(failed.error ?? '导出失败');
          return rows.every((r) => r.status === 'succeeded');
        },
        { timeout: 25000, interval: 100 },
      )
      .toBe(true);
    const [job] = await db.select().from(editJobs).where(eq(editJobs.id, mp4.id));
    expect(job!.plan.version).toBe(4);
    const info = await tools.probe(storage.resolve(job!.outputKey!), true);
    expect(info).toMatchObject({
      frameCount: 90,
      width: 320,
      height: 180,
      hasAudio: true,
      sampleRate: 48000,
      channels: 2,
    });
    await tools.run(tools.env.FFMPEG_PATH, [
      '-v',
      'error',
      '-y',
      '-i',
      storage.resolve(job!.outputKey!),
      '-vf',
      'select=between(n\\,9\\,11)',
      '-fps_mode',
      'passthrough',
      storage.resolve('frame-%02d.png'),
    ]);
    const pixel = async (i: number) => {
      const { data, info } = await sharp(storage.resolve('frame-0' + i + '.png'))
        .raw()
        .toBuffer({ resolveWithObject: true });
      const pos = (90 * info.width + 160) * info.channels;
      return [...data.subarray(pos, pos + 3)];
    };
    const event = await pixel(2);
    expect(event[0]).toBeGreaterThan(220);
    expect(event[1]).toBeLessThan(40);
    expect(event[2]).toBeLessThan(40);
    expect(await pixel(1)).not.toEqual(event);
    expect(await pixel(3)).not.toEqual(event);
    const audio = storage.resolve('decoded.f32');
    await tools.run(tools.env.FFMPEG_PATH, [
      '-v',
      'error',
      '-y',
      '-i',
      storage.resolve(job!.outputKey!),
      '-map',
      '0:a:0',
      '-f',
      'f32le',
      '-c:a',
      'pcm_f32le',
      audio,
    ]);
    const samples = await readFile(audio);
    let peak = 0,
      index = 0;
    for (let i = 0; i < Math.min(samples.length, 48000 * 8); i += 8) {
      const v = Math.abs(samples.readFloatLE(i));
      if (v > peak) {
        peak = v;
        index = i / 8;
      }
    }
    expect(peak).toBeLessThanOrEqual(1);
    expect(Math.abs(index - 1600)).toBeLessThanOrEqual(1600);
    const output = await request(app.getHttpServer())
      .get('/api/jobs/' + srt.id + '/content')
      .set(auth())
      .expect(200);
    expect(output.headers['content-type']).toContain('application/x-subrip');
    expect(output.text ?? output.body.toString()).toContain('字幕一');
    const manifest = s.composition!.manifest!;
    await request(app.getHttpServer())
      .get('/api/projects/' + projectId + '/composition-resource')
      .query({ key: manifest.audioKey })
      .set(auth())
      .set('Range', 'bytes=0-99')
      .expect(206);
    await request(app.getHttpServer())
      .get('/api/projects/' + projectId + '/composition-resource')
      .query({ key: '../outside' })
      .set(auth())
      .expect(400);
  }, 60000);
  it('enforces byte and concurrent last-slot limits without allocating oversized files', async () => {
    const isolated = (
      await request(app.getHttpServer())
        .post('/api/projects')
        .set(auth())
        .send({ name: '素材上限测试' })
        .expect(201)
    ).body.id as string;
    try {
      const claim = async (kind: string, sizeBytes: number) =>
        (
          await request(app.getHttpServer())
            .post('/api/uploads')
            .set(auth())
            .send({
              contextId: randomUUID(),
              projectId: isolated,
              files: [
                {
                  id: randomUUID(),
                  kind,
                  fileName:
                    kind === 'image' ? 'logo.png' : kind === 'audio' ? 'audio.wav' : 'captions.srt',
                  sizeBytes,
                },
              ],
            })
        ).status;
      for (const [kind, limit] of [
        ['image', 20 * 1024 ** 2],
        ['audio', 200 * 1024 ** 2],
        ['srt', 1024 ** 2],
      ] as const) {
        expect(await claim(kind, 0)).toBe(400);
        expect(await claim(kind, limit + 1)).toBe(400);
        expect(await claim(kind, limit)).toBe(201);
      }
      for (let i = 0; i < 18; i++) expect(await claim('image', 1)).toBe(201);
      const race = await Promise.all([claim('image', 1), claim('image', 1)]);
      expect(race.filter((s) => s === 201)).toHaveLength(1);
      expect(race.filter((s) => s === 400 || s === 409)).toHaveLength(1);
    } finally {
      await app.get(ProjectsService).remove(isolated, owner);
    }
  });
});
