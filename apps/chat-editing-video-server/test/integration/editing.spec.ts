import 'reflect-metadata';
import { randomUUID, randomInt } from 'node:crypto';
import path from 'node:path';
import { readFile, rm } from 'node:fs/promises';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { eq, inArray } from 'drizzle-orm';
import { createSseParser, type EditingIntent, type EditorState } from '@cev/shared';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/bootstrap.js';
import { loadEnv } from '../../src/config/env.js';
import { LlmService } from '../../src/llm/llm.service.js';
import { DB, type Database } from '../../src/database/database.module.js';
import {
  chatTurns,
  editJobs,
  loginCodes,
  mediaAssets,
  projects,
  users,
} from '../../src/database/schema.js';
import { ProjectsService } from '../../src/projects/projects.service.js';
import { JobsService } from '../../src/jobs/jobs.service.js';
import { EditingService } from '../../src/editing/editing.service.js';
import { FfmpegServerExecutor } from '../../src/jobs/executors/ffmpeg-server.executor.js';
import { MediaTools } from '../../src/media/media-tools.service.js';
import { StorageService } from '../../src/storage/storage.service.js';
import { execute, videoFixture } from '../support/video.js';

describe('persisted editing and real rendering', () => {
  let app: INestApplication,
    db: Database,
    video: Buffer,
    token: string,
    owner: string,
    otherToken: string;
  const root = path.resolve('storage', `editing-${randomUUID()}`),
    phones: string[] = [],
    ids: string[] = [];
  const understand = vi.fn();
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const intent = (overrides: Partial<EditingIntent> = {}): EditingIntent => ({
    kind: 'add',
    sourceNumber: 1,
    startTime: '00:05:00',
    endTime: '00:08:00',
    destination: 'end',
    targetNumber: null,
    message: '',
    ...overrides,
  });
  const state = async (id: string) =>
    (
      await request(app.getHttpServer())
        .get(`/api/projects/${id}/editor-state`)
        .set(auth())
        .expect(200)
    ).body as EditorState;
  const send = async (
    id: string,
    value: EditingIntent,
    requestId = randomUUID(),
    expectedRevision?: number,
  ) => {
    understand.mockResolvedValueOnce(value);
    const response = await request(app.getHttpServer())
      .post(`/api/projects/${id}/chat/stream`)
      .set(auth())
      .send({
        requestId,
        text: JSON.stringify(value),
        expectedRevision: expectedRevision ?? (await state(id)).timeline.revision,
      })
      .expect(201);
    let result: EditorState | undefined;
    const parser = createSseParser((m) => {
      const e = JSON.parse(m.data);
      if (e.type === 'state') result = e.state;
    });
    parser.push(response.text);
    return result!;
  };
  const confirm = async (id: string, s: EditorState) =>
    (
      await request(app.getHttpServer())
        .post(`/api/projects/${id}/proposals/${s.turns.at(-1)!.proposal!.id}/confirm`)
        .set(auth())
        .expect(201)
    ).body as EditorState;
  const create = async () => {
    const project = (
      await request(app.getHttpServer())
        .post('/api/projects')
        .set(auth())
        .send({ name: 'editing integration' })
        .expect(201)
    ).body;
    ids.push(project.id);
    const asset = (
      await request(app.getHttpServer())
        .post(`/api/projects/${project.id}/media`)
        .set(auth())
        .attach('file', video, { filename: 'source.mp4', contentType: 'video/mp4' })
        .expect(201)
    ).body;
    await expect
      .poll(
        async () => {
          const [a] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, asset.id));
          return a?.status;
        },
        { timeout: 25000, interval: 100 },
      )
      .toBe('ready');
    return { id: project.id as string, assetId: asset.id as string };
  };
  beforeAll(async () => {
    const env = {
      ...loadEnv(),
      NODE_ENV: 'test' as const,
      STORAGE_DIR: root,
      QUEUE_PREFIX: `editing-${randomUUID()}`,
    };
    video = await readFile(await videoFixture(path.join(root, 'fixture.mp4'), [], 30, 10));
    const module = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] })
      .overrideProvider(LlmService)
      .useValue({ understand, ping: async () => {} })
      .compile();
    app = configureApp(module.createNestApplication(), env);
    await app.listen(0, '127.0.0.1');
    db = app.get(DB);
    for (let i = 0; i < 2; i++) {
      const phone = `198${randomInt(10000000, 99999999)}`;
      phones.push(phone);
      await request(app.getHttpServer()).post('/api/auth/code').send({ phone }).expect(200);
      const response = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ phone, code: '123456' })
        .expect(200);
      if (i === 0) {
        token = response.body.token;
        owner = response.body.user.id;
      } else otherToken = response.body.token;
    }
  }, 30000);
  afterAll(async () => {
    try {
      for (const id of ids)
        await app
          .get(ProjectsService)
          .remove(id, owner)
          .catch(() => {});
      await db.delete(projects).where(inArray(projects.id, ids));
      await db.delete(loginCodes).where(inArray(loginCodes.phone, phones));
      await db.delete(users).where(inArray(users.phone, phones));
    } finally {
      await app?.close();
      if (root.startsWith(path.resolve('storage') + path.sep))
        await rm(root, { recursive: true, force: true });
    }
  });
  it('persists pending cards, confirms 91 inclusive frames exactly once, and preserves chat', async () => {
    const { id } = await create();
    const pending = await send(id, intent());
    expect(pending.timeline.clips).toHaveLength(0);
    expect((await state(id)).turns[0]!.proposal?.status).toBe('pending');
    const saved = await confirm(id, pending);
    expect(saved.timeline.clips[0]).toMatchObject({ startFrame: 150, endFrame: 240 });
    expect(saved.timeline.revision).toBe(1);
    expect(saved.project.durationFrames).toBe(91);
    const duplicate = await confirm(id, pending);
    expect(duplicate.timeline).toEqual(saved.timeline);
    expect(duplicate.turns[0]!.proposal?.status).toBe('confirmed');
    await request(app.getHttpServer())
      .get(`/api/projects/${id}/editor-state`)
      .set({ Authorization: `Bearer ${otherToken}` })
      .expect(404);
    await request(app.getHttpServer())
      .post(`/api/projects/${id}/proposals/${pending.turns[0]!.proposal!.id}/confirm`)
      .set({ Authorization: `Bearer ${otherToken}` })
      .expect(404);
  });
  it('copies independently, moves stable IDs, invalidates pending cards on deletion, and retains canvas', async () => {
    const { id } = await create();
    let saved = await confirm(id, await send(id, intent()));
    const first = saved.timeline.clips[0]!.id;
    saved = await confirm(
      id,
      await send(id, intent({ kind: 'copy', startTime: null, endTime: null })),
    );
    const copy = saved.timeline.clips[1]!.id;
    expect(copy).not.toBe(first);
    saved = await confirm(
      id,
      await send(
        id,
        intent({
          kind: 'move',
          sourceNumber: 2,
          startTime: null,
          endTime: null,
          destination: 'before',
          targetNumber: 1,
        }),
      ),
    );
    expect(saved.timeline.clips.map((c) => c.id)).toEqual([copy, first]);
    const pending = await send(
      id,
      intent({ startTime: '00:00:00', endTime: '00:00:00', destination: 'after', targetNumber: 1 }),
    );
    const requestId = randomUUID();
    await request(app.getHttpServer())
      .delete(`/api/projects/${id}/clips/${copy}`)
      .set(auth())
      .send({ requestId, expectedRevision: saved.timeline.revision })
      .expect(200);
    let current = await state(id);
    expect(current.turns.at(-1)!.proposal?.status).toBe('invalid');
    expect(current.timeline.clips.map((c) => c.id)).toEqual([first]);
    await request(app.getHttpServer())
      .delete(`/api/projects/${id}/clips/${copy}`)
      .set(auth())
      .send({ requestId, expectedRevision: saved.timeline.revision })
      .expect(200);
    const stale = await request(app.getHttpServer())
      .post(`/api/projects/${id}/proposals/${pending.turns.at(-1)!.proposal!.id}/confirm`)
      .set(auth())
      .expect(409);
    expect(stale.body.code).toBe('EDIT_PROPOSAL_INVALID');
    await request(app.getHttpServer())
      .delete(`/api/projects/${id}/clips/${first}`)
      .set(auth())
      .send({ requestId: randomUUID(), expectedRevision: current.timeline.revision })
      .expect(200);
    current = await state(id);
    expect(current.timeline.canvas).toEqual({ width: 1920, height: 1080 });
    expect(current.project.hasMainVideo).toBe(false);
  });
  it('rejects invalid ranges, clarifies ambiguous messages, and retries a failed turn without duplication', async () => {
    const { id } = await create();
    let result = await send(id, intent({ endTime: '00:11:00' }));
    expect(result.turns[0]!.proposal).toBeNull();
    expect(result.timeline.revision).toBe(0);
    result = await send(id, intent({ kind: 'multiple' }));
    expect(result.turns.at(-1)!.reply).toContain('逐条');
    const requestId = randomUUID();
    understand.mockRejectedValueOnce(new Error('offline'));
    const response = await request(app.getHttpServer())
      .post(`/api/projects/${id}/chat/stream`)
      .set(auth())
      .send({ requestId, text: 'retry same instruction', expectedRevision: 0 })
      .expect(201);
    expect(response.text).toContain('failed');
    understand.mockResolvedValueOnce(intent());
    await request(app.getHttpServer())
      .post(`/api/projects/${id}/chat/stream`)
      .set(auth())
      .send({ requestId, text: 'retry same instruction', expectedRevision: 0 })
      .expect(201);
    result = await state(id);
    expect(result.turns.filter((t) => t.requestId === requestId)).toHaveLength(1);
    expect(result.turns.at(-1)!.status).toBe('pending');
    await request(app.getHttpServer())
      .post(`/api/projects/${id}/proposals/${result.turns.at(-1)!.proposal!.id}/cancel`)
      .set(auth())
      .expect(201);
    expect((await state(id)).timeline.clips).toHaveLength(0);
  });
  it('confirms insertion before and after current numbered clips, then copies beside its original', async () => {
    const { id } = await create();
    let saved = await confirm(id, await send(id, intent()));
    const first = saved.timeline.clips[0]!.id;
    saved = await confirm(
      id,
      await send(
        id,
        intent({
          startTime: '00:00:00',
          endTime: '00:00:00',
          destination: 'before',
          targetNumber: 1,
        }),
      ),
    );
    const inserted = saved.timeline.clips[0]!.id;
    saved = await confirm(
      id,
      await send(
        id,
        intent({
          startTime: '00:09:29',
          endTime: '00:09:29',
          destination: 'after',
          targetNumber: 1,
        }),
      ),
    );
    const after = saved.timeline.clips[1]!.id;
    expect(saved.timeline.clips.map((c) => c.id)).toEqual([inserted, after, first]);
    saved = await confirm(
      id,
      await send(
        id,
        intent({
          kind: 'copy',
          sourceNumber: 1,
          startTime: null,
          endTime: null,
          destination: 'after',
          targetNumber: 1,
        }),
      ),
    );
    expect(saved.timeline.clips[0]!.id).toBe(inserted);
    expect(saved.timeline.clips[1]!.id).not.toBe(inserted);
    expect(saved.timeline.clips[2]!.id).toBe(after);
    expect(saved.timeline.clips[3]!.id).toBe(first);
  });
  it('recovers expired understanding and refuses a second active instruction', async () => {
    const { id } = await create();
    await send(id, intent());
    const result = await send(id, intent());
    expect(result).toBeUndefined();
    understand.mockReset();
    const pending = (await state(id)).turns[0]!.proposal!;
    await request(app.getHttpServer())
      .post(`/api/projects/${id}/proposals/${pending.id}/cancel`)
      .set(auth())
      .expect(201);
    await db.insert(chatTurns).values({
      projectId: id,
      requestId: randomUUID(),
      text: 'interrupted',
      baseRevision: 0,
      deadline: new Date(Date.now() - 1000),
    });
    expect((await state(id)).turns.at(-1)!.status).toBe('failed');
  });
  it('paginates chat turns with identical timestamps without loss or duplicates', async () => {
    const { id } = await create(),
      createdAt = new Date();
    await db.insert(chatTurns).values(
      Array.from({ length: 65 }, (_, i) => ({
        projectId: id,
        requestId: randomUUID(),
        text: `message ${i}`,
        status: 'done',
        baseRevision: 0,
        deadline: new Date(),
        createdAt,
      })),
    );
    const first = await state(id);
    expect(first.turns).toHaveLength(30);
    const second = (
      await request(app.getHttpServer())
        .get(`/api/projects/${id}/chat?before=${first.nextCursor}`)
        .set(auth())
        .expect(200)
    ).body;
    const third = (
      await request(app.getHttpServer())
        .get(`/api/projects/${id}/chat?before=${second.nextCursor}`)
        .set(auth())
        .expect(200)
    ).body;
    expect(second.turns).toHaveLength(30);
    expect(third.turns).toHaveLength(5);
    expect(new Set([...first.turns, ...second.turns, ...third.turns].map((t) => t.id)).size).toBe(
      65,
    );
  });
  it.each([false, true])(
    'fences a late model %s and restores a retried old turn in the recent page',
    async (reject) => {
      const { id } = await create();
      let finishOld!: () => void;
      let finishNew!: () => void;
      understand.mockImplementationOnce(
        () =>
          new Promise<EditingIntent>((resolve, fail) => {
            finishOld = () => (reject ? fail(new Error('late failure')) : resolve(intent()));
          }),
      );
      const requestId = randomUUID();
      const input = { requestId, text: 'retry old instruction', expectedRevision: 0 };
      const service = app.get(EditingService);
      const first = service.instruct(id, owner, input);
      await expect.poll(() => Boolean(finishOld)).toBe(true);
      await db
        .update(chatTurns)
        .set({ deadline: new Date(0), createdAt: new Date(0) })
        .where(eq(chatTurns.requestId, requestId));
      await state(id);
      await db.insert(chatTurns).values(
        Array.from({ length: 31 }, () => ({
          projectId: id,
          requestId: randomUUID(),
          text: 'newer historical message',
          reply: 'done',
          status: 'done',
          baseRevision: 0,
          deadline: new Date(),
        })),
      );
      understand.mockImplementationOnce(
        () =>
          new Promise<EditingIntent>((resolve) => {
            finishNew = () => resolve(intent());
          }),
      );
      const second = service.instruct(id, owner, input);
      await expect.poll(() => Boolean(finishNew)).toBe(true);
      finishOld();
      await first;
      expect((await state(id)).turns.at(-1)!.status).toBe('understanding');
      finishNew();
      const result = await second;
      expect(result.turns.at(-1)!.requestId).toBe(requestId);
      expect(result.turns.at(-1)!.proposal?.status).toBe('pending');
    },
  );
  it('renders real H264 MP4, serves protected ranges and session-bound browser downloads', async () => {
    const { id } = await create();
    const saved = await confirm(id, await send(id, intent()));
    const input = {
      projectId: id,
      expectedRevision: saved.timeline.revision,
      requestId: randomUUID(),
    };
    const job = (
      await request(app.getHttpServer()).post('/api/jobs').set(auth()).send(input).expect(201)
    ).body;
    expect(
      (
        await request(app.getHttpServer())
          .post('/api/jobs')
          .set(auth())
          .send({ ...input, requestId: randomUUID() })
          .expect(201)
      ).body.id,
    ).toBe(job.id);
    await expect
      .poll(
        async () => {
          const j = await app.get(JobsService).get(job.id, owner);
          if (j.status === 'failed') throw new Error(j.error!);
          return j.status;
        },
        { timeout: 40000, interval: 200 },
      )
      .toBe('succeeded');
    const rendered = await app.get(JobsService).get(job.id, owner);
    const info = await app
      .get(MediaTools)
      .probe(app.get(StorageService).resolve(rendered.outputKey!), true);
    expect(info).toMatchObject({ frameCount: 91, width: 1920, height: 1080, hasAudio: true });
    await request(app.getHttpServer()).get(`/api/jobs/${job.id}/content`).expect(401);
    const range = await request(app.getHttpServer())
      .get(`/api/jobs/${job.id}/content`)
      .set(auth())
      .set('Range', 'bytes=0-31')
      .expect(206);
    expect(range.headers['content-length']).toBe('32');
    await request(app.getHttpServer())
      .get(`/api/jobs/${job.id}/content`)
      .set({ Authorization: `Bearer ${otherToken}` })
      .expect(404);
    const ticket = await request(app.getHttpServer())
      .post(`/api/jobs/${job.id}/download-ticket`)
      .set(auth())
      .expect(201);
    const cookie = (ticket.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
    await request(app.getHttpServer())
      .get(`/api/jobs/${job.id}/download`)
      .set('Cookie', cookie)
      .set('Range', 'bytes=0-31')
      .expect(206);
    const invalidTicket = await request(app.getHttpServer())
      .get(`/api/jobs/${job.id}/download`)
      .expect(404);
    expect(invalidTicket.body.code).toBe('DOWNLOAD_CREDENTIAL_INVALID');
  }, 60000);
  it('retains sources for failed snapshots after library deletion and releases them after retry', async () => {
    const { id, assetId } = await create();
    const saved = await confirm(
      id,
      await send(id, intent({ startTime: '00:00:10', endTime: '00:00:10' })),
    );
    const [asset] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, assetId));
    const plan = {
      version: 2 as const,
      revision: saved.timeline.revision,
      clips: saved.timeline.clips.map((c) => ({ ...c, sourceKey: asset!.normalizedKey! })),
      output: { container: 'mp4' as const, width: 1920, height: 1080 },
    };
    const [job] = await db
      .insert(editJobs)
      .values({ projectId: id, revision: 1, status: 'failed', plan, error: 'test interruption' })
      .returning();
    const referenced = await request(app.getHttpServer())
      .delete(`/api/media/${assetId}`)
      .set(auth())
      .expect(409);
    expect(referenced.body.code).toBe('MEDIA_REFERENCED');
    await request(app.getHttpServer())
      .delete(`/api/projects/${id}/clips/${saved.timeline.clips[0]!.id}`)
      .set(auth())
      .send({ requestId: randomUUID(), expectedRevision: 1 })
      .expect(200);
    await request(app.getHttpServer()).delete(`/api/media/${assetId}`).set(auth()).expect(204);
    expect(
      (await request(app.getHttpServer()).get(`/api/projects/${id}/media`).set(auth()).expect(200))
        .body,
    ).toHaveLength(0);
    expect(await app.get(StorageService).exists(asset!.normalizedKey!)).toBe(true);
    const retry = await request(app.getHttpServer())
      .post(`/api/jobs/${job!.id}/retry`)
      .set(auth())
      .expect(201);
    expect(retry.body.generation).toBe(2);
    await expect
      .poll(
        async () =>
          app
            .get(JobsService)
            .get(job!.id, owner)
            .then((j) => j.status),
        { timeout: 20000, interval: 100 },
      )
      .toBe('succeeded');
    await expect
      .poll(async () => app.get(StorageService).exists(asset!.normalizedKey!), { timeout: 5000 })
      .toBe(false);
    const rendered = await app.get(JobsService).get(job!.id, owner);
    expect(
      (await app.get(MediaTools).probe(app.get(StorageService).resolve(rendered.outputKey!), true))
        .frameCount,
    ).toBe(1);
  }, 40000);
  it('concatenates mixed aspect ratios with black padding and continuous audio, preserving exact frame boundaries', async () => {
    const storage = app.get(StorageService),
      tools = app.get(MediaTools),
      executor = app.get(FfmpegServerExecutor);
    const keys = ['fixtures/red.mp4', 'fixtures/blue.mp4'];
    await storage.write('fixtures/.keep', '');
    for (let i = 0; i < 2; i++)
      await tools.run(tools.env.FFMPEG_PATH, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        `color=c=${i ? 'blue' : 'red'}:s=${i ? '180x320' : '320x180'}:r=30:d=2`,
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=${i ? 880 : 440}:sample_rate=48000:duration=2`,
        '-c:v',
        'libx264',
        '-g',
        '30',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-ar',
        '48000',
        '-ac',
        '2',
        '-shortest',
        storage.resolve(keys[i]!),
      ]);
    const clips = [
      {
        id: randomUUID(),
        source: randomUUID(),
        generation: 1,
        sourceKey: keys[0]!,
        startFrame: 10,
        endFrame: 20,
      },
      {
        id: randomUUID(),
        source: randomUUID(),
        generation: 1,
        sourceKey: keys[1]!,
        startFrame: 30,
        endFrame: 59,
      },
    ];
    const result = await executor.execute({
      jobId: randomUUID(),
      plan: {
        version: 2,
        revision: 1,
        clips,
        output: { container: 'mp4', width: 320, height: 180 },
      },
    });
    const output = storage.resolve(result.output),
      info = await tools.probe(output, true);
    expect(info).toMatchObject({ frameCount: 41, width: 320, height: 180, hasAudio: true });
    const pixels = async (frame: number) => {
      const result = await execute(
        tools.env.FFMPEG_PATH,
        [
          '-v',
          'error',
          '-i',
          output,
          '-vf',
          `select=eq(n\\,${frame}),scale=16:9`,
          '-frames:v',
          '1',
          '-f',
          'rawvideo',
          '-pix_fmt',
          'rgb24',
          'pipe:1',
        ],
        { encoding: 'buffer', windowsHide: true },
      );
      return result.stdout;
    };
    for (const frame of [0, 10]) {
      const rgb = await pixels(frame);
      expect(rgb[0]).toBeGreaterThan(200);
      expect(rgb[2]).toBeLessThan(30);
    }
    for (const frame of [11, 40]) {
      const rgb = await pixels(frame);
      const center = (4 * 16 + 8) * 3;
      expect(rgb[center + 2]).toBeGreaterThan(200);
      expect(rgb[center]).toBeLessThan(30);
      expect(rgb[0]).toBeLessThan(10);
      expect(rgb[2]).toBeLessThan(10);
    }
    const decoded = await execute(
      tools.env.FFMPEG_PATH,
      ['-v', 'error', '-i', output, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1'],
      { encoding: 'buffer', windowsHide: true },
    );
    const samples = new Float32Array(
      decoded.stdout.buffer,
      decoded.stdout.byteOffset,
      Math.floor(decoded.stdout.byteLength / 4),
    );
    expect(samples.length).toBeGreaterThanOrEqual(41 * 1600);
    expect(samples.length).toBeLessThan(41 * 1600 + 1024);
    const rms = (begin: number, length: number) =>
      Math.sqrt(samples.slice(begin, begin + length).reduce((n, x) => n + x * x, 0) / length);
    expect(rms(1000, 2000)).toBeGreaterThan(0.03);
    expect(rms(11 * 1600 - 800, 1600)).toBeGreaterThan(0.03);
    expect(rms(40 * 1600, 800)).toBeGreaterThan(0.03);
  }, 30000);
  it('keeps a generation snapshot fixed while editing and requeues a lost worker execution', async () => {
    const { id, assetId } = await create();
    const saved = await confirm(
      id,
      await send(id, intent({ startTime: '00:00:00', endTime: '00:00:29' })),
    );
    const [asset] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, assetId));
    const plan = {
      version: 2 as const,
      revision: 1,
      clips: saved.timeline.clips.map((c) => ({ ...c, sourceKey: asset!.normalizedKey! })),
      output: { container: 'mp4' as const, width: 320, height: 180 },
    };
    const abandoned = randomUUID();
    const [job] = await db
      .insert(editJobs)
      .values({
        projectId: id,
        revision: 1,
        status: 'running',
        plan,
        queuePrefix: app.get(MediaTools).env.QUEUE_PREFIX,
        heartbeatAt: new Date(0),
        executionId: abandoned,
      })
      .returning();
    const scratch = `renders/${job!.id}/${abandoned}/segments/leftover.mp4`;
    await app.get(StorageService).write(scratch, 'abandoned');
    await confirm(id, await send(id, intent({ kind: 'copy', startTime: null, endTime: null })));
    expect((await state(id)).timeline.revision).toBe(2);
    await app.get(JobsService).recover();
    await app.get(JobsService).recover();
    await expect
      .poll(
        async () =>
          app
            .get(JobsService)
            .get(job!.id, owner)
            .then((j) => j.status),
        { timeout: 15000, interval: 100 },
      )
      .toBe('succeeded');
    const result = await app.get(JobsService).get(job!.id, owner);
    expect(result.generation).toBe(2);
    expect(result.plan.clips).toHaveLength(1);
    await app.get(JobsService).recover();
    expect(await app.get(StorageService).exists(scratch)).toBe(false);
    expect(
      (await app.get(MediaTools).probe(app.get(StorageService).resolve(result.outputKey!), true))
        .frameCount,
    ).toBe(30);
  }, 25000);
});
