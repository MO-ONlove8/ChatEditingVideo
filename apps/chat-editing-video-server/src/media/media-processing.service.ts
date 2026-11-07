import { randomUUID } from 'node:crypto';
import { mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job, Queue } from 'bullmq';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { DB, type Database } from '../database/database.module.js';
import { mediaAssets, mediaRuns, projects } from '../database/schema.js';
import { StorageService } from '../storage/storage.service.js';
import { MediaTools } from './media-tools.service.js';
import { APP_CONFIG } from '../config/config.module.js';
import type { Env } from '../config/env.js';

export const MEDIA_QUEUE = 'media-processing';
export const MEDIA_INDEX_QUEUE = 'media-indexing';
export const projectLock = (id: string) =>
  sql`select pg_advisory_xact_lock(hashtext(${`project:${id}`}))`;

@Injectable()
export class MediaProcessing implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(MediaProcessing.name);
  private timer?: NodeJS.Timeout;
  private recovering = false;
  private stopping = false;
  private readonly active = new Map<string, AbortController>();
  constructor(
    @Inject(DB) private readonly db: Database,
    @InjectQueue(MEDIA_QUEUE) private readonly queue: Queue,
    @InjectQueue(MEDIA_INDEX_QUEUE) private readonly indexQueue: Queue,
    private readonly storage: StorageService,
    private readonly tools: MediaTools,
    @Inject(APP_CONFIG) private readonly env: Env,
  ) {
    this.queue.on('error', () => {});
    this.indexQueue.on('error', () => {});
  }

  async onApplicationBootstrap() {
    if (!this.env.MEDIA_WORKER_ENABLED) return;
    await this.tools.check();
    await this.queue.setGlobalConcurrency(1);
    await this.indexQueue.setGlobalConcurrency(2);
    await this.recover();
    this.timer = setInterval(() => void this.recover(), 5000);
    this.timer.unref();
  }
  async onModuleDestroy() {
    this.stopping = true;
    clearInterval(this.timer);
    for (const abort of this.active.values()) abort.abort();
    const deadline = Date.now() + 5000;
    while (this.active.size && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 25));
  }
  cancel(id: string) {
    this.active.get(id)?.abort();
  }
  async enqueueAsset(assetId: string) {
    const [run] = await this.db
      .select()
      .from(mediaRuns)
      .where(and(eq(mediaRuns.assetId, assetId), eq(mediaRuns.status, 'queued')))
      .orderBy(sql`${mediaRuns.generation} desc`)
      .limit(1);
    if (!run) return;
    const queue = run.phase === 'index' ? this.indexQueue : this.queue;
    await queue.add(
      run.phase,
      { runId: run.id },
      { jobId: run.id, removeOnComplete: 100, removeOnFail: 100 },
    );
  }

  async recover() {
    if (this.recovering || this.stopping) return;
    this.recovering = true;
    try {
      const rows = await this.db
        .select({ run: mediaRuns, asset: mediaAssets })
        .from(mediaRuns)
        .innerJoin(mediaAssets, eq(mediaAssets.id, mediaRuns.assetId))
        .innerJoin(projects, eq(projects.id, mediaAssets.projectId))
        .where(
          and(
            inArray(mediaRuns.status, ['queued', 'processing']),
            eq(mediaRuns.queuePrefix, this.env.QUEUE_PREFIX),
            eq(mediaAssets.deleting, false),
            eq(projects.deleting, false),
          ),
        );
      for (const { run, asset } of rows) {
        if (run.generation !== asset.generation || this.active.has(asset.id)) continue;
        const queue = run.phase === 'index' ? this.indexQueue : this.queue;
        let job = await queue.getJob(run.id);
        if (job && (await job.getState()) === 'completed') {
          await job.remove();
          job = undefined;
        }
        if (!job)
          await queue.add(
            run.phase,
            { runId: run.id },
            { jobId: run.id, removeOnComplete: 100, removeOnFail: 100 },
          );
        else if ((await job.getState()) === 'failed') {
          await this.db
            .update(mediaRuns)
            .set({ status: 'failed', error: '处理进程中断，请重试' })
            .where(eq(mediaRuns.id, run.id));
          await this.db
            .update(mediaAssets)
            .set({ status: 'failed', error: '处理进程中断，请重试' })
            .where(and(eq(mediaAssets.id, asset.id), eq(mediaAssets.generation, run.generation)));
        }
      }
    } catch (error) {
      this.logger.warn(
        `素材队列恢复暂不可用: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    } finally {
      this.recovering = false;
    }
  }

  async process(runId: string, phase = 'normalize') {
    const [run] = await this.db.select().from(mediaRuns).where(eq(mediaRuns.id, runId));
    if (
      !run ||
      run.phase !== phase ||
      run.queuePrefix !== this.env.QUEUE_PREFIX ||
      !['queued', 'processing'].includes(run.status)
    )
      return;
    const [asset] = await this.db.select().from(mediaAssets).where(eq(mediaAssets.id, run.assetId));
    if (!asset || asset.deleting || asset.generation !== run.generation) return;
    if (this.active.has(asset.id)) throw new Error('素材已有处理作业');
    const executionId = randomUUID();
    const ownedRun = and(eq(mediaRuns.id, run.id), eq(mediaRuns.executionId, executionId));
    const ownsRun = sql`exists (select 1 from ${mediaRuns} where ${mediaRuns.id} = ${run.id} and ${mediaRuns.executionId} = ${executionId})`;
    const claimed = await this.db.transaction(async (tx) => {
      await tx.execute(projectLock(asset.projectId));
      const [current] = await tx.select().from(mediaRuns).where(eq(mediaRuns.id, run.id));
      if (!current || current.phase !== phase || !['queued', 'processing'].includes(current.status))
        return false;
      await tx
        .update(mediaRuns)
        .set({ executionId, status: 'processing' })
        .where(eq(mediaRuns.id, run.id));
      return true;
    });
    if (!claimed) return;
    const abort = new AbortController();
    this.active.set(asset.id, abort);
    const work = `.work/${randomUUID()}`;
    const finalPrefix = `projects/${asset.projectId}/derived/${asset.id}/${run.generation}/${executionId}`;
    let published = false;
    let handoff = false;
    const check = async () => {
      const [current] = await this.db
        .select({
          deleting: mediaAssets.deleting,
          generation: mediaAssets.generation,
          projectDeleting: projects.deleting,
          executionId: mediaRuns.executionId,
        })
        .from(mediaAssets)
        .innerJoin(projects, eq(projects.id, mediaAssets.projectId))
        .innerJoin(mediaRuns, eq(mediaRuns.id, run.id))
        .where(eq(mediaAssets.id, asset.id));
      if (
        !current ||
        current.deleting ||
        current.projectDeleting ||
        current.executionId !== executionId ||
        current.generation !== run.generation
      )
        abort.abort();
    };
    const timer = setInterval(() => {
      void check().catch(() => abort.abort());
    }, 1000);
    let lastProgress = -1;
    let progressWrite = Promise.resolve();
    const progress = (value: number, stage = '转换中') => {
      const rounded = Math.min(99, Math.floor(value));
      if (rounded === lastProgress) return;
      lastProgress = rounded;
      progressWrite = progressWrite
        .then(async () => {
          await this.db
            .update(mediaAssets)
            .set({ progress: rounded, stage })
            .where(
              and(
                eq(mediaAssets.id, asset.id),
                eq(mediaAssets.generation, run.generation),
                eq(mediaAssets.deleting, false),
                ownsRun,
              ),
            );
        })
        .catch((error) => {
          this.logger.warn(String(error));
        });
    };
    try {
      await check();
      abort.signal.throwIfAborted();
      await this.db
        .update(mediaAssets)
        .set({
          status: 'processing',
          stage: phase === 'index' ? '正在读取视频索引' : '转换中',
          progress: 0,
          error: null,
        })
        .where(
          and(eq(mediaAssets.id, asset.id), eq(mediaAssets.generation, run.generation), ownsRun),
        );
      const info = await this.tools.probe(
        this.storage.resolve(asset.storageKey),
        false,
        abort.signal,
      );
      const direct =
        phase === 'index'
          ? await this.tools.directInfo(this.storage.resolve(asset.storageKey), info, abort.signal)
          : null;
      if (phase === 'index' && !direct) {
        await this.db.transaction(async (tx) => {
          await tx.execute(projectLock(asset.projectId));
          const [owner] = await tx.select().from(mediaRuns).where(ownedRun);
          if (!owner) throw new Error('处理版本已变化');
          await tx
            .update(mediaRuns)
            .set({ phase: 'normalize', status: 'queued', executionId: null })
            .where(ownedRun);
          await tx
            .update(mediaAssets)
            .set({ status: 'queued', stage: '等待兼容转换' })
            .where(
              and(
                eq(mediaAssets.id, asset.id),
                eq(mediaAssets.generation, run.generation),
                eq(mediaAssets.deleting, false),
              ),
            );
        });
        handoff = true;
        return;
      }
      if (!direct)
        await this.tools.normalize(
          this.storage.resolve(asset.storageKey),
          this.storage.resolve(`${work}/edit.mp4`),
          info,
          abort.signal,
          (seconds) => progress((seconds / info.duration) * 85),
        );
      const normalized =
        direct ??
        (await this.tools.probe(this.storage.resolve(`${work}/edit.mp4`), true, abort.signal));
      if (!normalized.frameCount) throw new Error('无法核验处理后视频帧数');
      await progressWrite;
      await this.db.transaction(async (tx) => {
        await tx.execute(projectLock(asset.projectId));
        const [owner] = await tx.select().from(mediaRuns).where(ownedRun);
        const [current] = await tx
          .select({ asset: mediaAssets, project: projects })
          .from(mediaAssets)
          .innerJoin(projects, eq(projects.id, mediaAssets.projectId))
          .where(eq(mediaAssets.id, asset.id));
        if (
          !owner ||
          !current ||
          current.asset.deleting ||
          current.project.deleting ||
          current.asset.generation !== run.generation
        )
          throw new Error('素材已删除或重试');
        await mkdir(path.dirname(this.storage.resolve(finalPrefix)), { recursive: true });
        await this.storage.removeTree(finalPrefix);
        if (direct) await mkdir(this.storage.resolve(finalPrefix), { recursive: true });
        else await rename(this.storage.resolve(work), this.storage.resolve(finalPrefix));
        published = true;
        await tx
          .update(mediaAssets)
          .set({
            original: info,
            normalized: direct ? null : normalized,
            normalizedKey: direct ? null : `${finalPrefix}/edit.mp4`,
            editing: {
              kind: direct ? 'original' : 'normalized',
              info: { ...normalized, frameCount: normalized.frameCount! },
            },
            editingKey: direct ? asset.storageKey : `${finalPrefix}/edit.mp4`,
            derivedPrefix: finalPrefix,
            status: 'ready',
            stage: direct ? '可直接编辑' : '处理完成',
            progress: 100,
            error: null,
          })
          .where(eq(mediaAssets.id, asset.id));
        await tx.update(mediaRuns).set({ status: 'ready', error: null }).where(ownedRun);
      });
    } catch (error) {
      await progressWrite;
      const message = error instanceof Error ? error.message : '素材处理失败，请重试';
      await this.db
        .update(mediaAssets)
        .set(
          this.stopping
            ? { status: 'queued', stage: '等待恢复处理', error: null }
            : { status: 'failed', stage: '处理失败', error: message },
        )
        .where(
          and(
            eq(mediaAssets.id, asset.id),
            eq(mediaAssets.generation, run.generation),
            eq(mediaAssets.deleting, false),
            ownsRun,
          ),
        );
      await this.db
        .update(mediaRuns)
        .set(
          this.stopping ? { status: 'queued', error: null } : { status: 'failed', error: message },
        )
        .where(ownedRun);
      if (published) await this.storage.removeTree(finalPrefix);
    } finally {
      clearInterval(timer);
      this.active.delete(asset.id);
      await this.storage.removeTree(work);
      if (handoff)
        await this.queue.add(
          'normalize',
          { runId: run.id },
          { jobId: run.id, removeOnComplete: 100, removeOnFail: 100 },
        );
    }
  }
}

@Processor(MEDIA_QUEUE, { concurrency: 1 })
export class MediaProcessor extends WorkerHost {
  constructor(private readonly processing: MediaProcessing) {
    super();
  }
  async process(job: Job<{ runId: string }>) {
    await this.processing.process(job.data.runId);
  }
}

@Processor(MEDIA_INDEX_QUEUE, { concurrency: 2 })
export class MediaIndexProcessor extends WorkerHost {
  constructor(private readonly processing: MediaProcessing) {
    super();
  }
  async process(job: Job<{ runId: string }>) {
    await this.processing.process(job.data.runId, 'index');
  }
}
