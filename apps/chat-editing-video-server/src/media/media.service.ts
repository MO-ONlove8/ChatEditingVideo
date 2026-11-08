import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { and, asc, count, eq, inArray, lt, sql } from 'drizzle-orm';
import {
  EditingErrorCodes,
  MediaAssetSchema,
  UploadSchema,
  type CreateUploadsInput,
  type MediaAsset,
} from '@cev/shared';
import { DB, type Database } from '../database/database.module.js';
import {
  editJobs,
  mediaAssets,
  mediaRuns,
  projects,
  uploadContexts,
  uploads,
  timelines,
  proposals,
  chatTurns,
  type MediaAssetRow,
} from '../database/schema.js';
import { StorageService } from '../storage/storage.service.js';
import { MediaTools } from './media-tools.service.js';
import { MediaProcessing, projectLock } from './media-processing.service.js';
import { APP_CONFIG } from '../config/config.module.js';
import type { Env } from '../config/env.js';

export function toMediaAsset(row: MediaAssetRow): MediaAsset {
  return MediaAssetSchema.parse({ ...row, createdAt: row.createdAt.toISOString() });
}
const activeUploads = ['pending', 'uploading', 'validating'];
const ownerLock = (id: string) => sql`select pg_advisory_xact_lock(hashtext(${`uploads:${id}`}))`;
const beijingName = () =>
  `剪辑任务 ${new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date())}`;

@Injectable()
export class MediaService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly active = new Map<string, AbortController>();
  private timer?: NodeJS.Timeout;
  private cleaning = false;
  private readonly logger = new Logger(MediaService.name);
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly storage: StorageService,
    private readonly tools: MediaTools,
    private readonly processing: MediaProcessing,
    @Inject(APP_CONFIG) private readonly env: Env,
  ) {}
  onApplicationBootstrap() {
    this.timer = setInterval(() => void this.cleanup(), 60_000);
    this.timer.unref();
    void this.cleanup();
  }
  async onModuleDestroy() {
    clearInterval(this.timer);
    for (const controller of this.active.values()) controller.abort();
    const deadline = Date.now() + 5000;
    while (this.active.size && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 25));
  }
  policy() {
    return {
      maxBatch: 3,
      maxAssets: this.env.MEDIA_MAX_ASSETS,
      maxBytes: this.env.UPLOAD_MAX_MB * 1024 * 1024,
      fps: 30 as const,
    };
  }
  async assertProject(id: string, ownerId: string) {
    const [row] = await this.db
      .select()
      .from(projects)
      .where(and(eq(projects.id, id), eq(projects.ownerId, ownerId)));
    if (!row) throw new NotFoundException('任务不存在');
    if (row.deleting) throw new ConflictException('任务正在删除');
    return row;
  }
  async list(projectId: string, ownerId: string): Promise<MediaAsset[]> {
    await this.assertProject(projectId, ownerId);
    return (
      await this.db
        .select()
        .from(mediaAssets)
        .where(and(eq(mediaAssets.projectId, projectId), eq(mediaAssets.removed, false)))
        .orderBy(asc(mediaAssets.number))
    ).map(toMediaAsset);
  }
  async get(id: string, ownerId: string, includeDeleting = false) {
    const [row] = await this.db
      .select({ asset: mediaAssets })
      .from(mediaAssets)
      .innerJoin(projects, eq(projects.id, mediaAssets.projectId))
      .where(
        and(
          eq(mediaAssets.id, id),
          eq(projects.ownerId, ownerId),
          eq(projects.deleting, false),
          eq(mediaAssets.removed, false),
          includeDeleting ? undefined : eq(mediaAssets.deleting, false),
        ),
      );
    if (!row) throw new NotFoundException('素材不存在');
    return row.asset;
  }
  async upload(id: string, ownerId: string) {
    const [row] = await this.db
      .select({ upload: uploads, context: uploadContexts })
      .from(uploads)
      .innerJoin(uploadContexts, eq(uploadContexts.id, uploads.contextId))
      .where(and(eq(uploads.id, id), eq(uploadContexts.ownerId, ownerId)));
    if (!row) throw new NotFoundException('上传不存在');
    return row;
  }
  async uploadResult(id: string, ownerId: string) {
    const { upload, context } = await this.upload(id, ownerId);
    const asset = upload.assetId ? await this.get(upload.assetId, ownerId).catch(() => null) : null;
    return UploadSchema.parse({
      ...upload,
      projectId: context.projectId,
      asset: asset ? toMediaAsset(asset) : null,
    });
  }
  async createUploads(input: CreateUploadsInput, ownerId: string) {
    if (new Set(input.files.map((f) => f.id)).size !== input.files.length)
      throw new BadRequestException('上传标识重复');
    if (input.files.some((f) => !/\.(mp4|mov)$/i.test(f.fileName)))
      throw new BadRequestException('仅支持 MP4 / MOV');
    if (input.files.some((f) => f.sizeBytes > this.policy().maxBytes))
      throw new BadRequestException(`单文件最大 ${this.env.UPLOAD_MAX_MB} MB`);
    await this.db.transaction(async (tx) => {
      await tx.execute(ownerLock(ownerId));
      if (input.projectId) {
        await tx.execute(projectLock(input.projectId));
        await this.assertProject(input.projectId, ownerId);
      }
      const [existing] = await tx
        .select()
        .from(uploadContexts)
        .where(eq(uploadContexts.id, input.contextId));
      if (
        existing &&
        (existing.ownerId !== ownerId ||
          (input.projectId && existing.projectId !== input.projectId))
      )
        throw new NotFoundException('上传上下文不存在');
      if (!existing)
        await tx
          .insert(uploadContexts)
          .values({ id: input.contextId, ownerId, projectId: input.projectId });
      const projectId = existing?.projectId ?? input.projectId;
      if (projectId) await this.assertProject(projectId, ownerId);
      const previous = await tx
        .select()
        .from(uploads)
        .where(
          inArray(
            uploads.id,
            input.files.map((f) => f.id),
          ),
        );
      for (const old of previous) {
        const file = input.files.find((f) => f.id === old.id)!;
        if (
          old.contextId !== input.contextId ||
          old.fileName !== file.fileName ||
          old.sizeBytes !== file.sizeBytes
        )
          throw new ConflictException('上传标识已被使用');
      }
      const [assets] = projectId
        ? await tx
            .select({ n: count() })
            .from(mediaAssets)
            .where(and(eq(mediaAssets.projectId, projectId), eq(mediaAssets.removed, false)))
        : [{ n: 0 }];
      const [reserved] = await tx
        .select({ n: count() })
        .from(uploads)
        .innerJoin(uploadContexts, eq(uploads.contextId, uploadContexts.id))
        .where(
          and(
            projectId
              ? eq(uploadContexts.projectId, projectId)
              : eq(uploadContexts.id, input.contextId),
            inArray(uploads.status, activeUploads),
          ),
        );
      const fresh = input.files.filter((f) => !previous.some((p) => p.id === f.id));
      if (assets!.n + reserved!.n + fresh.length > this.env.MEDIA_MAX_ASSETS)
        throw new BadRequestException(
          `每个任务最多 ${this.env.MEDIA_MAX_ASSETS} 个素材（包含上传中）`,
        );
      if (fresh.length)
        await tx
          .insert(uploads)
          .values(fresh.map((file) => ({ ...file, contextId: input.contextId })));
    });
    return Promise.all(input.files.map((f) => this.uploadResult(f.id, ownerId)));
  }
  async receive(id: string, source: Readable, ownerId: string) {
    const initial = await this.upload(id, ownerId);
    if (initial.upload.status === 'saved') {
      source.resume();
      return this.uploadResult(id, ownerId);
    }
    const [claimed] = await this.db
      .update(uploads)
      .set({ status: 'uploading', error: null })
      .where(and(eq(uploads.id, id), eq(uploads.status, 'pending')))
      .returning();
    if (!claimed) throw new ConflictException('上传已在进行或已取消，请查询上传状态');
    const abort = new AbortController();
    this.active.set(id, abort);
    const prefix = `.tmp/uploads/${id}`;
    const temp = `${prefix}/${randomUUID()}.part`;
    let stored: string | undefined;
    let committed = false;
    const timer = setInterval(() => {
      void this.upload(id, ownerId)
        .then((row) => {
          if (row.upload.status === 'cancelled') abort.abort();
        })
        .catch(() => abort.abort());
    }, 1000);
    try {
      await mkdir(this.storage.resolve(prefix), { recursive: true });
      let bytes = 0;
      const maxBytes = Math.min(claimed.sizeBytes, this.policy().maxBytes);
      const limit = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          callback(
            bytes > maxBytes ? new BadRequestException('文件大小超过限制或与声明不符') : null,
            chunk,
          );
        },
      });
      await pipeline(source, limit, createWriteStream(this.storage.resolve(temp)), {
        signal: abort.signal,
      });
      if (bytes !== claimed.sizeBytes) throw new BadRequestException('上传不完整，请重新上传');
      const [validating] = await this.db
        .update(uploads)
        .set({ status: 'validating' })
        .where(and(eq(uploads.id, id), eq(uploads.status, 'uploading')))
        .returning();
      if (!validating) throw new Error('上传已取消');
      const info = await this.tools.probe(this.storage.resolve(temp), false, abort.signal);
      await this.db.transaction(async (tx) => {
        await tx.execute(ownerLock(ownerId));
        const [current] = await tx.select().from(uploads).where(eq(uploads.id, id));
        if (!current || current.status !== 'validating' || abort.signal.aborted)
          throw new Error('上传已取消');
        const [context] = await tx
          .select()
          .from(uploadContexts)
          .where(eq(uploadContexts.id, claimed.contextId));
        if (!context) throw new Error('上传已取消');
        let projectId = context.projectId;
        if (!projectId) {
          const [project] = await tx
            .insert(projects)
            .values({ ownerId, name: beijingName() })
            .returning();
          projectId = project!.id;
          await tx
            .update(uploadContexts)
            .set({ projectId })
            .where(eq(uploadContexts.id, context.id));
        }
        await tx.execute(projectLock(projectId));
        const [project] = await tx
          .select()
          .from(projects)
          .where(
            and(
              eq(projects.id, projectId),
              eq(projects.ownerId, ownerId),
              eq(projects.deleting, false),
            ),
          );
        if (!project) throw new NotFoundException('任务不存在');
        const assetId = randomUUID();
        stored = `projects/${projectId}/media/${assetId}${claimed.fileName.toLowerCase().endsWith('.mov') ? '.mov' : '.mp4'}`;
        await this.storage.moveIn(this.storage.resolve(temp), stored);
        await tx.insert(mediaAssets).values({
          id: assetId,
          projectId,
          number: project.nextMediaNumber,
          fileName: claimed.fileName,
          mimeType: claimed.fileName.toLowerCase().endsWith('.mov')
            ? 'video/quicktime'
            : 'video/mp4',
          sizeBytes: bytes,
          storageKey: stored,
          original: info,
        });
        await tx
          .insert(mediaRuns)
          .values({ assetId, generation: 1, queuePrefix: this.env.QUEUE_PREFIX });
        await tx
          .update(projects)
          .set({ nextMediaNumber: project.nextMediaNumber + 1, updatedAt: new Date() })
          .where(eq(projects.id, projectId));
        await tx.update(uploads).set({ status: 'saved', assetId }).where(eq(uploads.id, id));
      });
      committed = true;
      const result = await this.uploadResult(id, ownerId);
      if (result.asset) await this.processing.enqueueAsset(result.asset.id).catch(() => {});
      return result;
    } catch (error) {
      if (stored && !committed) await this.storage.remove(stored);
      await this.db
        .update(uploads)
        .set({
          status: 'failed',
          error: error instanceof Error ? error.message : '上传失败，请重试',
        })
        .where(and(eq(uploads.id, id), inArray(uploads.status, ['uploading', 'validating'])));
      throw error;
    } finally {
      clearInterval(timer);
      this.active.delete(id);
      await this.storage.removeTree(prefix);
    }
  }
  async cancel(id: string, ownerId: string) {
    await this.upload(id, ownerId);
    await this.db.transaction(async (tx) => {
      await tx.execute(ownerLock(ownerId));
      await tx
        .update(uploads)
        .set({ status: 'cancelled' })
        .where(and(eq(uploads.id, id), inArray(uploads.status, [...activeUploads, 'failed'])));
    });
    this.active.get(id)?.abort();
    return this.uploadResult(id, ownerId);
  }
  async ingest(projectId: string, file: Express.Multer.File, ownerId: string): Promise<MediaAsset> {
    const id = randomUUID();
    try {
      await this.createUploads(
        {
          contextId: randomUUID(),
          projectId,
          files: [{ id, fileName: file.originalname, sizeBytes: file.size }],
        },
        ownerId,
      );
      return (await this.receive(id, createReadStream(file.path), ownerId)).asset!;
    } finally {
      await rm(file.path, { force: true });
    }
  }
  async retry(id: string, ownerId: string) {
    const asset = await this.get(id, ownerId);
    await this.db.transaction(async (tx) => {
      await tx.execute(projectLock(asset.projectId));
      const [current] = await tx
        .select()
        .from(mediaAssets)
        .where(and(eq(mediaAssets.id, id), eq(mediaAssets.deleting, false)));
      if (!current || current.status !== 'failed')
        throw new ConflictException('仅处理失败的素材可以重试');
      const [project] = await tx
        .select()
        .from(projects)
        .where(and(eq(projects.id, asset.projectId), eq(projects.deleting, false)));
      if (!project) throw new ConflictException('任务正在删除');
      await tx
        .update(mediaAssets)
        .set({
          status: 'queued',
          stage: '等待处理',
          error: null,
          progress: 0,
          generation: current.generation + 1,
        })
        .where(eq(mediaAssets.id, id));
      await tx.insert(mediaRuns).values({
        assetId: id,
        generation: current.generation + 1,
        queuePrefix: this.env.QUEUE_PREFIX,
      });
    });
    await this.processing.enqueueAsset(id).catch(() => {});
    return toMediaAsset(await this.get(id, ownerId));
  }
  async remove(id: string, ownerId: string) {
    const asset = await this.get(id, ownerId, true);
    await this.db.transaction(async (tx) => {
      await tx.execute(projectLock(asset.projectId));
      const [timeline] = await tx
        .select()
        .from(timelines)
        .where(eq(timelines.projectId, asset.projectId));
      if (timeline?.state.clips.some((c) => c.source === id))
        throw new ConflictException({
          code: EditingErrorCodes.mediaReferenced,
          message: '素材仍被时间轴片段引用，请先删除相关片段',
        });
      const cards = await tx
        .update(proposals)
        .set({ status: 'invalid' })
        .where(
          and(
            eq(proposals.projectId, asset.projectId),
            eq(proposals.status, 'pending'),
            sql`${proposals.previewClip}->>'source' = ${id}`,
          ),
        )
        .returning({ turnId: proposals.turnId });
      if (cards.length)
        await tx
          .update(chatTurns)
          .set({ status: 'done' })
          .where(
            inArray(
              chatTurns.id,
              cards.map((c) => c.turnId),
            ),
          );
      const jobs = await tx
        .select()
        .from(editJobs)
        .where(
          and(
            eq(editJobs.projectId, asset.projectId),
            inArray(editJobs.status, ['queued', 'running', 'failed']),
          ),
        );
      const pinned = jobs.some(
        (j) => j.plan.version !== 1 && j.plan.clips.some((c) => c.source === id),
      );
      if (pinned) {
        // Retain every immutable source until all export snapshots release it.
        await this.storage.removeTree(`.cache/${asset.id}`);
        await tx.update(mediaAssets).set({ removed: true }).where(eq(mediaAssets.id, id));
        return;
      }
      await tx.update(mediaAssets).set({ deleting: true }).where(eq(mediaAssets.id, id));
    });
    const [current] = await this.db.select().from(mediaAssets).where(eq(mediaAssets.id, id));
    if (current?.removed) {
      await this.db
        .update(projects)
        .set({ updatedAt: new Date() })
        .where(eq(projects.id, asset.projectId));
      return;
    }
    try {
      await this.purge(asset);
    } catch (error) {
      await this.db
        .update(mediaAssets)
        .set({
          status: 'failed',
          stage: '删除未完成',
          error: '文件暂时无法清理，请重试删除',
        })
        .where(eq(mediaAssets.id, id));
      throw error;
    }
    await this.db
      .update(projects)
      .set({ updatedAt: new Date() })
      .where(eq(projects.id, asset.projectId));
  }
  async purge(asset: MediaAssetRow) {
    this.processing.cancel(asset.id);
    await this.storage.remove(asset.storageKey);
    await this.storage.removeTree(`projects/${asset.projectId}/derived/${asset.id}`);
    await this.storage.removeTree(`.cache/${asset.id}`);
    await this.db.delete(mediaAssets).where(eq(mediaAssets.id, asset.id));
  }
  async cleanupRemoved(projectId: string) {
    const hidden = await this.db
      .select()
      .from(mediaAssets)
      .where(and(eq(mediaAssets.projectId, projectId), eq(mediaAssets.removed, true)));
    for (const asset of hidden) {
      await this.db.transaction(async (tx) => {
        await tx.execute(projectLock(projectId));
        const jobs = await tx
          .select()
          .from(editJobs)
          .where(
            and(
              eq(editJobs.projectId, projectId),
              inArray(editJobs.status, ['queued', 'running', 'failed']),
            ),
          );
        if (
          !jobs.some((j) => j.plan.version !== 1 && j.plan.clips.some((c) => c.source === asset.id))
        )
          await this.purge(asset);
      });
    }
  }
  async purgeProject(projectId: string) {
    const pending = await this.db
      .select({ id: uploads.id })
      .from(uploads)
      .innerJoin(uploadContexts, eq(uploads.contextId, uploadContexts.id))
      .where(eq(uploadContexts.projectId, projectId));
    for (const item of pending) this.active.get(item.id)?.abort();
    if (pending.length)
      await this.db
        .update(uploads)
        .set({ status: 'cancelled' })
        .where(
          and(
            inArray(
              uploads.id,
              pending.map((u) => u.id),
            ),
            inArray(uploads.status, activeUploads),
          ),
        );
    for (const asset of await this.db
      .select()
      .from(mediaAssets)
      .where(eq(mediaAssets.projectId, projectId)))
      await this.purge(asset);
  }
  private async cleanup() {
    if (this.cleaning) return;
    this.cleaning = true;
    try {
      const removed = await this.db
        .select({ projectId: mediaAssets.projectId })
        .from(mediaAssets)
        .where(eq(mediaAssets.removed, true));
      for (const id of new Set(removed.map((a) => a.projectId))) await this.cleanupRemoved(id);
      const stale = await this.db
        .select()
        .from(uploads)
        .where(
          and(
            lt(uploads.updatedAt, new Date(Date.now() - 24 * 3600_000)),
            inArray(uploads.status, [...activeUploads, 'failed', 'cancelled']),
          ),
        );
      for (const item of stale) {
        this.active.get(item.id)?.abort();
        await this.db
          .update(uploads)
          .set({ status: 'cancelled', error: '临时上传已过期，请重新选择文件' })
          .where(eq(uploads.id, item.id));
        await this.storage.removeTree(`.tmp/uploads/${item.id}`);
      }
    } catch (error) {
      this.logger.warn(`临时上传清理失败: ${String(error)}`);
    } finally {
      this.cleaning = false;
    }
  }
}
