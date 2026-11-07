import { z } from 'zod';

export const MAX_CLIPS = 100;
export const MAX_TIMELINE_FRAMES = 30 * 60 * 30;
export const FrameClipSchema = z
  .object({
    id: z.uuid(),
    source: z.uuid(),
    generation: z.number().int().positive(),
    startFrame: z.number().int().nonnegative(),
    endFrame: z.number().int().nonnegative(),
  })
  .refine((c) => c.endFrame >= c.startFrame, '结束位置不能早于开始位置');
export type FrameClip = z.infer<typeof FrameClipSchema>;
export const CanvasSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export const TimelineSchema = z.object({
  revision: z.number().int().nonnegative(),
  fps: z.literal(30),
  canvas: CanvasSchema.nullable(),
  clips: z.array(FrameClipSchema).max(MAX_CLIPS),
});
export type Timeline = z.infer<typeof TimelineSchema>;
export const emptyTimeline = (): Timeline => ({ revision: 0, fps: 30, canvas: null, clips: [] });
export const clipFrames = (c: FrameClip) => c.endFrame - c.startFrame + 1;
export const timelineFrames = (t: Pick<Timeline, 'clips'>) =>
  t.clips.reduce((n, c) => n + clipFrames(c), 0);
export function parseTimecode(value: string): number {
  const parts = value.trim().split(':');
  if (parts.length < 2 || parts.length > 4 || parts.some((x) => !/^\d+$/.test(x)))
    throw new Error('请使用 分:秒、分:秒:帧 或 时:分:秒:帧');
  const n = parts.map(Number);
  const [h, m, s, f] = n.length === 4 ? n : n.length === 3 ? [0, ...n] : [0, ...n, 0];
  if (m! >= 60 || s! >= 60 || f! >= 30) throw new Error('分钟、秒必须小于60，帧编号为0～29');
  const frame = (h! * 3600 + m! * 60 + s!) * 30 + f!;
  if (!Number.isSafeInteger(frame)) throw new Error('时间位置过大');
  return frame;
}
export function outputCanvas(width: number, height: number) {
  const scale = 1920 / Math.max(width, height);
  return {
    width: Math.max(2, Math.round((width * scale) / 2) * 2),
    height: Math.max(2, Math.round((height * scale) / 2) * 2),
  };
}
export const DestinationSchema = z.object({
  kind: z.enum(['end', 'before', 'after']),
  clipId: z.uuid().nullable(),
});
export const EditOperationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('add'),
    clip: FrameClipSchema,
    destination: DestinationSchema,
    canvas: CanvasSchema,
  }),
  z.object({
    kind: z.enum(['move', 'copy']),
    clipId: z.uuid(),
    newClipId: z.uuid(),
    destination: DestinationSchema,
  }),
]);
export type EditOperation = z.infer<typeof EditOperationSchema>;
export function applyOperation(timeline: Timeline, operation: EditOperation): Timeline {
  const clips = [...timeline.clips];
  let clip: FrameClip;
  if (operation.kind === 'add') clip = operation.clip;
  else {
    const index = clips.findIndex((c) => c.id === operation.clipId);
    if (index < 0) throw new Error('来源片段已不存在');
    if (
      operation.kind === 'move' &&
      operation.destination.clipId === operation.clipId &&
      operation.destination.kind !== 'end'
    )
      throw new Error('不能将片段放在自身前后');
    clip = { ...clips[index]! };
    if (operation.kind === 'move') clips.splice(index, 1);
    else clip.id = operation.newClipId;
  }
  let position = clips.length;
  if (operation.destination.kind !== 'end') {
    position = clips.findIndex((c) => c.id === operation.destination.clipId);
    if (position < 0) throw new Error('目标片段已不存在');
    if (operation.destination.kind === 'after') position++;
  }
  clips.splice(position, 0, clip);
  const result: Timeline = {
    ...timeline,
    revision: timeline.revision + 1,
    canvas: timeline.canvas ?? (operation.kind === 'add' ? operation.canvas : null),
    clips,
  };
  if (clips.length > MAX_CLIPS) throw new Error('每个任务最多100个Clip');
  if (timelineFrames(result) > MAX_TIMELINE_FRAMES) throw new Error('主视频累计时长不能超过30分钟');
  return result;
}
