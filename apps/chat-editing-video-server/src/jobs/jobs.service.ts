import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import type { CreateEditJobInput, EditJob } from '@cev/shared';
import { DB, type Database } from '../database/database.module.js';
import { editJobs, type EditJobRow } from '../database/schema.js';
import { ProjectsService } from '../projects/projects.service.js';
import { EDIT_QUEUE, type EditJobData } from './jobs.constants.js';

const ENQUEUE_TIMEOUT_MS = 3000;

export function toEditJob(row: EditJobRow): EditJob {
  return {
    id: row.id,
    projectId: row.projectId,
    status: row.status,
    progress: row.progress,
    plan: row.plan,
    outputKey: row.outputKey,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);
  private lastQueueError = 0;

  constructor(
    @Inject(DB) private readonly db: Database,
    @InjectQueue(EDIT_QUEUE) private readonly queue: Queue<EditJobData>,
    private readonly projects: ProjectsService,
  ) {
    // Without a listener BullMQ prints a stack trace on every Redis reconnect attempt.
    this.queue.on('error', (err: Error) => {
      const now = Date.now();
      if (now - this.lastQueueError > 30_000) {
        this.lastQueueError = now;
        this.logger.warn(`Queue error (is Redis running?): ${err.message || err.name}`);
      }
    });
  }

  async create(input: CreateEditJobInput): Promise<EditJob> {
    await this.projects.get(input.projectId);
    const [row] = await this.db
      .insert(editJobs)
      .values({ projectId: input.projectId, plan: input.plan })
      .returning();
    const job = row!;

    // BullMQ buffers commands while Redis is unreachable; don't let the request hang.
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.queue.add(
          'render',
          { jobId: job.id },
          { jobId: job.id, removeOnComplete: 100, removeOnFail: 500 },
        ),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('enqueue timeout')), ENQUEUE_TIMEOUT_MS);
        }),
      ]);
    } catch {
      await this.db
        .update(editJobs)
        .set({ status: 'failed', error: 'Queue unavailable' })
        .where(eq(editJobs.id, job.id));
      throw new ServiceUnavailableException('Job queue unavailable (is Redis running?)');
    } finally {
      clearTimeout(timer);
    }
    return toEditJob(job);
  }

  async get(id: string): Promise<EditJob> {
    const [row] = await this.db.select().from(editJobs).where(eq(editJobs.id, id));
    if (!row) throw new NotFoundException(`Job ${id} not found`);
    return toEditJob(row);
  }
}
