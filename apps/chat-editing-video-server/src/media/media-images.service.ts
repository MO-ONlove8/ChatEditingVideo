import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, stat, utimes } from 'node:fs/promises';
import path from 'node:path';
import { BadRequestException, ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { ImageIndex } from '@cev/shared';
import { MediaService } from './media.service.js';
import { StorageService } from '../storage/storage.service.js';
import { MediaTools } from './media-tools.service.js';
import { DB, type Database } from '../database/database.module.js';
import { mediaAssets, projects } from '../database/schema.js';
import { projectLock } from './media-processing.service.js';
import { editingSource } from './media-source.js';

@Injectable()
export class MediaImages {
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly failures = new Map<string, string>();
  private running = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly logger = new Logger(MediaImages.name);
  private trimming = false;
  constructor(
    private readonly media: MediaService,
    private readonly storage: StorageService,
    private readonly tools: MediaTools,
    @Inject(DB) private readonly db: Database,
  ) {}
  private imagePath(id: string, name: string, generation: number) {
    return `/media/${id}/images/${name}?generation=${generation}`;
  }
  private async ready(id: string, owner: string) {
    const asset = await this.media.get(id, owner);
    const source = editingSource(asset);
    if (asset.status !== 'ready' || !source?.info.frameCount)
      throw new ConflictException('素材处理完成后才能查看帧图');
    return { ...asset, source };
  }
  async thumbnails(id: string, owner: string, page: number): Promise<ImageIndex> {
    const asset = await this.ready(id, owner);
    const count = asset.source.info.frameCount!;
    if (!Number.isInteger(page) || page < 0 || page * 900 >= count)
      throw new BadRequestException('缩略图页不存在');
    const legacy = `${asset.derivedPrefix}/thumb-${page}.jpg`;
    const prefix = `.cache/${id}/${asset.generation}/thumb-${page}`;
    if (
      !(asset.derivedPrefix && (await this.storage.exists(legacy))) &&
      !(await this.storage.exists(`${prefix}/thumb-${page}.jpg`))
    ) {
      const key = `${id}:${asset.generation}:thumb:${page}`;
      const failure = this.failures.get(key);
      if (failure) {
        this.failures.delete(key);
        throw new ConflictException(failure);
      }
      if (!this.jobs.has(key))
        this.jobs.set(
          key,
          this.generate(asset, 0, count, prefix, undefined, page)
            .catch((error: unknown) => {
              this.failures.set(key, error instanceof Error ? error.message : '缩略图生成失败');
            })
            .finally(() => this.jobs.delete(key)),
        );
      return { status: 'processing', generation: asset.generation, images: [] };
    }
    return {
      status: 'ready',
      generation: asset.generation,
      images: Array.from(
        { length: Math.min(30, Math.ceil((count - page * 900) / 30)) },
        (_, i) => ({
          frame: page * 900 + i * 30,
          path: this.imagePath(id, `thumb-${page}.jpg`, asset.generation),
        }),
      ),
      sprite: {
        path: this.imagePath(id, `thumb-${page}.jpg`, asset.generation),
        width: 160,
        height: 90,
        columns: 10,
      },
    };
  }
  async frames(id: string, owner: string, second: number): Promise<ImageIndex> {
    const asset = await this.ready(id, owner);
    if (!Number.isInteger(second) || second < 0 || second * 30 >= asset.source.info.frameCount!)
      throw new BadRequestException('秒数超出素材范围');
    const count = Math.min(30, asset.source.info.frameCount! - second * 30);
    const prefix = `.cache/${id}/${asset.generation}/second-${second}`;
    const images = Array.from({ length: count }, (_, i) => ({
      frame: second * 30 + i,
      path: this.imagePath(id, `second-${second}-${i}.jpg`, asset.generation),
    }));
    if (
      (await Promise.all(images.map((_, i) => this.storage.exists(`${prefix}/${i}.jpg`)))).every(
        Boolean,
      )
    )
      return { status: 'ready', generation: asset.generation, images };
    const key = `${id}:${asset.generation}:second:${second}`;
    const failure = this.failures.get(key);
    if (failure) {
      this.failures.delete(key);
      throw new ConflictException(failure);
    }
    if (!this.jobs.has(key)) {
      const job = this.generate(asset, second, count, prefix)
        .catch((error) => {
          this.failures.set(key, error instanceof Error ? error.message : '帧图生成失败，请重试');
        })
        .finally(() => {
          this.jobs.delete(key);
        });
      this.jobs.set(key, job);
    }
    return { status: 'processing', generation: asset.generation, images: [] };
  }
  private async slot<T>(callback: () => Promise<T>) {
    if (this.waiters.length >= 32) throw new ConflictException('图片请求较多，请稍后重试');
    if (this.running >= 2) await new Promise<void>((resolve) => this.waiters.push(resolve));
    else this.running++;
    try {
      return await callback();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.running--;
    }
  }
  private async generate(
    asset: Awaited<ReturnType<MediaImages['ready']>>,
    second: number,
    count: number,
    prefix: string,
    fullFrame?: number,
    thumbPage?: number,
  ) {
    await this.slot(async () => {
      const work = `.work/${randomUUID()}`;
      const abort = new AbortController();
      const check = async () => {
        const [row] = await this.db
          .select({ asset: mediaAssets, project: projects })
          .from(mediaAssets)
          .innerJoin(projects, eq(projects.id, mediaAssets.projectId))
          .where(eq(mediaAssets.id, asset.id));
        if (
          !row ||
          row.asset.deleting ||
          row.asset.removed ||
          row.project.deleting ||
          row.asset.generation !== asset.generation
        )
          abort.abort();
      };
      const timer = setInterval(() => void check().catch(() => abort.abort()), 1000);
      try {
        await check();
        abort.signal.throwIfAborted();
        await mkdir(this.storage.resolve(work), { recursive: true });
        if (thumbPage !== undefined)
          await this.tools.thumbnails(
            this.storage.resolve(asset.source.key),
            this.storage.resolve(work),
            count,
            abort.signal,
            thumbPage,
          );
        else
          await this.tools.run(
            this.tools.env.FFMPEG_PATH,
            [
              '-hide_banner',
              '-loglevel',
              'error',
              '-nostdin',
              '-y',
              '-ss',
              String(second),
              '-i',
              this.storage.resolve(asset.source.key),
              '-an',
              '-vf',
              fullFrame === undefined ? 'scale=320:-2' : `select=eq(n\\,${fullFrame % 30})`,
              '-fps_mode',
              'passthrough',
              '-frames:v',
              String(count),
              '-q:v',
              '2',
              '-threads',
              '1',
              '-start_number',
              '0',
              this.storage.resolve(`${work}/%d.jpg`),
            ],
            abort.signal,
          );
        await this.db.transaction(async (tx) => {
          await tx.execute(projectLock(asset.projectId));
          const [current] = await tx
            .select({ asset: mediaAssets, project: projects })
            .from(mediaAssets)
            .innerJoin(projects, eq(projects.id, mediaAssets.projectId))
            .where(and(eq(mediaAssets.id, asset.id), eq(mediaAssets.generation, asset.generation)));
          if (
            !current ||
            current.asset.deleting ||
            current.asset.removed ||
            current.project.deleting
          )
            throw new Error('素材已删除或发生变化');
          await mkdir(path.dirname(this.storage.resolve(prefix)), { recursive: true });
          await this.storage.removeTree(prefix);
          await rename(this.storage.resolve(work), this.storage.resolve(prefix));
        });
        await this.trimCache();
      } finally {
        clearInterval(timer);
        await this.storage.removeTree(work);
      }
    });
  }
  async fullFrame(id: string, owner: string, frame: number) {
    const asset = await this.ready(id, owner);
    if (!Number.isInteger(frame) || frame < 0 || frame >= asset.source.info.frameCount!)
      throw new BadRequestException('帧位置超出素材范围');
    const prefix = `.cache/${id}/${asset.generation}/frame-${frame}`;
    if (!(await this.storage.exists(`${prefix}/0.jpg`))) {
      const key = `${id}:${asset.generation}:frame:${frame}`;
      if (!this.jobs.has(key))
        this.jobs.set(
          key,
          this.generate(asset, Math.floor(frame / 30), 1, prefix, frame).finally(() =>
            this.jobs.delete(key),
          ),
        );
      await this.jobs.get(key);
    }
    return `${prefix}/0.jpg`;
  }
  async image(id: string, owner: string, name: string, generation: number) {
    const asset = await this.ready(id, owner);
    if (generation !== asset.generation) throw new ConflictException('素材已更新，请重新加载');
    if (/^thumb-\d+\.jpg$/.test(name)) {
      const legacy = `${asset.derivedPrefix}/${name}`;
      if (asset.derivedPrefix && (await this.storage.exists(legacy))) return legacy;
      return `.cache/${id}/${generation}/${name.slice(0, -4)}/${name}`;
    }
    const match = /^second-(\d+)-(\d+)\.jpg$/.exec(name);
    if (!match || Number(match[2]) >= 30) throw new BadRequestException('图片不存在');
    return `.cache/${id}/${generation}/second-${Number(match[1])}/${Number(match[2])}.jpg`;
  }
  async touch(key: string) {
    await utimes(this.storage.resolve(key), new Date(), new Date()).catch(() => {});
  }
  private async trimCache() {
    if (this.trimming) return;
    this.trimming = true;
    try {
      const files: Array<{ key: string; size: number; used: number }> = [];
      const walk = async (key: string) => {
        for (const entry of await readdir(this.storage.resolve(key), { withFileTypes: true }).catch(
          () => [],
        )) {
          const child = `${key}/${entry.name}`;
          if (entry.isDirectory()) await walk(child);
          else if (entry.isFile()) {
            const data = await stat(this.storage.resolve(child));
            files.push({ key: child, size: data.size, used: data.atimeMs });
          }
        }
      };
      await walk('.cache');
      let total = files.reduce((sum, file) => sum + file.size, 0);
      const limit = this.tools.env.MEDIA_CACHE_MB * 1024 * 1024;
      for (const file of files.sort((a, b) => a.used - b.used)) {
        if (total <= limit) break;
        await this.storage.remove(file.key);
        total -= file.size;
      }
    } catch (error) {
      this.logger.warn(`帧缓存清理失败: ${String(error)}`);
    } finally {
      this.trimming = false;
    }
  }
}
