import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { and, desc, eq, sql, inArray } from 'drizzle-orm';
import {
  timelineFrames,
  type CreateProjectInput,
  type Project,
  type UpdateProjectInput,
} from '@cev/shared';
import { DB, type Database } from '../database/database.module.js';
import { editJobs, projects, mediaAssets, timelines, type ProjectRow } from '../database/schema.js';
import { StorageService } from '../storage/storage.service.js';
import { EDIT_QUEUE } from '../jobs/jobs.constants.js';
import { MediaService } from '../media/media.service.js';

export function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    hasMainVideo: false,
    deletionPending: row.deleting,
    mediaCount: 0,
    processingCount: 0,
    failedCount: 0,
    durationFrames: 0,
    timelineRevision: 0,
    latestJob: null,
  };
}

@Injectable()
export class ProjectsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly storage: StorageService,
    @InjectQueue(EDIT_QUEUE) private readonly queue: Queue,
    private readonly media: MediaService,
  ) {}

  async list(ownerId: string): Promise<Project[]> {
    const rows = (
      await this.db
        .select()
        .from(projects)
        .where(eq(projects.ownerId, ownerId))
        .orderBy(desc(projects.updatedAt))
        .limit(200)
    ).map(toProject);
    if (!rows.length) return rows;
    const counts = await this.db
      .select({
        id: mediaAssets.projectId,
        total: sql<number>`count(*)::int`,
        processing: sql<number>`count(*) filter (where ${mediaAssets.status} in ('queued', 'processing'))::int`,
        failed: sql<number>`count(*) filter (where ${mediaAssets.status} = 'failed')::int`,
      })
      .from(mediaAssets)
      .where(
        and(
          eq(mediaAssets.removed, false),
          inArray(
            mediaAssets.projectId,
            rows.map((r) => r.id),
          ),
        ),
      )
      .groupBy(mediaAssets.projectId);
    const states = await this.db
      .select()
      .from(timelines)
      .where(
        inArray(
          timelines.projectId,
          rows.map((r) => r.id),
        ),
      );
    const jobs = await this.db
      .select()
      .from(editJobs)
      .where(
        inArray(
          editJobs.projectId,
          rows.map((r) => r.id),
        ),
      )
      .orderBy(desc(editJobs.createdAt));
    return rows.map((row) => {
      const values = counts.find((c) => c.id === row.id);
      const state = states.find((t) => t.projectId === row.id)?.state;
      const job = jobs.find((j) => j.projectId === row.id && j.plan.version !== 1);
      return {
        ...row,
        mediaCount: values?.total ?? 0,
        processingCount: values?.processing ?? 0,
        failedCount: values?.failed ?? 0,
        hasMainVideo: Boolean(state?.clips.length),
        durationFrames: state ? timelineFrames(state) : 0,
        timelineRevision: state?.revision ?? 0,
        latestJob: job
          ? {
              id: job.id,
              revision: job.revision,
              status: job.status,
              progress: job.progress,
              error: job.error,
            }
          : null,
      };
    });
  }

  async get(id: string, ownerId: string): Promise<Project> {
    const [row] = await this.db
      .select()
      .from(projects)
      .where(and(eq(projects.id, id), eq(projects.ownerId, ownerId)));
    if (!row) throw new NotFoundException('任务不存在');
    if (row.deleting) throw new ConflictException('任务正在删除，请重试删除');
    const [state] = await this.db.select().from(timelines).where(eq(timelines.projectId, id));
    const [job] = await this.db
      .select()
      .from(editJobs)
      .where(and(eq(editJobs.projectId, id), sql`${editJobs.revision} is not null`))
      .orderBy(desc(editJobs.createdAt))
      .limit(1);
    return {
      ...toProject(row),
      hasMainVideo: Boolean(state?.state.clips.length),
      durationFrames: state ? timelineFrames(state.state) : 0,
      timelineRevision: state?.state.revision ?? 0,
      latestJob: job
        ? {
            id: job.id,
            revision: job.revision,
            status: job.status,
            progress: job.progress,
            error: job.error,
          }
        : null,
    };
  }

  async create(input: CreateProjectInput, ownerId: string): Promise<Project> {
    const [row] = await this.db
      .insert(projects)
      .values({ ...input, ownerId })
      .returning();
    return toProject(row!);
  }

  async update(id: string, input: UpdateProjectInput, ownerId: string): Promise<Project> {
    await this.get(id, ownerId);
    const [row] = await this.db
      .update(projects)
      .set(input)
      .where(and(eq(projects.id, id), eq(projects.ownerId, ownerId), eq(projects.deleting, false)))
      .returning();
    if (!row) throw new ConflictException('任务已发生变化，请刷新后重试');
    return toProject(row);
  }

  async remove(id: string, ownerId: string): Promise<void> {
    // Workers claim and publish under this lock, but render outside it. The flag
    // fences late publication; their heartbeat aborts active processes during cleanup.
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`project:${id}`}))`);
      const [row] = await tx
        .select()
        .from(projects)
        .where(and(eq(projects.id, id), eq(projects.ownerId, ownerId)));
      if (!row) throw new NotFoundException('任务不存在');
      await tx.update(projects).set({ deleting: true }).where(eq(projects.id, id));
    });
    const jobs = await this.db.select().from(editJobs).where(eq(editJobs.projectId, id));
    for (const job of jobs) {
      await this.queueCleanup(async () => {
        for (const queueId of [`${job.id}-${job.generation}`, job.id]) {
          const queued = await this.queue.getJob(queueId);
          if (queued && !(await queued.isActive())) await queued.remove();
        }
      });
      if (job.outputKey) await this.storage.remove(job.outputKey);
      await this.storage.remove(`renders/${job.id}.manifest.json`);
      await this.storage.removeTree(`renders/${job.id}`);
    }
    await this.media.purgeProject(id);
    await this.db.delete(projects).where(and(eq(projects.id, id), eq(projects.ownerId, ownerId)));
  }

  private async queueCleanup(cleanup: () => Promise<void>) {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        cleanup(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('queue cleanup timeout')), 3000);
        }),
      ]);
    } catch {
      throw new ServiceUnavailableException('暂时无法清理生成任务，请重试删除');
    } finally {
      clearTimeout(timer);
    }
  }
}
