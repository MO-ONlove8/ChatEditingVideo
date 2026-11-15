import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import {
  applyOperation,
  emptyPackaging,
  packagingImpacts,
  timelineFrames,
  formatTimecode,
  type CompositionState,
} from '@cev/shared';
import { DB, type Database } from '../database/database.module.js';
import {
  chatTurns,
  compositions,
  mediaAssets,
  projects,
  proposals,
  timelines,
  editJobs,
} from '../database/schema.js';
import { toMediaAsset } from '../media/media.service.js';
import { CompositionEngine } from './composition-engine.service.js';
import { APP_CONFIG } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { StorageService } from '../storage/storage.service.js';
export const COMPOSITION_QUEUE = 'compositions';
export type CompositionWork = { kind: 'candidate' | 'formal'; id: string; generation: number };
@Injectable()
export class CompositionService implements OnApplicationBootstrap, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private recovering = false;
  private lastPruned = 0;
  private active = new Map<string, Set<AbortController>>();
  private logger = new Logger(CompositionService.name);
  constructor(
    @Inject(DB) private readonly db: Database,
    @InjectQueue(COMPOSITION_QUEUE) private readonly queue: Queue<CompositionWork>,
    private readonly engine: CompositionEngine,
    private readonly storage: StorageService,
    @Inject(APP_CONFIG) private readonly env: Env,
  ) {
    queue.on('error', () => {});
  }
  onApplicationBootstrap() {
    if (!this.env.JOBS_WORKER_ENABLED) return;
    void this.queue.setGlobalConcurrency(1).catch(() => {});
    void this.recover();
    this.timer = setInterval(() => void this.recover(), 5000);
    this.timer.unref();
  }
  onModuleDestroy() {
    clearInterval(this.timer);
    for (const set of this.active.values()) for (const a of set) a.abort();
  }
  async cancelProject(id: string) {
    for (const a of this.active.get(id) ?? []) a.abort();
    const deadline = Date.now() + 10000;
    while (this.active.get(id)?.size && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 25));
  }
  async assertProject(id: string, ownerId: string) {
    const [p] = await this.db
      .select()
      .from(projects)
      .where(and(eq(projects.id, id), eq(projects.ownerId, ownerId), eq(projects.deleting, false)));
    if (!p) throw new NotFoundException('任务不存在');
    return p;
  }
  async assets(id: string) {
    return (
      await this.db
        .select()
        .from(mediaAssets)
        .where(and(eq(mediaAssets.projectId, id), eq(mediaAssets.deleting, false)))
    ).map(toMediaAsset);
  }
  async state(id: string, revision: number): Promise<CompositionState | null> {
    const [row] = await this.db
      .select()
      .from(compositions)
      .where(and(eq(compositions.projectId, id), eq(compositions.revision, revision)));
    return row
      ? {
          status: row.status as CompositionState['status'],
          revision: row.revision,
          error: row.error,
          manifest: row.manifest,
        }
      : null;
  }
  async retry(id: string, ownerId: string, revision: number) {
    await this.assertProject(id, ownerId);
    const [row] = await this.db
      .update(compositions)
      .set({ status: 'processing', error: null })
      .where(
        and(
          eq(compositions.projectId, id),
          eq(compositions.revision, revision),
          eq(compositions.status, 'failed'),
        ),
      )
      .returning();
    if (row) await this.enqueue({ kind: 'formal', id: row.id, generation: revision });
    return this.state(id, revision);
  }
  async enqueue(work: CompositionWork) {
    const jobId = `${work.kind}-${work.id}-${work.generation}`,
      old = await this.queue.getJob(jobId);
    if (old && ['completed', 'failed'].includes(await old.getState())) await old.remove();
    await this.queue.add(work.kind, work, {
      jobId,
      priority: work.kind === 'candidate' ? 1 : 5,
      removeOnComplete: 100,
      removeOnFail: 100,
    });
  }
  async recover() {
    if (this.recovering) return;
    this.recovering = true;
    try {
      const cards = await this.db
        .select()
        .from(proposals)
        .innerJoin(projects, eq(projects.id, proposals.projectId))
        .where(
          and(
            eq(proposals.status, 'pending'),
            eq(proposals.previewStatus, 'processing'),
            eq(projects.deleting, false),
          ),
        );
      for (const { edit_proposals: p } of cards)
        await this.enqueue({ kind: 'candidate', id: p.id, generation: p.generation });
      const rows = await this.db
        .select()
        .from(compositions)
        .innerJoin(projects, eq(projects.id, compositions.projectId))
        .where(and(eq(compositions.status, 'processing'), eq(projects.deleting, false)));
      for (const { compositions: c } of rows)
        await this.enqueue({ kind: 'formal', id: c.id, generation: c.revision });
      if (Date.now() - this.lastPruned > 3600000) {
        this.lastPruned = Date.now();
        await this.pruneCache();
      }
    } catch (e) {
      this.logger.debug((e as Error).message);
    } finally {
      this.recovering = false;
    }
  }
  async pruneCache(now = Date.now()) {
    // Saved previews keep their immutable resources. Abandoned/cancelled candidates
    // expire after a day; skip busy projects so another worker cannot lose an input.
    const [saved, cards, jobs] = await Promise.all([
      this.db.select().from(compositions),
      this.db.select().from(proposals),
      this.db.select({ projectId: editJobs.projectId, status: editJobs.status }).from(editJobs),
    ]);
    const busy = new Set(
      jobs.filter((j) => j.status === 'queued' || j.status === 'running').map((j) => j.projectId),
    );
    for (const row of saved) if (row.status === 'processing') busy.add(row.projectId);
    for (const row of cards)
      if (row.status === 'pending' && row.previewStatus === 'processing') busy.add(row.projectId);
    const protectedKeys = new Map<string, Set<string>>();
    for (const row of [...saved, ...cards.filter((p) => p.status === 'pending')]) {
      const m = row.manifest;
      if (!m) continue;
      const set = protectedKeys.get(row.projectId) ?? new Set<string>();
      for (const key of [
        m.audioKey,
        ...m.overlays.map((o) => o.key),
        `projects/${row.projectId}/composition/${m.hash}/manifest.json`,
      ]) {
        const hash = key.split('/')[3];
        if (hash) set.add(hash);
      }
      protectedKeys.set(row.projectId, set);
    }
    for (const dir of await readdir(this.storage.resolve('projects'), {
      withFileTypes: true,
    }).catch(() => [])) {
      if (!dir.isDirectory() || !/^[-\da-f]{36}$/.test(dir.name) || busy.has(dir.name)) continue;
      const prefix = `projects/${dir.name}/composition`;
      for (const item of await readdir(this.storage.resolve(prefix), { withFileTypes: true }).catch(
        () => [],
      )) {
        if (
          !item.isDirectory() ||
          !/^[\da-f]{64}$/.test(item.name) ||
          protectedKeys.get(dir.name)?.has(item.name)
        )
          continue;
        const key = prefix + '/' + item.name,
          info = await stat(this.storage.resolve(key));
        if (info.mtimeMs < now - 86400000) await this.storage.removeTree(key);
      }
    }
  }
  async process(work: CompositionWork, signal: AbortSignal) {
    const [card] =
      work.kind === 'candidate'
        ? await this.db
            .select()
            .from(proposals)
            .where(
              and(
                eq(proposals.id, work.id),
                eq(proposals.status, 'pending'),
                eq(proposals.generation, work.generation),
                eq(proposals.previewStatus, 'processing'),
              ),
            )
        : [];
    const [formal] =
      work.kind === 'formal'
        ? await this.db
            .select()
            .from(compositions)
            .where(and(eq(compositions.id, work.id), eq(compositions.status, 'processing')))
        : [];
    if (!card && !formal) return;
    const executionId = randomUUID();
    if (card)
      await this.db
        .update(proposals)
        .set({ previewExecution: executionId })
        .where(
          and(
            eq(proposals.id, card.id),
            eq(proposals.status, 'pending'),
            eq(proposals.previewStatus, 'processing'),
            eq(proposals.generation, work.generation),
          ),
        );
    else
      await this.db
        .update(compositions)
        .set({ executionId })
        .where(and(eq(compositions.id, formal!.id), eq(compositions.status, 'processing')));
    const projectId = (card ?? formal)!.projectId;
    const [project] = await this.db
      .select()
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.deleting, false)));
    if (!project) return;
    const abort = new AbortController();
    const set = this.active.get(projectId) ?? new Set<AbortController>();
    set.add(abort);
    this.active.set(projectId, set);
    const forward = () => abort.abort();
    signal.addEventListener('abort', forward, { once: true });
    const heartbeat = setInterval(
      () =>
        void (async () => {
          try {
            const [p] = await this.db
              .select()
              .from(projects)
              .where(and(eq(projects.id, projectId), eq(projects.deleting, false)));
            if (!p) abort.abort();
            if (card) {
              const [current] = await this.db
                .select()
                .from(proposals)
                .where(
                  and(
                    eq(proposals.id, card.id),
                    eq(proposals.status, 'pending'),
                    eq(proposals.generation, work.generation),
                    eq(proposals.previewExecution, executionId),
                  ),
                );
              if (!current) abort.abort();
            } else {
              const [current] = await this.db
                .select({ id: compositions.id })
                .from(compositions)
                .where(
                  and(
                    eq(compositions.id, formal!.id),
                    eq(compositions.executionId, executionId),
                    eq(compositions.status, 'processing'),
                  ),
                );
              if (!current) abort.abort();
            }
          } catch {
            /* Publication is fenced again after rendering. */
          }
        })(),
      1000,
    );
    try {
      const [stored] = await this.db
        .select()
        .from(timelines)
        .where(eq(timelines.projectId, projectId));
      if (card && stored?.state.revision !== card.baseRevision)
        throw new ConflictException('候选基准版本已变化');
      const timeline = card
        ? (card.candidate ?? applyOperation(stored!.state, card.operation))
        : formal!.snapshot;
      const assets = await this.assets(projectId);
      this.engine.validate(timeline, assets);
      const manifest = await this.engine.prepare(timeline, assets, projectId, abort.signal);
      const still = await this.db
        .select()
        .from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.deleting, false)));
      if (!still.length) return;
      if (card) {
        const impacts = packagingImpacts(
          stored!.state.packaging ?? emptyPackaging(),
          timelineFrames(stored!.state),
          timelineFrames(timeline),
          ['move', 'copy', 'add', 'delete-clip'].includes(card.operation.kind),
        );
        await this.db
          .update(proposals)
          .set({
            previewStatus: 'ready',
            previewError: null,
            contentHash: manifest.hash,
            manifest,
            candidate: timeline,
            details: [
              ...card.details,
              ...impacts.map(
                (i) =>
                  `${i.label}：${{ inactive: '暂不生效', partial: '部分生效', restored: '恢复', whole: '全片范围变化', picture: '固定时间不随Clip移动，画面对应关系可能变化' }[i.state]}；${i.before ? formatTimecode(i.before.startFrame) + '～' + formatTimecode(i.before.endFrame) : '不生效'} → ${i.after ? formatTimecode(i.after.startFrame) + '～' + formatTimecode(i.after.endFrame) : '不生效'}`,
              ),
            ],
          })
          .where(
            and(
              eq(proposals.id, card.id),
              eq(proposals.generation, work.generation),
              eq(proposals.status, 'pending'),
              eq(proposals.previewExecution, executionId),
              eq(proposals.previewStatus, 'processing'),
            ),
          );
      } else
        await this.db
          .update(compositions)
          .set({ status: 'ready', manifest, error: null })
          .where(
            and(
              eq(compositions.id, formal!.id),
              eq(compositions.executionId, executionId),
              eq(compositions.status, 'processing'),
            ),
          );
    } catch (e) {
      if (abort.signal.aborted) return;
      const message = (e as Error).message;
      if (card)
        await this.db
          .update(proposals)
          .set({ previewStatus: 'failed', previewError: message })
          .where(
            and(
              eq(proposals.id, card.id),
              eq(proposals.generation, work.generation),
              eq(proposals.status, 'pending'),
              eq(proposals.previewExecution, executionId),
              eq(proposals.previewStatus, 'processing'),
            ),
          );
      else
        await this.db
          .update(compositions)
          .set({ status: 'failed', error: message })
          .where(
            and(
              eq(compositions.id, formal!.id),
              eq(compositions.executionId, executionId),
              eq(compositions.status, 'processing'),
            ),
          );
    } finally {
      clearInterval(heartbeat);
      signal.removeEventListener('abort', forward);
      set.delete(abort);
      if (!set.size) this.active.delete(projectId);
    }
  }
  async operation(id: string, ownerId: string, requestId: string) {
    await this.assertProject(id, ownerId);
    const { editingOperations, timelineMutations } = await import('../database/schema.js');
    return this.db.transaction(async (tx) => {
      await tx.execute((await import('../media/media-processing.service.js')).projectLock(id));
      const [done] = await tx
        .select()
        .from(editingOperations)
        .where(
          and(eq(editingOperations.projectId, id), eq(editingOperations.requestId, requestId)),
        );
      const [mutation] = await tx
        .select()
        .from(timelineMutations)
        .where(
          and(eq(timelineMutations.projectId, id), eq(timelineMutations.requestId, requestId)),
        );
      const [turn] = await tx
        .select()
        .from(chatTurns)
        .where(and(eq(chatTurns.projectId, id), eq(chatTurns.requestId, requestId)));
      return done
        ? { status: 'committed', revision: done.revision }
        : mutation
          ? { status: 'committed', revision: mutation.revision }
          : turn
            ? {
                status: turn.status === 'understanding' ? 'unknown' : 'not-committed',
                revision: null,
              }
            : { status: 'not-committed', revision: null };
    });
  }
}
