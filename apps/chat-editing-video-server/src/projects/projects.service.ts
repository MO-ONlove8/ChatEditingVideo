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
import type { CreateProjectInput, Project, UpdateProjectInput } from '@cev/shared';
import { DB, type Database } from '../database/database.module.js';
import { editJobs, projects, mediaAssets, type ProjectRow } from '../database/schema.js';
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
        inArray(
          mediaAssets.projectId,
          rows.map((r) => r.id),
        ),
      )
      .groupBy(mediaAssets.projectId);
    return rows.map((row) => {
      const values = counts.find((c) => c.id === row.id);
      return {
        ...row,
        mediaCount: values?.total ?? 0,
        processingCount: values?.processing ?? 0,
        failedCount: values?.failed ?? 0,
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
    return toProject(row);
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
    // The worker holds the same lock while writing output. No new worker or upload
    // can commit after this flag is set. Failed cleanup remains retryable.
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
        const queued = await this.queue.getJob(job.id);
        if (queued && !(await queued.isActive())) await queued.remove();
      });
      if (job.outputKey) await this.storage.remove(job.outputKey);
      await this.storage.remove(`renders/${job.id}.manifest.json`);
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
