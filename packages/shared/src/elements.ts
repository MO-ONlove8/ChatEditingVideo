import { z } from 'zod';

export const MAX_SUBTITLES = 1000;
export const MAX_OVERLAYS = 20;
export const AudioSettingsSchema = z.object({
  volume: z.number().min(0).max(200).default(100),
  muted: z.boolean().default(false),
  fadeIn: z.number().int().nonnegative().default(0),
  fadeOut: z.number().int().nonnegative().default(0),
});
export type AudioSettings = z.infer<typeof AudioSettingsSchema>;
export const AudioSettingsPatchSchema = z.object({
  volume: z.number().int().min(0).max(200).optional(),
  muted: z.boolean().optional(),
  fadeIn: z.number().int().nonnegative().optional(),
  fadeOut: z.number().int().nonnegative().optional(),
});
export const defaultAudio = (): AudioSettings => ({
  volume: 100,
  muted: false,
  fadeIn: 0,
  fadeOut: 0,
});
export const ElementRangeSchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('fixed'),
      startFrame: z.number().int().nonnegative(),
      endFrame: z.number().int().nonnegative(),
    })
    .refine((v) => v.endFrame >= v.startFrame, '结束位置不能早于开始位置'),
  z.object({ mode: z.literal('whole') }),
]);
export type ElementRange = z.infer<typeof ElementRangeSchema>;
export const TextStyleSchema = z.object({
  font: z.literal('noto-sans-sc').default('noto-sans-sc'),
  bold: z.boolean().default(false),
  size: z.number().min(1).max(20),
  color: z
    .string()
    .regex(/^#[\da-fA-F]{6}$/)
    .default('#FFFFFF'),
  opacity: z.number().min(0).max(100).default(100),
  align: z.enum(['left', 'center', 'right']).default('center'),
  width: z.number().min(10).max(100),
  x: z.number().min(0).max(100).default(50),
  y: z.number().min(0).max(100).default(50),
  anchor: z.enum(['center', 'top', 'bottom']).default('center'),
  outline: z.number().min(0).max(1).default(0.15),
  outlineColor: z
    .string()
    .regex(/^#[\da-fA-F]{6}$/)
    .default('#000000'),
  background: z
    .string()
    .regex(/^#[\da-fA-F]{6}$/)
    .default('#000000'),
  backgroundOpacity: z.number().min(0).max(100).default(0),
});
export type TextStyle = z.infer<typeof TextStyleSchema>;
// Patches must not apply defaults to fields the user did not change.
export const TextStylePatchSchema = z.object({
  font: z.literal('noto-sans-sc').optional(),
  bold: z.boolean().optional(),
  size: z.number().min(1).max(20).optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  opacity: z.number().min(0).max(100).optional(),
  align: z.enum(['left', 'center', 'right']).optional(),
  width: z.number().min(10).max(100).optional(),
  x: z.number().min(0).max(100).optional(),
  y: z.number().min(0).max(100).optional(),
  anchor: z.enum(['center', 'top', 'bottom']).optional(),
  outline: z.number().min(0).max(1).optional(),
  outlineColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  background: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  backgroundOpacity: z.number().min(0).max(100).optional(),
});
export const defaultSubtitleStyle = (): TextStyle =>
  TextStyleSchema.parse({ size: 4, width: 90, y: 95, anchor: 'bottom' });
export const defaultTextStyle = (title = true): TextStyle =>
  TextStyleSchema.parse({
    size: 6,
    width: 80,
    y: title ? 5 : 50,
    anchor: title ? 'top' : 'center',
    bold: title,
  });
export function validateText(text: string, lines: number) {
  if (!text.trim()) throw new Error('文字不能为空');
  if (Array.from(text).length > 200) throw new Error('每条文字最多200个Unicode字符');
  if (text.split('\n').length > lines) throw new Error(`最多${lines}行文字`);
  if (
    Array.from(text).some((c) => {
      const n = c.codePointAt(0)!;
      return n < 32 && ![9, 10, 13].includes(n);
    })
  )
    throw new Error('文字包含不支持的控制字符');
}
const identity = { id: z.uuid(), number: z.number().int().positive() };
export const SubtitleSchema = z.object({
  ...identity,
  text: z.string(),
  startFrame: z.number().int().nonnegative(),
  endFrame: z.number().int().nonnegative(),
});
export type Subtitle = z.infer<typeof SubtitleSchema>;
export const OverlaySchema = z.discriminatedUnion('kind', [
  z.object({
    ...identity,
    kind: z.literal('text'),
    text: z.string(),
    range: ElementRangeSchema,
    style: TextStyleSchema,
  }),
  z.object({
    ...identity,
    kind: z.literal('image'),
    assetId: z.uuid(),
    generation: z.number().int().positive(),
    range: ElementRangeSchema,
    x: z.number().min(0).max(100),
    y: z.number().min(0).max(100),
    width: z.number().min(1).max(100),
    opacity: z.number().min(0).max(100),
  }),
]);
export type Overlay = z.infer<typeof OverlaySchema>;
export const AudioElementSchema = z.object({
  ...identity,
  role: z.enum(['narration', 'bgm']),
  assetId: z.uuid(),
  generation: z.number().int().positive(),
  sourceStart: z.number().int().nonnegative(),
  sourceEnd: z.number().int().nonnegative(),
  range: ElementRangeSchema,
  settings: AudioSettingsSchema,
  loop: z.boolean().default(false),
});
export type AudioElement = z.infer<typeof AudioElementSchema>;
export const PackagingSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  subtitles: z.array(SubtitleSchema).max(MAX_SUBTITLES).default([]),
  subtitleStyle: TextStyleSchema.default(defaultSubtitleStyle),
  overlays: z.array(OverlaySchema).max(MAX_OVERLAYS).default([]),
  audio: z.array(AudioElementSchema).max(2).default([]),
});
export type Packaging = z.infer<typeof PackagingSchema>;
export const emptyPackaging = (): Packaging => PackagingSchema.parse({});
export const plannedRange = (range: ElementRange, frames: number) =>
  range.mode === 'whole' ? { startFrame: 0, endFrame: frames - 1 } : range;
export function effectiveRange(range: ElementRange, frames: number) {
  const p = plannedRange(range, frames),
    endFrame = Math.min(p.endFrame, frames - 1);
  return frames > 0 && p.startFrame <= endFrame ? { startFrame: p.startFrame, endFrame } : null;
}
export function validatePackaging(p: Packaging, frames: number, newRanges = false) {
  PackagingSchema.parse(p);
  const ids = new Set<string>(),
    numbers = new Set<string>();
  const checkIdentity = (v: { id: string; number: number }, prefix: string) => {
    if (ids.has(v.id) || numbers.has(`${prefix}${v.number}`)) throw new Error('元素身份或编号重复');
    ids.add(v.id);
    numbers.add(`${prefix}${v.number}`);
  };
  const range = (r: ElementRange) => {
    const v = plannedRange(r, frames);
    if (r.mode === 'fixed' && v.endFrame < v.startFrame) throw new Error('时间范围倒序');
    if (newRanges && (frames === 0 || v.startFrame >= frames || v.endFrame >= frames))
      throw new Error('时间范围超出当前主视频');
  };
  let end = -1;
  for (const s of [...p.subtitles].sort((a, b) => a.startFrame - b.startFrame)) {
    checkIdentity(s, 'S');
    validateText(s.text, 2);
    range({ mode: 'fixed', ...s });
    if (s.startFrame <= end) throw new Error(`S${s.number}字幕计划区间重叠`);
    end = s.endFrame;
  }
  for (const o of p.overlays) {
    checkIdentity(o, o.kind === 'text' ? 'T' : 'I');
    range(o.range);
    if (o.kind === 'text') validateText(o.text, 4);
  }
  const roles = new Set<string>();
  for (const a of p.audio) {
    checkIdentity(a, 'A');
    range(a.range);
    if (roles.has(a.role)) throw new Error('每个任务最多一个旁白和一个BGM，静音仍占位');
    roles.add(a.role);
    if (a.sourceEnd < a.sourceStart) throw new Error('声音源范围倒序');
    if (a.role === 'narration' && (a.loop || a.range.mode === 'whole'))
      throw new Error('旁白不支持循环或全片模式');
    const r = plannedRange(a.range, frames),
      length = r.endFrame - r.startFrame + 1;
    if ((frames > 0 || a.range.mode === 'fixed') && a.settings.fadeIn + a.settings.fadeOut > length)
      throw new Error('声音淡化超过计划窗口，请先减短/关闭淡化或删除该声音');
  }
}
export type ElementImpact = {
  label: string;
  before: ReturnType<typeof effectiveRange>;
  after: ReturnType<typeof effectiveRange>;
  state: 'inactive' | 'partial' | 'restored' | 'whole' | 'picture';
};
export function packagingImpacts(
  p: Packaging,
  beforeFrames: number,
  afterFrames: number,
  pictureChanged = false,
): ElementImpact[] {
  return [
    ...p.subtitles.map((s) => ({ label: `S${s.number}`, range: { mode: 'fixed' as const, ...s } })),
    ...p.overlays.map((o) => ({
      label: `${o.kind === 'text' ? 'T' : 'I'}${o.number}`,
      range: o.range,
    })),
    ...p.audio.map((a) => ({ label: `A${a.number}`, range: a.range })),
  ].flatMap(({ label, range }) => {
    const before = effectiveRange(range, beforeFrames),
      after = effectiveRange(range, afterFrames);
    const same = JSON.stringify(before) === JSON.stringify(after);
    if (same && !pictureChanged) return [];
    return [
      {
        label,
        before,
        after,
        state:
          range.mode === 'whole' && !same
            ? ('whole' as const)
            : !after
              ? ('inactive' as const)
              : !before || after.endFrame > before.endFrame
                ? ('restored' as const)
                : !same
                  ? ('partial' as const)
                  : ('picture' as const),
      },
    ];
  });
}
export const AuxiliaryPolicy = {
  image: { maxBytes: 20 * 1024 ** 2, maxAssets: 20, maxEdge: 8192 },
  audio: { maxBytes: 200 * 1024 ** 2, maxAssets: 10, maxSeconds: 1800 },
  srt: { maxBytes: 1024 ** 2, maxCues: 1000 },
} as const;

export const ElementOperationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('subtitle'), item: SubtitleSchema }),
  z.object({ kind: z.literal('subtitle-style'), style: TextStyleSchema }),
  z.object({
    kind: z.literal('subtitle-replace'),
    sourceAssetId: z.uuid().optional(),
    items: z.array(SubtitleSchema).max(MAX_SUBTITLES),
  }),
  z.object({ kind: z.literal('overlay'), item: OverlaySchema }),
  z.object({ kind: z.literal('audio'), item: AudioElementSchema }),
  z.object({ kind: z.literal('clip-audio'), id: z.uuid(), settings: AudioSettingsSchema }),
  z.object({ kind: z.literal('delete-element'), id: z.union([z.uuid(), z.literal('subtitles')]) }),
  z.object({ kind: z.literal('layer'), id: z.uuid(), position: z.enum(['front', 'back']) }),
]);
export type ElementOperation = z.infer<typeof ElementOperationSchema>;
export function applyElementOperation<
  T extends {
    revision: number;
    clips: { id: string; startFrame: number; endFrame: number; audio?: AudioSettings }[];
    packaging?: Packaging;
  },
>(timeline: T, op: ElementOperation): T {
  const p = structuredClone(timeline.packaging ?? emptyPackaging());
  let clips = [...timeline.clips];
  const update = <U extends { id: string }>(list: U[], item: U) =>
    list.some((v) => v.id === item.id)
      ? list.map((v) => (v.id === item.id ? item : v))
      : [...list, item];
  if (op.kind === 'subtitle') p.subtitles = update(p.subtitles, op.item);
  else if (op.kind === 'subtitle-style') p.subtitleStyle = op.style;
  else if (op.kind === 'subtitle-replace') p.subtitles = op.items;
  else if (op.kind === 'overlay') p.overlays = update(p.overlays, op.item);
  else if (op.kind === 'audio') p.audio = update(p.audio, op.item);
  else if (op.kind === 'clip-audio') {
    if (!clips.some((c) => c.id === op.id)) throw new Error('Clip已不存在');
    clips = clips.map((c) => (c.id === op.id ? { ...c, audio: op.settings } : c));
  } else if (op.kind === 'delete-element') {
    if (op.id === 'subtitles') p.subtitles = [];
    else {
      if (![...p.subtitles, ...p.overlays, ...p.audio].some((v) => v.id === op.id))
        throw new Error('元素已不存在');
      p.subtitles = p.subtitles.filter((v) => v.id !== op.id);
      p.overlays = p.overlays.filter((v) => v.id !== op.id);
      p.audio = p.audio.filter((v) => v.id !== op.id);
    }
  } else {
    const item = p.overlays.find((v) => v.id === op.id);
    if (!item) throw new Error('图文元素已不存在');
    const rest = p.overlays.filter((v) => v.id !== op.id);
    p.overlays = op.position === 'front' ? [...rest, item] : [item, ...rest];
  }
  const frames = clips.reduce((n, c) => n + c.endFrame - c.startFrame + 1, 0);
  if (frames === 0 && op.kind !== 'delete-element')
    throw new Error('暂无主视频，辅助元素仅可查看或删除');
  if (op.kind === 'subtitle') {
    const old = timeline.packaging?.subtitles.find((s) => s.id === op.item.id);
    if (!old || old.startFrame !== op.item.startFrame || old.endFrame !== op.item.endFrame)
      if (op.item.endFrame < op.item.startFrame || op.item.endFrame >= frames)
        throw new Error('字幕范围超出当前主视频');
  }
  if (op.kind === 'subtitle-replace')
    for (const s of op.items)
      if (s.endFrame < s.startFrame || s.endFrame >= frames)
        throw new Error('字幕范围超出当前主视频');
  if (op.kind === 'overlay' || op.kind === 'audio') {
    const r = plannedRange(op.item.range, frames);
    const old =
      op.kind === 'overlay'
        ? timeline.packaging?.overlays.find((o) => o.id === op.item.id)
        : timeline.packaging?.audio.find((a) => a.id === op.item.id);
    if (!old || JSON.stringify(old.range) !== JSON.stringify(op.item.range))
      if (r.endFrame < r.startFrame || r.endFrame >= frames || r.startFrame >= frames)
        throw new Error('时间范围超出当前主视频');
  }
  for (const c of clips)
    if (c.audio && c.audio.fadeIn + c.audio.fadeOut > c.endFrame - c.startFrame + 1)
      throw new Error('原声淡化超过Clip长度');
  validatePackaging(p, frames);
  return { ...timeline, revision: timeline.revision + 1, clips, packaging: p };
}
export const ElementEditSchema = z.object({
  requestId: z.uuid(),
  expectedRevision: z.number().int().nonnegative(),
  kind: z.enum([
    'subtitle',
    'subtitle-style',
    'subtitle-replace',
    'text',
    'image',
    'audio',
    'clip-audio',
    'delete-element',
    'layer',
    'copy-overlay',
  ]),
  id: z.union([z.uuid(), z.literal('subtitles')]).optional(),
  assetId: z.uuid().optional(),
  text: z.string().max(2000).optional(),
  startFrame: z.number().int().nonnegative().optional(),
  endFrame: z.number().int().nonnegative().optional(),
  playhead: z.number().int().nonnegative().default(0),
  range: ElementRangeSchema.optional(),
  style: TextStylePatchSchema.optional(),
  x: z.number().min(0).max(100).optional(),
  y: z.number().min(0).max(100).optional(),
  width: z.number().min(1).max(100).optional(),
  opacity: z.number().min(0).max(100).optional(),
  role: z.enum(['narration', 'bgm']).optional(),
  sourceStart: z.number().int().nonnegative().optional(),
  sourceEnd: z.number().int().nonnegative().optional(),
  settings: AudioSettingsPatchSchema.optional(),
  loop: z.boolean().optional(),
  position: z.enum(['front', 'back']).optional(),
  title: z.boolean().default(true),
  placement: z
    .enum([
      'top-left',
      'top-center',
      'top-right',
      'center-left',
      'center',
      'center-right',
      'bottom-left',
      'bottom-center',
      'bottom-right',
    ])
    .optional(),
  fadeInTime: z.string().optional(),
  fadeOutTime: z.string().optional(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  sourceStartTime: z.string().optional(),
  sourceEndTime: z.string().optional(),
  whole: z.boolean().optional(),
});
export type ElementEdit = z.infer<typeof ElementEditSchema>;
export const ElementEditLabels: Record<ElementEdit['kind'], string> = {
  subtitle: '字幕',
  'subtitle-style': '统一字幕样式',
  'subtitle-replace': 'SRT整轨替换',
  text: '标题 / 说明文字',
  image: '图像 / Logo',
  audio: '旁白 / BGM',
  'clip-audio': '片段原声',
  'delete-element': '删除元素',
  layer: '调整图层',
  'copy-overlay': '复制图文',
};
export const CompositionManifestSchema = z.object({
  hash: z.string(),
  frames: z.number().int().positive(),
  canvas: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
  overlays: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      x: z.number(),
      y: z.number(),
      width: z.number().positive(),
      height: z.number().positive(),
      startFrame: z.number().int(),
      endFrame: z.number().int(),
    }),
  ),
  audioKey: z.string(),
  fontHash: z.string(),
});
export type CompositionManifest = z.infer<typeof CompositionManifestSchema>;
export const CompositionStateSchema = z.object({
  status: z.enum(['processing', 'ready', 'failed']),
  revision: z.number().int(),
  error: z.string().nullable(),
  manifest: CompositionManifestSchema.nullable(),
});
export type CompositionState = z.infer<typeof CompositionStateSchema>;
