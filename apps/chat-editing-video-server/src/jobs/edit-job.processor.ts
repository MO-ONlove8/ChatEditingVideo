import { Inject, Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import type { JobEvent } from '@cev/shared';
import { DB, type Database } from '../database/database.module.js';
import { editJobs } from '../database/schema.js';
import { FfmpegServerExecutor } from './executors/ffmpeg-server.executor.js';
import { JobEventsBus } from './job-events.bus.js';
import { EDIT_QUEUE, type EditJobData } from './jobs.constants.js';

/** BullMQ worker: loads the plan, runs the server executor, persists + broadcasts progress. */
@Processor(EDIT_QUEUE, { concurrency: 2 })
export class EditJobProcessor extends WorkerHost {
  private readonly logger = new Logger(EditJobProcessor.name);
  private lastConnError = 0;

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly executor: FfmpegServerExecutor,
    private readonly bus: JobEventsBus,
  ) {
    super();
  }

  /** Without a listener BullMQ dumps a full stack trace on every Redis reconnect attempt. */
  @OnWorkerEvent('error')
  onWorkerError(err: Error) {
    const now = Date.now();
    if (now - this.lastConnError > 30_000) {
      this.lastConnError = now;
      this.logger.warn(`Worker error (is Redis running?): ${err.message || err.name}`);
    }
  }

  async process(job: Job<EditJobData>) {
    const { jobId } = job.data;
    const [row] = await this.db.select().from(editJobs).where(eq(editJobs.id, jobId));
    if (!row) throw new Error(`Edit job ${jobId} not found`);

    await this.db
      .update(editJobs)
      .set({ status: 'running', progress: 0 })
      .where(eq(editJobs.id, jobId));

    // Persist before publishing so an SSE client that subscribes then reads the DB never misses state.
    const report = async (event: JobEvent) => {
      if (event.type === 'progress') {
        await this.db
          .update(editJobs)
          .set({ progress: event.progress })
          .where(eq(editJobs.id, jobId));
      }
      await this.bus.publish(event);
    };

    try {
      const { output } = await this.executor.execute({
        jobId,
        plan: row.plan,
        onEvent: (e) =>
          void report(e).catch((err) => this.logger.warn(`progress report failed: ${err}`)),
      });
      await this.db
        .update(editJobs)
        .set({ status: 'succeeded', progress: 100, outputKey: output })
        .where(eq(editJobs.id, jobId));
      await this.bus.publish({ type: 'completed', jobId, outputKey: output });
      return { output };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.db
        .update(editJobs)
        .set({ status: 'failed', error: message })
        .where(eq(editJobs.id, jobId));
      await this.bus.publish({ type: 'failed', jobId, error: message });
      throw err;
    }
  }
}
