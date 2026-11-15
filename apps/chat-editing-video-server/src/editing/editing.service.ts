import { editingSource } from '../media/media-source.js';
import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  applyOperation,
  EditingErrorCodes,
  emptyTimeline,
  outputCanvas,
  parseTimecode,
  ProposalSchema,
  type ChatTurn,
  type EditingIntent,
  type EditorState,
  type Proposal,
  type Timeline,
  type ElementEdit,
  ElementEditSchema,
  ElementEditLabels,
  TimelineSchema,
  emptyPackaging,
  timelineFrames,
} from '@cev/shared';
import { DB, type Database } from '../database/database.module.js';
import {
  chatTurns,
  mediaAssets,
  projects,
  proposals,
  timelineMutations,
  timelines,
  type MediaAssetRow,
  compositions,
  editingOperations,
} from '../database/schema.js';
import { projectLock } from '../media/media-processing.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { LlmService } from '../llm/llm.service.js';
import { APP_CONFIG } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { CompositionService } from '../composition/composition.service.js';
import { contentHash, CompositionEngine } from '../composition/composition-engine.service.js';
import { resolveElementEdit } from './element-operation.js';
import { toMediaAsset } from '../media/media.service.js';
import { subtitleContext } from './subtitle-context.js';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
const conflict = () =>
  new ConflictException({
    code: EditingErrorCodes.timelineChanged,
    message: '时间轴已发生变化，请刷新后重新操作',
  });

@Injectable()
export class EditingService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly projectService: ProjectsService,
    private readonly llm: LlmService,
    @Inject(APP_CONFIG) private readonly env: Env,
    private readonly composition: CompositionService,
    private readonly engine: CompositionEngine,
  ) {}

  async locked(tx: Tx, id: string, ownerId: string): Promise<Timeline> {
    await tx.execute(projectLock(id));
    const [project] = await tx
      .select()
      .from(projects)
      .where(and(eq(projects.id, id), eq(projects.ownerId, ownerId), eq(projects.deleting, false)));
    if (!project) throw new NotFoundException('任务不存在');
    await tx
      .insert(timelines)
      .values({ projectId: id, state: emptyTimeline() })
      .onConflictDoNothing();
    const [row] = await tx.select().from(timelines).where(eq(timelines.projectId, id));
    await tx
      .update(chatTurns)
      .set({ status: 'failed', reply: '理解过程已中断或超时，请重试' })
      .where(
        and(
          eq(chatTurns.projectId, id),
          eq(chatTurns.status, 'understanding'),
          lt(chatTurns.deadline, new Date()),
        ),
      );
    return TimelineSchema.parse(row!.state);
  }
  async state(id: string, ownerId: string): Promise<EditorState> {
    const snapshot = await this.db.transaction(async (tx) => {
      const timeline = await this.locked(tx, id, ownerId);
      const rows = await tx
        .select()
        .from(chatTurns)
        .where(eq(chatTurns.projectId, id))
        .orderBy(desc(chatTurns.createdAt), desc(chatTurns.id))
        .limit(31);
      const page = rows.slice(0, 30);
      const cards = page.length
        ? await tx
            .select()
            .from(proposals)
            .where(
              inArray(
                proposals.turnId,
                page.map((t) => t.id),
              ),
            )
        : [];
      const turns: ChatTurn[] = page.reverse().map((t) => ({
        ...t,
        status: t.status as ChatTurn['status'],
        createdAt: t.createdAt.toISOString(),
        proposal: cards.find((p) => p.turnId === t.id)
          ? ProposalSchema.parse(cards.find((p) => p.turnId === t.id))
          : null,
      }));
      if (timelineFrames(timeline) > 0)
        await tx
          .insert(compositions)
          .values({ projectId: id, revision: timeline.revision, snapshot: timeline })
          .onConflictDoNothing();
      return { timeline, turns, nextCursor: rows.length > 30 ? page[0]!.id : null };
    });
    return {
      project: await this.projectService.get(id, ownerId),
      ...snapshot,
      composition: await this.composition.state(id, snapshot.timeline.revision),
    };
  }
  async history(id: string, ownerId: string, before?: string) {
    await this.projectService.get(id, ownerId);
    if (before && !z.uuid().safeParse(before).success)
      throw new BadRequestException('无效的分页位置');
    const rows = await this.db
      .select()
      .from(chatTurns)
      .where(
        and(
          eq(chatTurns.projectId, id),
          before
            ? sql`(${chatTurns.createdAt},${chatTurns.id}) < (select created_at,id from chat_turns where id=${before} and project_id=${id})`
            : undefined,
        ),
      )
      .orderBy(desc(chatTurns.createdAt), desc(chatTurns.id))
      .limit(31);
    const page = rows.slice(0, 30);
    const cards = page.length
      ? await this.db
          .select()
          .from(proposals)
          .where(
            inArray(
              proposals.turnId,
              page.map((t) => t.id),
            ),
          )
      : [];
    page.reverse();
    return {
      turns: page.map((t) => ({
        ...t,
        createdAt: t.createdAt.toISOString(),
        proposal: cards.find((p) => p.turnId === t.id) ?? null,
      })),
      nextCursor: rows.length > 30 ? page[0]!.id : null,
    };
  }
  async instruct(
    id: string,
    ownerId: string,
    input: {
      requestId: string;
      text: string;
      expectedRevision: number;
      playhead?: number;
      selectedId?: string;
    },
    signal?: AbortSignal,
  ) {
    const started = await this.db.transaction(async (tx) => {
      const timeline = await this.locked(tx, id, ownerId);
      const [old] = await tx
        .select()
        .from(chatTurns)
        .where(and(eq(chatTurns.projectId, id), eq(chatTurns.requestId, input.requestId)));
      if (old && old.text !== input.text)
        throw new BadRequestException('请求标识不能用于另一条指令');
      if (old && old.status !== 'failed') return null;
      if (timeline.revision !== input.expectedRevision) throw conflict();
      const [active] = await tx
        .select()
        .from(chatTurns)
        .where(
          and(eq(chatTurns.projectId, id), inArray(chatTurns.status, ['understanding', 'pending'])),
        );
      if (active)
        throw new ConflictException({
          code: EditingErrorCodes.operationPending,
          message: '请先等待理解结果，或确认、取消上一张确认卡',
        });
      const deadline = new Date(Date.now() + this.env.LLM_TIMEOUT_MS + 10000);
      const [turn] = old
        ? await tx
            .update(chatTurns)
            .set({
              status: 'understanding',
              reply: '',
              deadline,
              baseRevision: timeline.revision,
              createdAt: new Date(),
            })
            .where(eq(chatTurns.id, old.id))
            .returning()
        : await tx
            .insert(chatTurns)
            .values({
              projectId: id,
              requestId: input.requestId,
              text: input.text,
              context: { playhead: input.playhead ?? 0, selectedId: input.selectedId },
              baseRevision: timeline.revision,
              deadline,
            })
            .returning();
      const assets = await tx
        .select()
        .from(mediaAssets)
        .where(
          and(
            eq(mediaAssets.projectId, id),
            eq(mediaAssets.removed, false),
            eq(mediaAssets.deleting, false),
          ),
        )
        .orderBy(asc(mediaAssets.number));
      const history = await tx
        .select()
        .from(chatTurns)
        .where(and(eq(chatTurns.projectId, id), eq(chatTurns.status, 'done')))
        .orderBy(desc(chatTurns.createdAt))
        .limit(8);
      return {
        timeline,
        turn: turn!,
        assets,
        history,
        context: old?.context ?? { playhead: input.playhead ?? 0, selectedId: input.selectedId },
      };
    });
    if (!started) return this.state(id, ownerId);
    let intent: EditingIntent;
    try {
      intent = await this.llm.understand(
        {
          assets: started.assets.map((a) => ({
            id: a.id,
            kind: a.kind,
            label: `${a.kind === 'image' ? 'IMG' : a.kind === 'audio' ? 'AUD' : a.kind === 'srt' ? 'SRT' : 'V'}${a.number}`,
            number: a.number,
            status: a.status,
            frameCount: editingSource(a)?.info.frameCount,
          })),
          clips: started.timeline.clips.map((c, i) => ({ number: i + 1, ...c })),
          playhead: started.context.playhead,
          selectedId: started.context.selectedId,
          elements: {
            subtitles: subtitleContext(
              started.timeline,
              input.text,
              started.context.playhead,
              started.context.selectedId,
            ),
            overlays: started.timeline.packaging?.overlays,
            audio: started.timeline.packaging?.audio,
          },
        },
        started.history.reverse().flatMap((t) => [
          { role: 'user' as const, content: t.text },
          { role: 'assistant' as const, content: t.reply },
        ]),
        input.text,
        signal,
      );
    } catch {
      await this.db
        .update(chatTurns)
        .set({ status: 'failed', reply: '模型暂时无法理解指令，请检查本地模型后重试' })
        .where(
          and(
            eq(chatTurns.id, started.turn.id),
            eq(chatTurns.status, 'understanding'),
            eq(chatTurns.deadline, started.turn.deadline),
          ),
        );
      return this.state(id, ownerId);
    }
    await this.db.transaction(async (tx) => {
      const timeline = await this.locked(tx, id, ownerId);
      const [turn] = await tx.select().from(chatTurns).where(eq(chatTurns.id, started.turn.id));
      if (
        turn?.status !== 'understanding' ||
        turn.deadline.getTime() !== started.turn.deadline.getTime()
      )
        return;
      let reply = intent.message;
      let card: Proposal | undefined;
      if (timeline.revision !== started.timeline.revision)
        reply = '时间轴已发生变化，请根据当前编号重新发送指令';
      else if (['clarify', 'unsupported', 'multiple'].includes(intent.kind))
        reply =
          intent.kind === 'multiple'
            ? '每条消息只处理一个操作，请逐条发送。'
            : reply || '没理解清楚，请补充来源、起止时间和目标位置。';
      else {
        try {
          const assets = await tx
            .select()
            .from(mediaAssets)
            .where(
              and(
                eq(mediaAssets.projectId, id),
                eq(mediaAssets.removed, false),
                eq(mediaAssets.deleting, false),
              ),
            );
          if (intent.kind === 'element') {
            const [project] = await tx.select().from(projects).where(eq(projects.id, id));
            const counters = { ...project!.counters };
            const p = timeline.packaging ?? emptyPackaging();
            const allocate = (prefix: string) => {
              const list =
                prefix === 'S'
                  ? p.subtitles
                  : prefix === 'A'
                    ? p.audio
                    : p.overlays.filter((o) =>
                        prefix === 'T' ? o.kind === 'text' : o.kind === 'image',
                      );
              const n = Math.max(counters[prefix] ?? 1, ...list.map((o) => o.number + 1));
              counters[prefix] = n + 1;
              return n;
            };
            const resolved = resolveElementEdit(
              ElementEditSchema.parse({
                ...intent.element,
                requestId: input.requestId,
                expectedRevision: timeline.revision,
                playhead: started.context.playhead,
              }),
              timeline,
              assets.map(toMediaAsset),
              allocate,
            );
            this.engine.validate(resolved.candidate, assets.map(toMediaAsset), false);
            card = ProposalSchema.parse({
              id: randomUUID(),
              turnId: started.turn.id,
              baseRevision: timeline.revision,
              status: 'pending',
              operation: resolved.operation,
              sourceLabel: '字幕 / 图文 / 声音',
              destinationLabel:
                ElementEditLabels[
                  resolved.operation.kind === 'overlay'
                    ? resolved.operation.item.kind
                    : intent.element!.kind!
                ],
              previewClip: null,
              appliedRevision: null,
              details: resolved.details,
              previewStatus: resolved.operation.kind === 'delete-element' ? 'ready' : 'processing',
              contentHash: resolved.operation.kind === 'delete-element' ? 'delete' : null,
            });
            await tx.update(projects).set({ counters }).where(eq(projects.id, id));
          } else card = this.makeProposal(intent, timeline, assets, started.turn.id);
          const candidate = applyOperation(timeline, card.operation);
          card = { ...card, candidate };
          await tx.insert(proposals).values({ ...card, projectId: id });
          reply = '请预览并确认这次剪辑；确认保存后才会修改主视频。';
        } catch (error) {
          reply = error instanceof Error ? error.message : '无法执行此操作，请补充信息';
        }
      }
      await tx
        .update(chatTurns)
        .set({ status: card ? 'pending' : 'done', reply })
        .where(eq(chatTurns.id, started.turn.id));
      await tx.update(projects).set({ updatedAt: new Date() }).where(eq(projects.id, id));
    });
    await this.composition.recover();
    return this.state(id, ownerId);
  }

  private makeProposal(
    intent: EditingIntent,
    timeline: Timeline,
    assets: MediaAssetRow[],
    turnId: string,
  ): Proposal {
    if (!intent.sourceNumber || !intent.destination) throw new Error('请补充来源编号和目标位置');
    const target =
      intent.destination !== 'end' ? timeline.clips[(intent.targetNumber ?? 0) - 1] : null;
    if (intent.destination !== 'end' && !target)
      throw new Error(`目标Clip${intent.targetNumber ?? ''}不存在，请使用当前编号`);
    const destination = { kind: intent.destination, clipId: target?.id ?? null };
    const destinationLabel =
      intent.destination === 'end'
        ? '主视频末尾'
        : `Clip${intent.targetNumber}${intent.destination === 'before' ? '前' : '后'}`;
    let operation: Proposal['operation'];
    let previewClip: Proposal['previewClip'];
    let sourceLabel: string;
    if (intent.kind === 'add') {
      const asset = assets.find((a) => a.kind === 'video' && a.number === intent.sourceNumber);
      if (!asset) throw new Error(`素材V${intent.sourceNumber}不存在`);
      const source = editingSource(asset);
      if (asset.status !== 'ready' || !source)
        throw new Error(`素材V${intent.sourceNumber}尚未处理完成`);
      if (!intent.startTime || !intent.endTime) throw new Error('请补充截取的起止时间');
      const startFrame = parseTimecode(intent.startTime),
        endFrame = parseTimecode(intent.endTime);
      if (endFrame < startFrame || endFrame >= (source.info.frameCount ?? 0))
        throw new Error('截取范围无效：结束不能早于开始，且不能超出素材范围');
      const clip = {
        id: randomUUID(),
        source: asset.id,
        generation: asset.generation,
        startFrame,
        endFrame,
      };
      const size = asset.original ?? source.info;
      operation = { kind: 'add', clip, destination, canvas: outputCanvas(size.width, size.height) };
      previewClip = clip;
      sourceLabel = `V${asset.number}`;
    } else {
      const clip = timeline.clips[intent.sourceNumber - 1];
      if (!clip) throw new Error(`来源Clip${intent.sourceNumber}不存在，请使用当前编号`);
      if (intent.kind !== 'move' && intent.kind !== 'copy') throw new Error('暂不支持此操作');
      operation = { kind: intent.kind, clipId: clip.id, newClipId: randomUUID(), destination };
      previewClip = clip;
      sourceLabel = `Clip${intent.sourceNumber} / V${assets.find((a) => a.id === clip.source)?.number ?? '?'}`;
    }
    return ProposalSchema.parse({
      id: randomUUID(),
      turnId,
      baseRevision: timeline.revision,
      status: 'pending',
      operation,
      sourceLabel,
      destinationLabel,
      previewClip,
      appliedRevision: null,
    });
  }
  async decide(
    id: string,
    ownerId: string,
    proposalId: string,
    confirm: boolean,
    verification?: { requestId: string; contentHash: string; generation: number },
  ) {
    await this.db.transaction(async (tx) => {
      const timeline = await this.locked(tx, id, ownerId);
      const [card] = await tx
        .select()
        .from(proposals)
        .where(and(eq(proposals.id, proposalId), eq(proposals.projectId, id)));
      if (!card) throw new NotFoundException('确认卡不存在');
      const [originalTurn] = await tx.select().from(chatTurns).where(eq(chatTurns.id, card.turnId));
      if (confirm && verification && originalTurn!.requestId !== verification.requestId)
        throw new BadRequestException('操作标识不属于该候选');
      if (
        confirm &&
        verification &&
        card.status !== 'cancelled' &&
        card.status !== 'invalid' &&
        (verification.contentHash !== card.contentHash ||
          verification.generation !== card.generation)
      )
        throw new ConflictException({
          code: EditingErrorCodes.candidateChanged,
          message: '候选参数已变化，请刷新预览',
        });
      if (card.status === (confirm ? 'confirmed' : 'cancelled')) return;
      if (card.status !== 'pending')
        throw new ConflictException({
          code: EditingErrorCodes.proposalInvalid,
          message: '该确认卡已处理或失效',
        });
      if (!confirm) {
        await tx.update(proposals).set({ status: 'cancelled' }).where(eq(proposals.id, proposalId));
        await tx
          .update(chatTurns)
          .set({ status: 'done', reply: '已取消，剪辑结果未改变。' })
          .where(eq(chatTurns.id, card.turnId));
        return;
      }
      if (card.baseRevision !== timeline.revision) throw conflict();
      const pureDelete =
        card.operation.kind === 'delete-element' || card.operation.kind === 'delete-clip';
      if (!pureDelete && (card.previewStatus !== 'ready' || !card.manifest || !card.contentHash))
        throw new ConflictException({
          code: EditingErrorCodes.previewNotReady,
          message: '请先成功生成完整候选预览',
        });
      if (
        verification &&
        (verification.contentHash !== card.contentHash ||
          verification.generation !== card.generation)
      )
        throw new ConflictException({
          code: EditingErrorCodes.candidateChanged,
          message: '候选参数已变化，请刷新预览',
        });
      const [asset] = await tx
        .select()
        .from(mediaAssets)
        .where(
          and(
            eq(mediaAssets.id, card.previewClip?.source ?? '00000000-0000-4000-8000-000000000000'),
            eq(mediaAssets.projectId, id),
            eq(mediaAssets.removed, false),
            eq(mediaAssets.deleting, false),
            eq(mediaAssets.status, 'ready'),
            eq(mediaAssets.generation, card.previewClip?.generation ?? 0),
          ),
        );
      if (card.previewClip && !asset)
        throw new ConflictException('来源素材已不可用，请取消后重新发送');
      let updated: Timeline;
      try {
        updated = applyOperation(timeline, card.operation);
      } catch (error) {
        throw new BadRequestException((error as Error).message);
      }
      const assets = (
        await tx
          .select()
          .from(mediaAssets)
          .where(
            and(
              eq(mediaAssets.projectId, id),
              eq(mediaAssets.removed, false),
              eq(mediaAssets.deleting, false),
            ),
          )
      ).map(toMediaAsset);
      this.engine.validate(updated, assets, false);
      await this.save(tx, id, updated);
      const [turn] = await tx.select().from(chatTurns).where(eq(chatTurns.id, card.turnId));
      await tx
        .insert(editingOperations)
        .values({
          requestId: turn!.requestId,
          projectId: id,
          proposalId: card.id,
          revision: updated.revision,
          contentHash: card.contentHash ?? 'delete',
        })
        .onConflictDoNothing();
      if (!pureDelete && card.manifest)
        await tx
          .update(compositions)
          .set({ status: 'ready', manifest: card.manifest, error: null })
          .where(and(eq(compositions.projectId, id), eq(compositions.revision, updated.revision)));
      await tx
        .update(proposals)
        .set({ status: 'confirmed', appliedRevision: updated.revision })
        .where(eq(proposals.id, proposalId));
      await tx
        .update(chatTurns)
        .set({ status: 'done', reply: '已确认并保存。' })
        .where(eq(chatTurns.id, card.turnId));
    });
    return this.state(id, ownerId);
  }
  async removeClip(
    id: string,
    ownerId: string,
    clipId: string,
    request: { requestId: string; expectedRevision: number },
  ) {
    await this.db.transaction(async (tx) => {
      const timeline = await this.locked(tx, id, ownerId);
      const [old] = await tx
        .select()
        .from(timelineMutations)
        .where(eq(timelineMutations.requestId, request.requestId));
      if (old) {
        if (old.projectId !== id || old.clipId !== clipId)
          throw new BadRequestException('请求标识已使用');
        return;
      }
      if (timeline.revision !== request.expectedRevision) throw conflict();
      const [active] = await tx
        .select({ id: chatTurns.id })
        .from(chatTurns)
        .where(
          and(eq(chatTurns.projectId, id), inArray(chatTurns.status, ['understanding', 'pending'])),
        );
      if (active) throw new ConflictException('请先确认或取消当前操作');
      if (!timeline.clips.some((c) => c.id === clipId)) throw new NotFoundException('片段不存在');
      let updated: Timeline;
      try {
        updated = applyOperation(timeline, { kind: 'delete-clip', clipId });
      } catch (e) {
        throw new BadRequestException((e as Error).message);
      }
      await this.save(tx, id, updated);
      await tx.insert(timelineMutations).values({
        requestId: request.requestId,
        projectId: id,
        clipId,
        revision: updated.revision,
      });
    });
    return this.state(id, ownerId);
  }
  async save(tx: Tx, id: string, timeline: Timeline) {
    await tx.update(timelines).set({ state: timeline }).where(eq(timelines.projectId, id));
    if (timelineFrames(timeline) > 0)
      await tx
        .insert(compositions)
        .values({ projectId: id, revision: timeline.revision, snapshot: timeline })
        .onConflictDoNothing();
    const invalid = await tx
      .update(proposals)
      .set({ status: 'invalid' })
      .where(and(eq(proposals.projectId, id), eq(proposals.status, 'pending')))
      .returning({ turnId: proposals.turnId });
    if (invalid.length)
      await tx
        .update(chatTurns)
        .set({ status: 'done' })
        .where(
          inArray(
            chatTurns.id,
            invalid.map((p) => p.turnId),
          ),
        );
    await tx.update(projects).set({ updatedAt: new Date() }).where(eq(projects.id, id));
  }

  async propose(id: string, ownerId: string, input: ElementEdit, replaceId?: string) {
    const row = await this.db.transaction(async (tx) => {
      const timeline = await this.locked(tx, id, ownerId);
      const [previous] = await tx
        .select()
        .from(chatTurns)
        .where(and(eq(chatTurns.projectId, id), eq(chatTurns.requestId, input.requestId)));
      if (previous && !replaceId) {
        const [card] = await tx.select().from(proposals).where(eq(proposals.turnId, previous.id));
        if (card?.inputHash !== contentHash(input))
          throw new BadRequestException('操作标识不能用于不同参数');
        return null;
      }
      if (timeline.revision !== input.expectedRevision) throw conflict();
      const [active] = await tx
        .select()
        .from(chatTurns)
        .where(
          and(eq(chatTurns.projectId, id), inArray(chatTurns.status, ['understanding', 'pending'])),
        );
      let old: typeof proposals.$inferSelect | undefined;
      if (replaceId) {
        [old] = await tx
          .select()
          .from(proposals)
          .where(
            and(
              eq(proposals.id, replaceId),
              eq(proposals.projectId, id),
              eq(proposals.status, 'pending'),
            ),
          );
        if (!old) throw new ConflictException('候选已处理或失效');
        const [original] = await tx.select().from(chatTurns).where(eq(chatTurns.id, old.turnId));
        if (original!.requestId !== input.requestId)
          throw new BadRequestException('更新必须沿用原操作标识');
        if (old.inputHash === contentHash(input)) return null;
      }
      if (active && active.id !== old?.turnId)
        throw new ConflictException('请先确认或取消当前操作');
      const [project] = await tx.select().from(projects).where(eq(projects.id, id));
      const counters = { ...project!.counters };
      const p = timeline.packaging ?? emptyPackaging();
      const allocate = (prefix: string) => {
        const existing =
          prefix === 'S'
            ? p.subtitles
            : prefix === 'A'
              ? p.audio
              : p.overlays.filter((v) => (prefix === 'T' ? v.kind === 'text' : v.kind === 'image'));
        const n = Math.max(counters[prefix] ?? 1, ...existing.map((v) => v.number + 1));
        counters[prefix] = n + 1;
        return n;
      };
      const assets = (
        await tx
          .select()
          .from(mediaAssets)
          .where(
            and(
              eq(mediaAssets.projectId, id),
              eq(mediaAssets.removed, false),
              eq(mediaAssets.deleting, false),
            ),
          )
      ).map(toMediaAsset);
      let result: ReturnType<typeof resolveElementEdit>;
      try {
        result = resolveElementEdit(input, timeline, assets, allocate);
        if (
          old &&
          'item' in old.operation &&
          'item' in result.operation &&
          old.operation.kind === result.operation.kind &&
          !input.id
        ) {
          result.operation = {
            ...result.operation,
            item: {
              ...result.operation.item,
              id: old.operation.item.id,
              number: old.operation.item.number,
            },
          } as typeof result.operation;
          result.candidate = applyOperation(timeline, result.operation);
        }
        this.engine.validate(result.candidate, assets, false);
      } catch (e) {
        throw new BadRequestException((e as Error).message);
      }
      const pureDelete = result.operation.kind === 'delete-element';
      const [turn] = old
        ? await tx.select().from(chatTurns).where(eq(chatTurns.id, old.turnId))
        : await tx
            .insert(chatTurns)
            .values({
              projectId: id,
              requestId: input.requestId,
              text: `属性操作：${input.kind}`,
              reply: '请检查完整合成候选，确认后保存。',
              status: 'pending',
              baseRevision: timeline.revision,
              deadline: new Date(),
            })
            .returning();
      const card = ProposalSchema.parse({
        id: old?.id ?? randomUUID(),
        turnId: turn!.id,
        baseRevision: timeline.revision,
        status: 'pending',
        operation: result.operation,
        sourceLabel: '字幕 / 图文 / 声音',
        destinationLabel: ElementEditLabels[input.kind],
        previewClip: null,
        appliedRevision: null,
        candidate: result.candidate,
        generation: (old?.generation ?? 0) + 1,
        details: result.details,
        previewStatus: pureDelete ? 'ready' : 'processing',
        contentHash: pureDelete ? 'delete' : null,
      });
      if (old)
        await tx
          .update(proposals)
          .set({ ...card, inputHash: contentHash(input) })
          .where(eq(proposals.id, old.id));
      else
        await tx
          .insert(proposals)
          .values({ ...card, projectId: id, inputHash: contentHash(input) });
      await tx.update(projects).set({ counters }).where(eq(projects.id, id));
      return card;
    });
    if (row && row.operation.kind !== 'delete-element')
      await this.composition.enqueue({ kind: 'candidate', id: row.id, generation: row.generation });
    return this.state(id, ownerId);
  }
  async retryPreview(id: string, ownerId: string, proposalId: string) {
    await this.projectService.get(id, ownerId);
    const [card] = await this.db
      .update(proposals)
      .set({
        previewStatus: 'processing',
        previewError: null,
        generation: sql`${proposals.generation}+1`,
        contentHash: null,
        manifest: null,
      })
      .where(
        and(
          eq(proposals.id, proposalId),
          eq(proposals.projectId, id),
          eq(proposals.status, 'pending'),
        ),
      )
      .returning();
    if (!card) throw new NotFoundException('候选不存在');
    await this.composition.enqueue({ kind: 'candidate', id: card.id, generation: card.generation });
    return this.state(id, ownerId);
  }
}
