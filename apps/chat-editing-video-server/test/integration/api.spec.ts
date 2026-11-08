import 'reflect-metadata';
import { randomInt, createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { readFile, rm } from 'node:fs/promises';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/bootstrap.js';
import { loadEnv } from '../../src/config/env.js';
import { DB, type Database } from '../../src/database/database.module.js';
import {
  editJobs,
  loginCodes,
  mediaAssets,
  mediaRuns,
  projects,
  sessions,
  users,
  timelines,
} from '../../src/database/schema.js';
import { ProjectsService } from '../../src/projects/projects.service.js';
import { StorageService } from '../../src/storage/storage.service.js';
import { videoFixture } from '../support/video.js';
import { MediaTools } from '../../src/media/media-tools.service.js';
import { MediaProcessing, MEDIA_INDEX_QUEUE } from '../../src/media/media-processing.service.js';

/** Real PostgreSQL/Redis; unique test accounts and isolated, disposable file storage. */
describe('authenticated API integration', () => {
  let app: INestApplication;
  let db: Database;
  let baseUrl: string;
  let video: Buffer;
  const phones: string[] = [];
  const ownedProjects: Array<{ id: string; owner: string }> = [];
  const storageRoot = path.resolve('storage', `integration-${randomUUID()}`);
  const newPhone = () => {
    const phone = `199${randomInt(10000000, 99999999)}`;
    phones.push(phone);
    return phone;
  };
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const code = (phone: string) =>
    request(app.getHttpServer()).post('/api/auth/code').send({ phone });
  const login = (phone: string, value = '123456') =>
    request(app.getHttpServer()).post('/api/auth/login').send({ phone, code: value });
  const signIn = async (phone = newPhone()) => {
    await code(phone).expect(200);
    return (await login(phone).expect(200)).body as {
      token: string;
      user: { id: string; phone: string };
    };
  };
  const createProject = async (account: { token: string; user: { id: string } }) => {
    const result = await request(app.getHttpServer())
      .post('/api/projects')
      .set(auth(account.token))
      .send({ name: 'integration task' })
      .expect(201);
    ownedProjects.push({ id: result.body.id, owner: account.user.id });
    return result.body.id as string;
  };
  const upload = async (token: string, projectId: string) =>
    (
      await request(app.getHttpServer())
        .post(`/api/projects/${projectId}/media`)
        .set(auth(token))
        .attach('file', video, {
          filename: 'test.mp4',
          contentType: 'video/mp4',
        })
        .expect(201)
    ).body;
  const reserve = async (
    token: string,
    ids: string[],
    projectId?: string,
    contextId = randomUUID(),
  ) => {
    const input = {
      contextId,
      projectId,
      files: ids.map((id) => ({ id, fileName: '编号视频.mp4', sizeBytes: video.length })),
    };
    await request(app.getHttpServer())
      .post('/api/uploads')
      .set(auth(token))
      .send(input)
      .expect(201);
    return input;
  };
  const sendVideo = (token: string, id: string, payload = video) =>
    request(app.getHttpServer())
      .put(`/api/uploads/${id}/content`)
      .set(auth(token))
      .set('Content-Type', 'application/octet-stream')
      .send(payload);
  const waitAsset = async (token: string, projectId: string, id: string, status = 'ready') => {
    await expect
      .poll(
        async () => {
          const result = await request(app.getHttpServer())
            .get(`/api/projects/${projectId}/media`)
            .set(auth(token));
          return result.body.find((asset: { id: string }) => asset.id === id)?.status;
        },
        { timeout: 20_000, interval: 150 },
      )
      .toBe(status);
  };

  beforeAll(async () => {
    video = await readFile(await videoFixture(path.join(storageRoot, 'fixture.mp4')));
    const env = {
      ...loadEnv(),
      NODE_ENV: 'test' as const,
      STORAGE_DIR: storageRoot,
      QUEUE_PREFIX: `integration-${randomUUID()}`,
    };
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot(env)],
    }).compile();
    app = configureApp(moduleRef.createNestApplication(), env);
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
    db = app.get(DB);
  });
  afterAll(async () => {
    try {
      for (const project of ownedProjects) {
        try {
          await app.get(ProjectsService).remove(project.id, project.owner);
        } catch (error) {
          if (!(error instanceof Error && error.message === '任务不存在')) throw error;
        }
      }
      if (phones.length) {
        await db.delete(loginCodes).where(inArray(loginCodes.phone, phones));
        await db.delete(users).where(inArray(users.phone, phones));
      }
      if (!storageRoot.startsWith(path.resolve('storage') + path.sep))
        throw new Error('Unsafe test cleanup path');
      await rm(storageRoot, { recursive: true, force: true });
    } finally {
      await app?.close();
    }
  });

  it('keeps health public and protects existing business routes', async () => {
    const health = await request(app.getHttpServer()).get('/api/health').expect(200);
    expect(health.body.checks).toMatchObject({ database: 'up', redis: 'up' });
    for (const route of ['/api/projects', '/api/auth/me', '/api/auth/events'])
      await request(app.getHttpServer()).get(route).expect(401);
    await code('12345678901').expect(400);
  });

  it('enforces cooldown, code validity, consumption and session expiry', async () => {
    const phone = newPhone();
    const result = await code(phone).expect(200);
    expect(result.body.testCode).toBe('123456');
    expect(Date.parse(result.body.resendAt) - Date.now()).toBeGreaterThan(55_000);
    await code(phone).expect(429);
    await login(phone, '000000').expect(400);
    const account = (await login(phone).expect(200)).body;
    await login(phone).expect(400);
    const stored = await db.select().from(sessions).where(eq(sessions.userId, account.user.id));
    expect(stored[0]!.tokenHash).toBe(createHash('sha256').update(account.token).digest('hex'));
    await db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.id, stored[0]!.id));
    const expired = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set(auth(account.token))
      .expect(401);
    expect(expired.body.code).toBe('SESSION_EXPIRED');
    await db
      .update(loginCodes)
      .set({ consumed: false, expiresAt: new Date(0) })
      .where(eq(loginCodes.phone, phone));
    await login(phone).expect(400);
  });

  it('pushes replacement to idle clients; an old logout cannot revoke the new session', async () => {
    const first = await signIn();
    const abort = new AbortController();
    const stream = await fetch(`${baseUrl}/api/auth/events`, {
      headers: auth(first.token),
      signal: abort.signal,
    });
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    try {
      expect(decoder.decode((await reader.read()).value)).toContain('ready');
      await db
        .update(loginCodes)
        .set({ resendAt: new Date(0) })
        .where(eq(loginCodes.phone, first.user.phone));
      const next = await signIn(first.user.phone);
      expect(next.user.id).toBe(first.user.id);
      let timer: NodeJS.Timeout | undefined;
      const data = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Missing session replacement event')), 4000);
        }),
      ]).finally(() => clearTimeout(timer));
      expect(decoder.decode(data.value)).toContain('SESSION_REPLACED');
      const old = await request(app.getHttpServer())
        .get('/api/auth/me')
        .set(auth(first.token))
        .expect(401);
      expect(old.body.message).toBe('账号已在其他位置登录');
      await request(app.getHttpServer())
        .post('/api/auth/logout')
        .set(auth(first.token))
        .expect(401);
      await request(app.getHttpServer()).get('/api/auth/me').set(auth(next.token)).expect(200);
      await request(app.getHttpServer()).post('/api/auth/logout').set(auth(next.token)).expect(204);
      await request(app.getHttpServer()).get('/api/auth/me').set(auth(next.token)).expect(401);
    } finally {
      abort.abort();
      await reader.cancel().catch(() => {});
    }
  });

  it('serializes concurrent login attempts and leaves exactly one active session', async () => {
    const phone = newPhone();
    const codes = await Promise.all([code(phone), code(phone)]);
    expect(codes.map((result) => result.status).sort()).toEqual([200, 429]);
    const attempts = await Promise.all([login(phone), login(phone)]);
    expect(attempts.map((result) => result.status).sort()).toEqual([200, 400]);
    const account = attempts.find((result) => result.status === 200)!.body;
    expect(
      await db
        .select()
        .from(sessions)
        .where(and(eq(sessions.userId, account.user.id), isNull(sessions.revokedReason))),
    ).toHaveLength(1);
  });

  it('isolates task, media, job and event access, including sources from another task', async () => {
    const a = await signIn();
    const b = await signIn();
    const aId = await createProject(a);
    const bId = await createProject(b);
    const aAsset = await upload(a.token, aId);
    const bAsset = await upload(b.token, bId);
    await waitAsset(a.token, aId, aAsset.id);
    const list = await request(app.getHttpServer())
      .get('/api/projects')
      .set(auth(a.token))
      .expect(200);
    expect(list.body.map((task: { id: string }) => task.id)).toEqual([aId]);
    for (const endpoint of [`/api/projects/${aId}`, `/api/projects/${aId}/media`])
      await request(app.getHttpServer()).get(endpoint).set(auth(b.token)).expect(404);
    await request(app.getHttpServer())
      .patch(`/api/projects/${aId}`)
      .set(auth(b.token))
      .send({ name: 'wrong owner' })
      .expect(404);
    await request(app.getHttpServer())
      .delete(`/api/projects/${aId}`)
      .set(auth(b.token))
      .expect(404);
    await request(app.getHttpServer())
      .post(`/api/projects/${aId}/media`)
      .set(auth(b.token))
      .attach('file', Buffer.from('x'), { filename: 'x.mp4', contentType: 'video/mp4' })
      .expect(404);
    // Clients cannot submit arbitrary media plans; generation uses server-owned timeline state.
    await request(app.getHttpServer())
      .post('/api/jobs')
      .set(auth(a.token))
      .send({
        projectId: aId,
        plan: { version: 1, clips: [{ source: bAsset.id, startSec: 0, endSec: 1 }] },
      })
      .expect(400);
    await db.insert(timelines).values({
      projectId: aId,
      state: {
        revision: 1,
        fps: 30,
        canvas: { width: 320, height: 180 },
        clips: [
          { id: randomUUID(), source: aAsset.id, generation: 1, startFrame: 0, endFrame: 29 },
        ],
      },
    });
    const job = await request(app.getHttpServer())
      .post('/api/jobs')
      .set(auth(a.token))
      .send({ projectId: aId, expectedRevision: 1, requestId: randomUUID() })
      .expect(201);
    await request(app.getHttpServer())
      .get(`/api/jobs/${job.body.id}`)
      .set(auth(b.token))
      .expect(404);
    await request(app.getHttpServer())
      .get(`/api/jobs/${job.body.id}/events`)
      .set(auth(b.token))
      .expect(404);
    // Deletion races a running worker and must leave no late output or asset behind.
    await request(app.getHttpServer())
      .delete(`/api/projects/${aId}`)
      .set(auth(a.token))
      .expect(204);
    expect(await app.get(StorageService).exists(aAsset.storageKey)).toBe(false);
    expect(await app.get(StorageService).exists(`renders/${job.body.id}.manifest.json`)).toBe(
      false,
    );
    await request(app.getHttpServer())
      .get(`/api/jobs/${job.body.id}`)
      .set(auth(a.token))
      .expect(404);
  });

  it('preserves and hides legacy records rather than assigning them to the first account', async () => {
    const [legacy] = await db
      .insert(projects)
      .values({ name: 'legacy integration record' })
      .returning();
    try {
      const account = await signIn();
      const list = await request(app.getHttpServer())
        .get('/api/projects')
        .set(auth(account.token))
        .expect(200);
      expect(list.body).toEqual([]);
      await request(app.getHttpServer())
        .get(`/api/projects/${legacy!.id}`)
        .set(auth(account.token))
        .expect(404);
      expect(await db.select().from(projects).where(eq(projects.id, legacy!.id))).toHaveLength(1);
    } finally {
      await db.delete(projects).where(eq(projects.id, legacy!.id));
    }
  });

  it('continues queued work after logout and restores its state on the next login', async () => {
    const account = await signIn();
    const projectId = await createProject(account);
    const asset = await upload(account.token, projectId);
    await waitAsset(account.token, projectId, asset.id);
    await db.insert(timelines).values({
      projectId,
      state: {
        revision: 1,
        fps: 30,
        canvas: { width: 320, height: 180 },
        clips: [{ id: randomUUID(), source: asset.id, generation: 1, startFrame: 0, endFrame: 29 }],
      },
    });
    const job = await request(app.getHttpServer())
      .post('/api/jobs')
      .set(auth(account.token))
      .send({ projectId, expectedRevision: 1, requestId: randomUUID() })
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/auth/logout')
      .set(auth(account.token))
      .expect(204);
    await expect
      .poll(
        async () => {
          const [row] = await db.select().from(editJobs).where(eq(editJobs.id, job.body.id));
          return row?.status;
        },
        { timeout: 15000, interval: 150 },
      )
      .toBe('succeeded');
    await db
      .update(loginCodes)
      .set({ resendAt: new Date(0) })
      .where(eq(loginCodes.phone, account.user.phone));
    const next = await signIn(account.user.phone);
    const result = await request(app.getHttpServer())
      .get(`/api/jobs/${job.body.id}`)
      .set(auth(next.token))
      .expect(200);
    expect(result.body.status).toBe('succeeded');
    expect(await app.get(StorageService).exists(result.body.outputKey)).toBe(true);
  });

  it('keeps failed deletion retryable without losing references to stored assets', async () => {
    const account = await signIn();
    const projectId = await createProject(account);
    const asset = await upload(account.token, projectId);
    const storage = app.get(StorageService);
    const fail = vi.spyOn(storage, 'remove').mockRejectedValueOnce(new Error('test file is busy'));
    try {
      await request(app.getHttpServer())
        .delete(`/api/projects/${projectId}`)
        .set(auth(account.token))
        .expect(500);
      expect(await storage.exists(asset.storageKey)).toBe(true);
      const list = await request(app.getHttpServer())
        .get('/api/projects')
        .set(auth(account.token))
        .expect(200);
      expect(list.body[0].deletionPending).toBe(true);
      await request(app.getHttpServer())
        .delete(`/api/projects/${projectId}`)
        .set(auth(account.token))
        .expect(204);
      expect(await storage.exists(asset.storageKey)).toBe(false);
    } finally {
      fail.mockRestore();
    }
  });

  it('creates one task on concurrent first uploads, is idempotent and serves exact private frames', async () => {
    const account = await signIn();
    const other = await signIn();
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    const input = await reserve(account.token, ids);
    await request(app.getHttpServer())
      .post('/api/uploads')
      .set(auth(account.token))
      .send(input)
      .expect(201);
    expect(
      (await request(app.getHttpServer()).get('/api/projects').set(auth(account.token))).body,
    ).toEqual([]);
    await request(app.getHttpServer())
      .delete(`/api/uploads/${ids[2]}`)
      .set(auth(account.token))
      .expect(200);
    await sendVideo(account.token, ids[2]!).expect(409);
    const results = await Promise.all(
      ids.slice(0, 2).map((id) => sendVideo(account.token, id).expect(200)),
    );
    const projectId = results[0]!.body.projectId as string;
    ownedProjects.push({ id: projectId, owner: account.user.id });
    expect(results[1]!.body.projectId).toBe(projectId);
    expect(results.map((r) => r.body.asset.number).sort()).toEqual([1, 2]);
    expect((await sendVideo(account.token, ids[0]!).expect(200)).body.asset.id).toBe(
      results[0]!.body.asset.id,
    );
    const asset = results[0]!.body.asset;
    await waitAsset(account.token, projectId, asset.id);
    await expect
      .poll(
        async () =>
          (
            await request(app.getHttpServer())
              .get(`/api/media/${asset.id}/thumbnails?page=0`)
              .set(auth(account.token))
          ).body.status,
        { timeout: 8000, interval: 100 },
      )
      .toBe('ready');
    const thumbs = await request(app.getHttpServer())
      .get(`/api/media/${asset.id}/thumbnails?page=0`)
      .set(auth(account.token))
      .expect(200);
    expect(thumbs.body.images.map((i: { frame: number }) => i.frame)).toEqual([0, 30]);
    await expect
      .poll(
        async () =>
          (
            await request(app.getHttpServer())
              .get(`/api/media/${asset.id}/frames?second=1`)
              .set(auth(account.token))
          ).body.status,
        { timeout: 8000, interval: 100 },
      )
      .toBe('ready');
    const frames = (
      await request(app.getHttpServer())
        .get(`/api/media/${asset.id}/frames?second=1`)
        .set(auth(account.token))
    ).body;
    expect(frames.images.map((i: { frame: number }) => i.frame)).toEqual([30, 31, 32, 33, 34, 35]);
    const full = await request(app.getHttpServer())
      .get(`/api/media/${asset.id}/frames/35/image`)
      .set(auth(account.token))
      .expect(200);
    const [row] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, asset.id));
    const expected = path.join(storageRoot, 'expected-frame.jpg');
    const tools = app.get(MediaTools);
    await tools.run(tools.env.FFMPEG_PATH, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      app.get(StorageService).resolve(row!.editingKey!),
      '-vf',
      'select=eq(n\\,35)',
      '-frames:v',
      '1',
      '-q:v',
      '2',
      '-threads',
      '1',
      expected,
    ]);
    expect(full.body).toEqual(await readFile(expected));
    for (const route of [
      thumbs.body.sprite.path,
      frames.images[0].path,
      `/media/${asset.id}/frames/35/image`,
      `/media/${asset.id}/content`,
      `/projects/${projectId}/media/events`,
      `/uploads/${ids[0]}`,
    ]) {
      await request(app.getHttpServer()).get(`/api${route}`).set(auth(other.token)).expect(404);
      await request(app.getHttpServer()).get(`/api${route}`).expect(401);
    }
    await request(app.getHttpServer())
      .get(`/api/media/${asset.id}/frames?second=2`)
      .set(auth(account.token))
      .expect(400);
    await request(app.getHttpServer())
      .get(`/api/media/${asset.id}/frames/36/image`)
      .set(auth(account.token))
      .expect(400);
    const videoUrl = `/api/media/${asset.id}/content`;
    const ranged = await request(app.getHttpServer())
      .get(videoUrl)
      .set(auth(account.token))
      .set('Range', 'bytes=0-15')
      .expect(206);
    expect(ranged.headers['content-length']).toBe('16');
    expect(ranged.headers['cache-control']).toBe('private, no-store');
    await request(app.getHttpServer()).head(videoUrl).set(auth(account.token)).expect(200);
    await request(app.getHttpServer())
      .get(videoUrl)
      .set(auth(account.token))
      .set('Range', 'bytes=99999999-')
      .expect(416);
    const task = (await request(app.getHttpServer()).get('/api/projects').set(auth(account.token)))
      .body[0];
    expect(task).toMatchObject({ mediaCount: 2, failedCount: 0 });
  });

  it('validates files on the server and releases reservations after failure or cancellation', async () => {
    const account = await signIn();
    const id = randomUUID();
    await reserve(account.token, [id]);
    const broken = Buffer.alloc(video.length, 0);
    await sendVideo(account.token, id, broken).expect(400);
    await sendVideo(account.token, id).expect(409);
    const incomplete = randomUUID();
    await reserve(account.token, [incomplete]);
    await sendVideo(
      account.token,
      incomplete,
      video.subarray(0, Math.floor(video.length / 2)),
    ).expect(400);
    expect(
      (
        await request(app.getHttpServer())
          .get(`/api/uploads/${incomplete}`)
          .set(auth(account.token))
      ).body,
    ).toMatchObject({ status: 'failed', projectId: null });
    expect(
      (await request(app.getHttpServer()).get('/api/projects').set(auth(account.token))).body,
    ).toEqual([]);
    const projectId = await createProject(account);
    const reservations: string[] = [];
    for (let i = 0; i < 10; i++) {
      const next = randomUUID();
      await reserve(account.token, [next], projectId);
      reservations.push(next);
    }
    await request(app.getHttpServer())
      .post('/api/uploads')
      .set(auth(account.token))
      .send({
        contextId: randomUUID(),
        projectId,
        files: [{ id: randomUUID(), fileName: 'x.mp4', sizeBytes: video.length }],
      })
      .expect(400);
    await request(app.getHttpServer())
      .delete(`/api/uploads/${reservations[0]}`)
      .set(auth(account.token))
      .expect(200);
    await reserve(account.token, [randomUUID()], projectId);
  });

  it('retries failed processing and deletion while preserving original files and stable V numbers', async () => {
    const account = await signIn();
    const projectId = await createProject(account);
    const tools = app.get(MediaTools);
    vi.spyOn(tools, 'directInfo').mockResolvedValueOnce(null);
    const fail = vi
      .spyOn(tools, 'normalize')
      .mockRejectedValueOnce(new Error('test encoder failure'));
    const asset = await upload(account.token, projectId);
    await waitAsset(account.token, projectId, asset.id, 'failed');
    fail.mockRestore();
    expect(await app.get(StorageService).exists(asset.storageKey)).toBe(true);
    const attempts = await Promise.all(
      [1, 2].map(() =>
        request(app.getHttpServer()).post(`/api/media/${asset.id}/retry`).set(auth(account.token)),
      ),
    );
    expect(attempts.map((r) => r.status).sort()).toEqual([201, 409]);
    await waitAsset(account.token, projectId, asset.id);
    const storage = app.get(StorageService);
    const failDelete = vi.spyOn(storage, 'remove').mockRejectedValueOnce(new Error('file busy'));
    await request(app.getHttpServer())
      .delete(`/api/media/${asset.id}`)
      .set(auth(account.token))
      .expect(500);
    failDelete.mockRestore();
    const list = (
      await request(app.getHttpServer())
        .get(`/api/projects/${projectId}/media`)
        .set(auth(account.token))
    ).body;
    expect(list[0]).toMatchObject({ id: asset.id, deleting: true, status: 'failed' });
    await request(app.getHttpServer())
      .delete(`/api/media/${asset.id}`)
      .set(auth(account.token))
      .expect(204);
    expect(await storage.exists(asset.storageKey)).toBe(false);
    expect(await db.select().from(mediaRuns).where(eq(mediaRuns.assetId, asset.id))).toEqual([]);
    const next = await upload(account.token, projectId);
    expect(next.number).toBe(2);
    await waitAsset(account.token, projectId, next.id);
  });

  it('prevents late processing output when a running asset is deleted', async () => {
    const account = await signIn();
    const projectId = await createProject(account);
    const tools = app.get(MediaTools);
    const original = tools.normalize.bind(tools);
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.spyOn(tools, 'directInfo').mockResolvedValueOnce(null);
    const delay = vi.spyOn(tools, 'normalize').mockImplementationOnce(async (...args) => {
      started();
      await new Promise<void>((resolve) =>
        args[3].addEventListener('abort', () => resolve(), { once: true }),
      );
      args[3].throwIfAborted();
      return original(...args);
    });
    try {
      const asset = await upload(account.token, projectId);
      await began;
      await request(app.getHttpServer())
        .delete(`/api/media/${asset.id}`)
        .set(auth(account.token))
        .expect(204);
      await expect
        .poll(
          async () =>
            (await db.select().from(mediaAssets).where(eq(mediaAssets.id, asset.id))).length,
        )
        .toBe(0);
      expect(
        await app.get(StorageService).exists(`projects/${projectId}/derived/${asset.id}`),
      ).toBe(false);
      await app.get(MediaProcessing).recover();
    } finally {
      delay.mockRestore();
    }
  });

  it('recovers a persisted interrupted run whose Redis job has been lost', async () => {
    const account = await signIn();
    const projectId = await createProject(account);
    const queue = app.get<Queue>(getQueueToken(MEDIA_INDEX_QUEUE));
    await queue.pause();
    let asset: { id: string; number: number };
    try {
      asset = await upload(account.token, projectId);
      await app.get(MediaProcessing).recover();
      const [run] = await db.select().from(mediaRuns).where(eq(mediaRuns.assetId, asset.id));
      const job = await queue.getJob(run!.id);
      await job?.remove();
      await db
        .update(mediaRuns)
        .set({ status: 'processing', executionId: randomUUID() })
        .where(eq(mediaRuns.id, run!.id));
      await db
        .update(mediaAssets)
        .set({ status: 'processing' })
        .where(eq(mediaAssets.id, asset.id));
      await app.get(MediaProcessing).recover();
      expect(await queue.getJob(run!.id)).toBeDefined();
    } finally {
      await queue.resume();
    }
    await waitAsset(account.token, projectId, asset!.id);
    const list = (
      await request(app.getHttpServer())
        .get(`/api/projects/${projectId}/media`)
        .set(auth(account.token))
    ).body;
    expect(list).toHaveLength(1);
    expect(list[0].number).toBe(asset!.number);
  });
});
