import {
  Inject,
  Injectable,
  Logger,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { CreateEditJobInput, EditJob } from '@cev/shared';
import { DB, type Database } from '../database/database.module.js';
import { editJobs, mediaAssets, projects, type EditJobRow } from '../database/schema.js';
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

  async create(input: CreateEditJobInput, ownerId: string): Promise<EditJob> {
    await this.projects.get(input.projectId, ownerId);
    const job = await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`project:${input.projectId}`}))`,
      );
      const [project] = await tx
        .select()
        .from(projects)
        .where(
          and(
            eq(projects.id, input.projectId),
            eq(projects.ownerId, ownerId),
            eq(projects.deleting, false),
          ),
        );
      if (!project) throw new NotFoundException('任务不存在');
      const sources = [...new Set(input.plan.clips.map((clip) => clip.source))];
      const assets = await tx
        .select({ id: mediaAssets.id, status: mediaAssets.status })
        .from(mediaAssets)
        .where(
          and(
            eq(mediaAssets.projectId, input.projectId),
            inArray(mediaAssets.id, sources),
            eq(mediaAssets.deleting, false),
          ),
        );
      if (assets.length !== sources.length) throw new NotFoundException('素材不存在或不属于此任务');
      if (assets.some((asset) => asset.status !== 'ready'))
        throw new ConflictException('素材处理完成后才能用于剪辑');
      const [row] = await tx
        .insert(editJobs)
        .values({ projectId: input.projectId, plan: input.plan })
        .returning();
      return row!;
    });

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

  async get(id: string, ownerId: string): Promise<EditJob> {
    const [result] = await this.db
      .select({ job: editJobs })
      .from(editJobs)
      .innerJoin(projects, eq(projects.id, editJobs.projectId))
      .where(and(eq(editJobs.id, id), eq(projects.ownerId, ownerId), eq(projects.deleting, false)));
    const row = result?.job;
    if (!row) throw new NotFoundException(`Job ${id} not found`);
    return toEditJob(row);
  }
}
