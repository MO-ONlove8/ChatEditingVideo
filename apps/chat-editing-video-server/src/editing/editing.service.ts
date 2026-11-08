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
} from '../database/schema.js';
import { projectLock } from '../media/media-processing.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { LlmService } from '../llm/llm.service.js';
import { APP_CONFIG } from '../config/config.module.js';
import type { Env } from '../config/env.js';

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
    return row!.state;
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
      return { timeline, turns, nextCursor: rows.length > 30 ? page[0]!.id : null };
    });
    return { project: await this.projectService.get(id, ownerId), ...snapshot };
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
    input: { requestId: string; text: string; expectedRevision: number },
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
      return { timeline, turn: turn!, assets, history };
    });
    if (!started) return this.state(id, ownerId);
    let intent: EditingIntent;
    try {
      intent = await this.llm.understand(
        {
          assets: started.assets.map((a) => ({
            number: a.number,
            status: a.status,
            frameCount: editingSource(a)?.info.frameCount,
          })),
          clips: started.timeline.clips.map((c, i) => ({ number: i + 1, ...c })),
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
          card = this.makeProposal(intent, timeline, assets, started.turn.id);
          applyOperation(timeline, card.operation);
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
      const asset = assets.find((a) => a.number === intent.sourceNumber);
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
    return {
      id: randomUUID(),
      turnId,
      baseRevision: timeline.revision,
      status: 'pending',
      operation,
      sourceLabel,
      destinationLabel,
      previewClip,
      appliedRevision: null,
    };
  }
  async decide(id: string, ownerId: string, proposalId: string, confirm: boolean) {
    await this.db.transaction(async (tx) => {
      const timeline = await this.locked(tx, id, ownerId);
      const [card] = await tx
        .select()
        .from(proposals)
        .where(and(eq(proposals.id, proposalId), eq(proposals.projectId, id)));
      if (!card) throw new NotFoundException('确认卡不存在');
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
      const [asset] = await tx
        .select()
        .from(mediaAssets)
        .where(
          and(
            eq(mediaAssets.id, card.previewClip.source),
            eq(mediaAssets.projectId, id),
            eq(mediaAssets.removed, false),
            eq(mediaAssets.deleting, false),
            eq(mediaAssets.status, 'ready'),
            eq(mediaAssets.generation, card.previewClip.generation),
          ),
        );
      if (!asset) throw new ConflictException('来源素材已不可用，请取消后重新发送');
      let updated: Timeline;
      try {
        updated = applyOperation(timeline, card.operation);
      } catch (error) {
        throw new BadRequestException((error as Error).message);
      }
      await this.save(tx, id, updated);
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
      if (!timeline.clips.some((c) => c.id === clipId)) throw new NotFoundException('片段不存在');
      const updated = {
        ...timeline,
        revision: timeline.revision + 1,
        clips: timeline.clips.filter((c) => c.id !== clipId),
      };
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
}
