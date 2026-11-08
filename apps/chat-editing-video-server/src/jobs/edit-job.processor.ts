import { randomUUID } from 'node:crypto';
import { Inject, Logger, type OnModuleDestroy } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { DB, type Database } from '../database/database.module.js';
import { editJobs, projects } from '../database/schema.js';
import { projectLock } from '../media/media-processing.service.js';
import { MediaService } from '../media/media.service.js';
import { StorageService } from '../storage/storage.service.js';
import { FfmpegServerExecutor } from './executors/ffmpeg-server.executor.js';
import { JobEventsBus } from './job-events.bus.js';
import { EDIT_QUEUE, type EditJobData } from './jobs.constants.js';

@Processor(EDIT_QUEUE, { concurrency: 1 })
export class EditJobProcessor extends WorkerHost implements OnModuleDestroy {
  private readonly logger = new Logger(EditJobProcessor.name);
  private active = new Set<AbortController>();
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly executor: FfmpegServerExecutor,
    private readonly bus: JobEventsBus,
    private readonly storage: StorageService,
    private readonly media: MediaService,
  ) {
    super();
  }
  onModuleDestroy() {
    for (const a of this.active) a.abort();
  }
  @OnWorkerEvent('error') onWorkerError(error: Error) {
    this.logger.debug(error.message);
  }
  async process(job: Job<EditJobData>) {
    const executionId = randomUUID(),
      generation = job.data.generation ?? 1;
    const row = await this.db.transaction(async (tx) => {
      const [found] = await tx.select().from(editJobs).where(eq(editJobs.id, job.data.jobId));
      if (!found) return null;
      await tx.execute(projectLock(found.projectId));
      const [project] = await tx
        .select()
        .from(projects)
        .where(and(eq(projects.id, found.projectId), eq(projects.deleting, false)));
      if (!project || found.generation !== generation || found.status !== 'queued') return null;
      const [claimed] = await tx
        .update(editJobs)
        .set({ status: 'running', executionId, heartbeatAt: new Date(), error: null, progress: 0 })
        .where(
          and(
            eq(editJobs.id, found.id),
            eq(editJobs.status, 'queued'),
            eq(editJobs.generation, generation),
          ),
        )
        .returning();
      return claimed ?? null;
    });
    if (!row) return;
    const abort = new AbortController();
    this.active.add(abort);
    const fence = and(
      eq(editJobs.id, row.id),
      eq(editJobs.executionId, executionId),
      eq(editJobs.generation, generation),
      eq(editJobs.status, 'running'),
    );
    let heartbeatBusy = false,
      lastProgress = 0;
    const heartbeat = setInterval(
      () =>
        void (async () => {
          if (heartbeatBusy) return;
          heartbeatBusy = true;
          try {
            const [project] = await this.db
              .select()
              .from(projects)
              .where(and(eq(projects.id, row.projectId), eq(projects.deleting, false)));
            if (!project) {
              abort.abort();
              return;
            }
            const updated = await this.db
              .update(editJobs)
              .set({ heartbeatAt: new Date() })
              .where(fence)
              .returning({ id: editJobs.id });
            if (!updated.length) abort.abort();
          } catch {
            /* Recovery fences abandoned attempts. */
          } finally {
            heartbeatBusy = false;
          }
        })(),
      2000,
    );
    try {
      const result = await this.executor.execute({
        jobId: row.id,
        executionId,
        plan: row.plan,
        signal: abort.signal,
        onEvent: (event) => {
          if (event.type !== 'progress' || Date.now() - lastProgress < 500) return;
          lastProgress = Date.now();
          void this.db
            .update(editJobs)
            .set({ progress: event.progress, heartbeatAt: new Date() })
            .where(fence)
            .returning({ id: editJobs.id })
            .then((updated) => {
              if (updated.length) return this.bus.publish(event);
            })
            .catch(() => {});
        },
      });
      const committed = await this.db.transaction(async (tx) => {
        await tx.execute(projectLock(row.projectId));
        const [project] = await tx
          .select()
          .from(projects)
          .where(and(eq(projects.id, row.projectId), eq(projects.deleting, false)));
        if (!project) return false;
        const updated = await tx
          .update(editJobs)
          .set({
            status: 'succeeded',
            progress: 100,
            outputKey: result.output,
            heartbeatAt: new Date(),
          })
          .where(fence)
          .returning({ id: editJobs.id });
        return Boolean(updated.length);
      });
      if (committed) {
        await this.bus
          .publish({ type: 'completed', jobId: row.id, outputKey: result.output })
          .catch(() => {});
        await this.media.cleanupRemoved(row.projectId);
      } else await this.storage.removeTree(`renders/${row.id}/${executionId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : '生成失败，请重试';
      const updated = await this.db
        .update(editJobs)
        .set({ status: 'failed', error: message, heartbeatAt: new Date() })
        .where(fence)
        .returning({ id: editJobs.id });
      if (updated.length) await this.bus.publish({ type: 'failed', jobId: row.id, error: message });
    } finally {
      clearInterval(heartbeat);
      this.active.delete(abort);
    }
  }
}
