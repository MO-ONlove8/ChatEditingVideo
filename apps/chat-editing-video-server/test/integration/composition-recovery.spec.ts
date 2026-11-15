import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { CompositionManifest, Timeline } from '@cev/shared';
import { AppModule } from '../../src/app.module.js';
import { loadEnv } from '../../src/config/env.js';
import { DB, type Database } from '../../src/database/database.module.js';
import {
  chatTurns,
  compositions,
  projects,
  proposals,
  timelines,
} from '../../src/database/schema.js';
import { CompositionService } from '../../src/composition/composition.service.js';
import { CompositionEngine } from '../../src/composition/composition-engine.service.js';
import { StorageService } from '../../src/storage/storage.service.js';

describe('D1 composition publication fencing', () => {
  const projectId = randomUUID(),
    root = path.resolve('storage', 'd1-recovery-' + randomUUID());
  const timeline: Timeline = { revision: 1, fps: 30, canvas: null, clips: [] };
  const manifest = (hash: string): CompositionManifest => ({
    hash,
    frames: 1,
    canvas: { width: 2, height: 2 },
    overlays: [],
    audioKey: 'test',
    fontHash: 'test',
  });
  let app: INestApplication, db: Database, service: CompositionService, engine: CompositionEngine;
  beforeAll(async () => {
    const env = {
      ...loadEnv(),
      NODE_ENV: 'test' as const,
      JOBS_WORKER_ENABLED: false,
      STORAGE_DIR: root,
      QUEUE_PREFIX: 'd1-recovery-' + randomUUID(),
    };
    const module = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] }).compile();
    app = module.createNestApplication();
    await app.init();
    db = app.get(DB);
    service = app.get(CompositionService);
    engine = app.get(CompositionEngine);
    await db.insert(projects).values({ id: projectId, name: 'D1 recovery fixture' });
    await db.insert(timelines).values({ projectId, state: timeline });
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    if (db) await db.delete(projects).where(eq(projects.id, projectId));
    await app?.close();
    await rm(root, { recursive: true, force: true });
  });
  it('keeps the newer formal result when an obsolete execution finishes or fails later', async () => {
    for (const fail of [false, true]) {
      const [formal] = await db
        .insert(compositions)
        .values({ projectId, revision: fail ? 3 : 2, snapshot: timeline })
        .returning();
      let settle!: (m: CompositionManifest) => void, reject!: (e: Error) => void;
      const deferred = new Promise<CompositionManifest>((resolve, no) => {
        settle = resolve;
        reject = no;
      });
      const spy = vi
        .spyOn(engine, 'prepare')
        .mockImplementationOnce(() => deferred)
        .mockResolvedValueOnce(manifest('current'));
      const work = { kind: 'formal' as const, id: formal!.id, generation: formal!.revision };
      const old = service.process(work, new AbortController().signal);
      await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
      await service.process(work, new AbortController().signal);
      if (fail) reject(new Error('obsolete failure'));
      else settle(manifest('obsolete'));
      await old;
      const [saved] = await db.select().from(compositions).where(eq(compositions.id, formal!.id));
      expect(saved).toMatchObject({ status: 'ready', manifest: { hash: 'current' }, error: null });
      spy.mockRestore();
    }
    expect(
      (await db.select().from(timelines).where(eq(timelines.projectId, projectId)))[0]!.state,
    ).toEqual(timeline);
  });
  it('never publishes an old candidate generation after parameters are updated', async () => {
    const [turn] = await db
      .insert(chatTurns)
      .values({
        projectId,
        requestId: randomUUID(),
        text: 'fixture',
        status: 'pending',
        baseRevision: 1,
        deadline: new Date(Date.now() + 60000),
      })
      .returning();
    const [card] = await db
      .insert(proposals)
      .values({
        projectId,
        turnId: turn!.id,
        baseRevision: 1,
        sourceLabel: 'test',
        destinationLabel: 'test',
        operation: { kind: 'delete-element', id: 'subtitles' },
        candidate: timeline,
      })
      .returning();
    let settle!: (m: CompositionManifest) => void;
    const spy = vi
      .spyOn(engine, 'prepare')
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            settle = resolve;
          }),
      )
      .mockResolvedValueOnce(manifest('generation2'));
    const old = service.process(
      { kind: 'candidate', id: card!.id, generation: 1 },
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    await db
      .update(proposals)
      .set({ generation: 2, previewStatus: 'processing' })
      .where(eq(proposals.id, card!.id));
    await service.process(
      { kind: 'candidate', id: card!.id, generation: 2 },
      new AbortController().signal,
    );
    settle(manifest('generation1'));
    await old;
    expect((await db.select().from(proposals).where(eq(proposals.id, card!.id)))[0]).toMatchObject({
      generation: 2,
      previewStatus: 'ready',
      contentHash: 'generation2',
    });
    spy.mockRestore();
  });
  it('expires abandoned candidate resources but preserves saved preview dependencies', async () => {
    const storage = app.get(StorageService),
      orphan = 'a'.repeat(64),
      kept = 'b'.repeat(64),
      mix = 'c'.repeat(64);
    const prefix = `projects/${projectId}/composition/`;
    await storage.write(prefix + orphan + '/S1.png', 'orphan');
    await storage.write(prefix + kept + '/manifest.json', 'saved');
    await storage.write(prefix + mix + '/mix/audio.m4a', 'saved');
    await db.insert(compositions).values({
      projectId,
      revision: 4,
      status: 'ready',
      snapshot: timeline,
      manifest: { ...manifest(kept), audioKey: prefix + mix + '/mix/audio.m4a' },
    });
    await service.pruneCache(Date.now() + 2 * 86400000);
    expect(await storage.exists(prefix + orphan)).toBe(false);
    expect(await storage.exists(prefix + kept + '/manifest.json')).toBe(true);
    expect(await storage.exists(prefix + mix + '/mix/audio.m4a')).toBe(true);
  });
});
