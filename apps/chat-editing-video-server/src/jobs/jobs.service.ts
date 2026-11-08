import { createHash, randomBytes } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { z } from 'zod';
import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  EditingErrorCodes,
  type CreateEditJobInput,
  type EditJob,
  type DirectRenderPlan,
} from '@cev/shared';
import { DB, type Database } from '../database/database.module.js';
import { editJobs, mediaAssets, projects, type EditJobRow } from '../database/schema.js';
import { EditingService } from '../editing/editing.service.js';
import { projectLock } from '../media/media-processing.service.js';
import { editingSource } from '../media/media-source.js';
import { StorageService } from '../storage/storage.service.js';
import { REDIS, ensureConnected } from '../redis/redis.module.js';
import { AuthService, type AuthSession } from '../auth/auth.service.js';
import { EDIT_QUEUE, type EditJobData } from './jobs.constants.js';
import { APP_CONFIG } from '../config/config.module.js';
import type { Env } from '../config/env.js';

export function toEditJob(row: EditJobRow): EditJob {
  return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

@Injectable()
export class JobsService implements OnApplicationBootstrap, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private recovering = false;
  private readonly logger = new Logger(JobsService.name);
  constructor(
    @Inject(DB) private readonly db: Database,
    @InjectQueue(EDIT_QUEUE) private readonly queue: Queue<EditJobData>,
    private readonly editing: EditingService,
    private readonly storage: StorageService,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly auth: AuthService,
    @Inject(APP_CONFIG) private readonly env: Env,
  ) {
    queue.on('error', () => {});
  }
  onApplicationBootstrap() {
    void this.queue.setGlobalConcurrency(1).catch(() => {});
    this.timer = setInterval(() => void this.recover(), 5000);
    this.timer.unref();
    void this.recover();
  }
  onModuleDestroy() {
    clearInterval(this.timer);
  }
  async create(input: CreateEditJobInput, ownerId: string): Promise<EditJob> {
    const row = await this.db.transaction(async (tx) => {
      const timeline = await this.editing.locked(tx, input.projectId, ownerId);
      if (timeline.revision !== input.expectedRevision)
        throw new ConflictException({
          code: EditingErrorCodes.timelineChanged,
          message: '剪辑版本已变化，请刷新后重新下载',
        });
      if (!timeline.clips.length || !timeline.canvas) throw new ConflictException('暂无主视频');
      const [old] = await tx
        .select()
        .from(editJobs)
        .where(
          and(eq(editJobs.projectId, input.projectId), eq(editJobs.revision, timeline.revision)),
        )
        .orderBy(desc(editJobs.createdAt))
        .limit(1);
      if (old) return old;
      const assets = await tx
        .select()
        .from(mediaAssets)
        .where(
          and(
            eq(mediaAssets.projectId, input.projectId),
            eq(mediaAssets.deleting, false),
            eq(mediaAssets.removed, false),
          ),
        );
      const clips = timeline.clips.map((c) => {
        const a = assets.find(
          (a) => a.id === c.source && a.generation === c.generation && a.status === 'ready',
        );
        const source = a && editingSource(a);
        if (!source) throw new ConflictException('来源素材已不可用');
        return {
          ...c,
          sourceKey: source.key,
          sourceMode: source.kind,
          hasAudio: source.info.hasAudio,
        };
      });
      const plan: DirectRenderPlan = {
        version: 3,
        revision: timeline.revision,
        clips,
        output: { container: 'mp4', ...timeline.canvas },
      };
      const [job] = await tx
        .insert(editJobs)
        .values({
          projectId: input.projectId,
          revision: timeline.revision,
          plan,
          queuePrefix: this.env.QUEUE_PREFIX,
        })
        .returning();
      return job!;
    });
    await this.enqueue(row).catch(() => {});
    return toEditJob(row);
  }
  async get(id: string, ownerId: string): Promise<EditJob> {
    const [row] = await this.db
      .select({ job: editJobs })
      .from(editJobs)
      .innerJoin(projects, eq(projects.id, editJobs.projectId))
      .where(and(eq(editJobs.id, id), eq(projects.ownerId, ownerId), eq(projects.deleting, false)));
    if (!row) throw new NotFoundException('生成任务不存在');
    return toEditJob(row.job);
  }
  async retry(id: string, ownerId: string) {
    const job = await this.get(id, ownerId);
    const row = await this.db.transaction(async (tx) => {
      await this.editing.locked(tx, job.projectId, ownerId);
      const [current] = await tx.select().from(editJobs).where(eq(editJobs.id, id));
      if (current!.plan.version === 1)
        throw new ConflictException('历史占位任务不能导出，请按当前剪辑重新生成');
      if (current!.status !== 'failed') return current!;
      for (const clip of current!.plan.clips)
        if (!(await this.storage.exists(clip.sourceKey)))
          throw new ConflictException('生成所需的处理文件缺失，请重新处理素材');
      const [row] = await tx
        .update(editJobs)
        .set({
          status: 'queued',
          progress: 0,
          error: null,
          executionId: null,
          heartbeatAt: null,
          generation: current!.generation + 1,
        })
        .where(eq(editJobs.id, id))
        .returning();
      return row!;
    });
    await this.enqueue(row).catch(() => {});
    return toEditJob(row);
  }
  private async enqueue(row: EditJobRow) {
    if (row.status !== 'queued') return;
    const id = `${row.id}-${row.generation}`;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.queue.add(
          'render',
          { jobId: row.id, generation: row.generation },
          { jobId: id, removeOnComplete: 100, removeOnFail: 100 },
        ),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('queue timeout')), 3000);
          timer.unref();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async recover() {
    if (this.recovering) return;
    this.recovering = true;
    try {
      const rows = await this.db
        .select()
        .from(editJobs)
        .where(
          and(
            eq(editJobs.queuePrefix, this.env.QUEUE_PREFIX),
            inArray(editJobs.status, ['queued', 'running']),
            sql`${editJobs.revision} is not null`,
          ),
        );
      for (const row of rows) {
        const [project] = await this.db
          .select()
          .from(projects)
          .where(and(eq(projects.id, row.projectId), eq(projects.deleting, false)));
        if (!project) continue;
        if (row.status === 'queued') await this.enqueue(row);
        else if (!row.heartbeatAt || row.heartbeatAt.getTime() < Date.now() - 60000) {
          await this.db.transaction(async (tx) => {
            await tx.execute(projectLock(row.projectId));
            await tx
              .update(editJobs)
              .set({
                status: 'queued',
                executionId: null,
                heartbeatAt: null,
                generation: row.generation + 1,
                progress: 0,
              })
              .where(
                and(
                  eq(editJobs.id, row.id),
                  eq(editJobs.status, 'running'),
                  eq(editJobs.generation, row.generation),
                  sql`(${editJobs.heartbeatAt} is null or ${editJobs.heartbeatAt} < now() - interval '60 seconds')`,
                ),
              );
          });
        }
      }
      // A terminated FFmpeg process may leave scratch segments. Only the active
      // attempt (or the published output) is retained; failed cleanup retries.
      const completed = await this.db
        .select()
        .from(editJobs)
        .where(
          and(
            eq(editJobs.queuePrefix, this.env.QUEUE_PREFIX),
            inArray(editJobs.status, ['succeeded', 'failed']),
            sql`${editJobs.revision} is not null`,
          ),
        );
      for (const row of completed) {
        const prefix = `renders/${row.id}`;
        const attempts = await readdir(this.storage.resolve(prefix)).catch(() => []);
        // List before reading the current claim: a newly created attempt cannot
        // be mistaken for stale scratch even if a retry starts during cleanup.
        const [current] = await this.db.select().from(editJobs).where(eq(editJobs.id, row.id));
        const keep =
          current && ['running', 'succeeded'].includes(current.status) ? current.executionId : null;
        for (const attempt of attempts)
          if (attempt !== keep && z.uuid().safeParse(attempt).success)
            await this.storage.removeTree(`${prefix}/${attempt}`).catch(() => {});
      }
    } catch (error) {
      this.logger.debug(`生成队列等待恢复: ${error instanceof Error ? error.message : 'unknown'}`);
    } finally {
      this.recovering = false;
    }
  }
  async ticket(id: string, session: AuthSession) {
    const job = await this.get(id, session.user.id);
    if (job.status !== 'succeeded' || job.plan.version === 1 || !job.outputKey)
      throw new ConflictException({
        code: EditingErrorCodes.renderNotReady,
        message: '成品尚未生成完成',
      });
    const token = randomBytes(32).toString('base64url');
    await ensureConnected(this.redis);
    await this.redis.set(
      `cev:download:${createHash('sha256').update(token).digest('hex')}`,
      JSON.stringify({ jobId: id, sessionId: session.id }),
      'EX',
      300,
    );
    return token;
  }
  async ticketSession(id: string, token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new NotFoundException({
        code: EditingErrorCodes.downloadCredentialInvalid,
        message: '下载凭据已失效，请重新点击下载',
      });
    await ensureConnected(this.redis);
    const value = await this.redis.get(
      `cev:download:${createHash('sha256').update(token).digest('hex')}`,
    );
    if (!value)
      throw new NotFoundException({
        code: EditingErrorCodes.downloadCredentialInvalid,
        message: '下载凭据已失效，请重新点击下载',
      });
    const ticket = JSON.parse(value) as { jobId: string; sessionId: string };
    if (ticket.jobId !== id)
      throw new NotFoundException({
        code: EditingErrorCodes.downloadCredentialInvalid,
        message: '下载凭据不属于此成品',
      });
    return this.auth.authenticateId(ticket.sessionId);
  }
}
