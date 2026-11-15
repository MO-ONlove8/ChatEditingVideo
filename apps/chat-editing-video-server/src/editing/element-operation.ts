import { randomUUID } from 'node:crypto';
import {
  AudioElementSchema,
  AudioSettingsSchema,
  OverlaySchema,
  SubtitleSchema,
  TextStyleSchema,
  applyOperation,
  defaultAudio,
  defaultTextStyle,
  effectiveRange,
  emptyPackaging,
  parseTimecode,
  plannedRange,
  timelineFrames,
  formatTimecode,
  type ElementEdit,
  type ElementOperation,
  type MediaAsset,
  type Timeline,
} from '@cev/shared';

export function resolveElementEdit(
  input: ElementEdit,
  t: Timeline,
  assets: MediaAsset[],
  allocate: (prefix: string) => number,
) {
  const p = t.packaging ?? emptyPackaging(),
    frames = timelineFrames(t),
    details: string[] = [];
  if (input.startTime !== undefined)
    input = { ...input, startFrame: parseTimecode(input.startTime) };
  if (input.endTime !== undefined) input = { ...input, endFrame: parseTimecode(input.endTime) };
  if (input.sourceStartTime !== undefined)
    input = { ...input, sourceStart: parseTimecode(input.sourceStartTime) };
  if (input.sourceEndTime !== undefined)
    input = { ...input, sourceEnd: parseTimecode(input.sourceEndTime) };
  if (input.text !== undefined) input = { ...input, text: input.text.replace(/\r\n?/g, '\n') };
  if (input.fadeInTime !== undefined)
    input = { ...input, settings: { ...input.settings, fadeIn: parseTimecode(input.fadeInTime) } };
  if (input.fadeOutTime !== undefined)
    input = {
      ...input,
      settings: { ...input.settings, fadeOut: parseTimecode(input.fadeOutTime) },
    };
  const all = [...p.subtitles, ...p.overlays, ...p.audio],
    existing = input.id ? all.find((v) => v.id === input.id) : undefined;
  if (input.id && input.id !== 'subtitles' && !existing && input.kind !== 'clip-audio')
    throw new Error('当前对象不存在，请根据最新编号重试');
  const range = (old?: Parameters<typeof plannedRange>[0]) => {
    if (input.range) return input.range;
    if (input.whole) return { mode: 'whole' as const };
    if (
      input.startFrame === undefined &&
      input.endFrame === undefined &&
      old &&
      input.whole !== false
    )
      return old;
    const oldRange = old ? plannedRange(old, frames) : undefined;
    const startFrame = input.startFrame ?? oldRange?.startFrame ?? input.playhead;
    if (startFrame >= frames) throw new Error('请先将播放头定位到当前主视频内');
    const endFrame = input.endFrame ?? oldRange?.endFrame ?? Math.min(startFrame + 89, frames - 1);
    if (input.startFrame === undefined || input.endFrame === undefined)
      details.push(`默认固定时间：${startFrame}～${endFrame}，共${endFrame - startFrame + 1}帧`);
    return { mode: 'fixed' as const, startFrame, endFrame };
  };
  const identity = (prefix: string) =>
    existing
      ? { id: existing.id, number: existing.number }
      : { id: randomUUID(), number: allocate(prefix) };
  const source = (kind: 'image' | 'audio' | 'srt') => {
    const a = assets.find((a) => a.id === input.assetId && a.kind === kind && a.status === 'ready');
    if (!a) throw new Error(`请选择已就绪的${kind}文件`);
    return a;
  };
  let op: ElementOperation;
  if (input.kind === 'subtitle') {
    const old = p.subtitles.find((s) => s.id === input.id),
      r = range(old ? { mode: 'fixed', ...old } : undefined);
    if (r.mode === 'whole') throw new Error('字幕不支持全片模式');
    if (old && !effectiveRange({ mode: 'fixed', ...old }, frames))
      throw new Error('暂不生效字幕仅可查看或删除');
    op = {
      kind: 'subtitle',
      item: SubtitleSchema.parse({ ...identity('S'), text: input.text ?? old?.text, ...r }),
    };
  } else if (input.kind === 'subtitle-style')
    op = {
      kind: 'subtitle-style',
      style: TextStyleSchema.parse({ ...p.subtitleStyle, ...input.style }),
    };
  else if (input.kind === 'subtitle-replace') {
    const a = source('srt');
    if (!a.auxiliary?.cues?.length) throw new Error('SRT没有有效解析结果');
    op = {
      kind: 'subtitle-replace',
      sourceAssetId: a.id,
      items: a.auxiliary.cues.map((s) => ({
        id: randomUUID(),
        number: allocate('S'),
        text: s.text,
        startFrame: s.startFrame,
        endFrame: s.endFrame,
      })),
    };
    details.push(
      `现有${p.subtitles.length}条 → 删除${p.subtitles.length}条 → 新建${op.items.length}条；整轨替换，不合并。`,
    );
    details.push(
      ...a.auxiliary.cues.map(
        (s) =>
          `原条目${s.originalNumber}（位置${s.position}）：${s.startMs}～${s.endMs}毫秒 → ${s.startFrame}～${s.endFrame}帧`,
      ),
    );
  } else if (input.kind === 'text' || input.kind === 'image') {
    const old = p.overlays.find((o) => o.id === input.id);
    if (old && old.kind !== input.kind) throw new Error('目标对象类型不同');
    if (old && !effectiveRange(old.range, frames)) throw new Error('暂不生效对象仅可查看或删除');
    if (input.kind === 'text')
      op = {
        kind: 'overlay',
        item: OverlaySchema.parse({
          ...identity('T'),
          kind: 'text',
          text: input.text ?? (old?.kind === 'text' ? old.text : undefined),
          range: range(old?.range),
          style: {
            ...(old?.kind === 'text' ? old.style : defaultTextStyle(input.title)),
            ...input.style,
          },
        }),
      };
    else {
      const a = input.assetId
        ? source('image')
        : assets.find((a) => old?.kind === 'image' && a.id === old.assetId);
      if (!a?.auxiliary?.width || !a.auxiliary.height || !t.canvas)
        throw new Error('请选择有效图像文件');
      const defaultWidth = Math.min(
        25,
        (((t.canvas.height / t.canvas.width) * a.auxiliary.width) / a.auxiliary.height) * 100,
      );
      op = {
        kind: 'overlay',
        item: OverlaySchema.parse({
          ...identity('I'),
          kind: 'image',
          assetId: a.id,
          generation: a.generation,
          range: range(old?.range),
          x: input.x ?? (old?.kind === 'image' ? old.x : 50),
          y: input.y ?? (old?.kind === 'image' ? old.y : 50),
          width: input.width ?? (old?.kind === 'image' ? old.width : defaultWidth),
          opacity: input.opacity ?? (old?.kind === 'image' ? old.opacity : 100),
        }),
      };
    }
  } else if (input.kind === 'audio') {
    const old = p.audio.find((a) => a.id === input.id),
      a = input.assetId ? source('audio') : assets.find((a) => a.id === old?.assetId);
    if (!a?.auxiliary?.frames) throw new Error('请选择有效音频文件');
    if (old && !effectiveRange(old.range, frames)) throw new Error('暂不生效声音仅可查看或删除');
    const role = input.role ?? old?.role;
    if (!role) throw new Error('请选择旁白或BGM角色');
    const start = input.sourceStart ?? old?.sourceStart ?? 0,
      end = input.sourceEnd ?? old?.sourceEnd ?? a.auxiliary.frames - 1;
    let placement = input.range ?? (input.whole ? { mode: 'whole' as const } : old?.range);
    if (
      !placement ||
      input.whole === false ||
      input.startFrame !== undefined ||
      input.endFrame !== undefined
    ) {
      const oldPlanned = old ? plannedRange(old.range, frames) : undefined;
      const s = input.startFrame ?? oldPlanned?.startFrame ?? input.playhead;
      if (s >= frames) throw new Error('请先将播放头定位到当前主视频内');
      const candidate = s + end - start;
      placement = {
        mode: 'fixed',
        startFrame: s,
        endFrame: input.endFrame ?? oldPlanned?.endFrame ?? Math.min(candidate, frames - 1),
      };
      if (input.endFrame === undefined)
        details.push(
          `默认作用范围${s}～${placement.endFrame}；源${end - start + 1}帧，尾部截出${Math.max(0, candidate - frames + 1)}帧`,
        );
    }
    op = {
      kind: 'audio',
      item: AudioElementSchema.parse({
        ...identity('A'),
        role,
        assetId: a.id,
        generation: a.generation,
        sourceStart: start,
        sourceEnd: end,
        range: placement,
        loop: input.loop ?? old?.loop ?? false,
        settings: {
          ...(old?.settings ?? { ...defaultAudio(), volume: role === 'bgm' ? 20 : 100 }),
          ...input.settings,
        },
      }),
    };
    if (!op.item.loop) details.push('不循环，源播放结束后静音。');
    const r = plannedRange(placement, frames),
      n = r.endFrame - r.startFrame + 1;
    if (
      !op.item.loop &&
      op.item.settings.fadeOut > 0 &&
      end - start + 1 <= n - op.item.settings.fadeOut
    )
      details.push('淡出区间没有声音');
  } else if (input.kind === 'clip-audio') {
    const clip = t.clips.find((c) => c.id === input.id);
    if (!clip) throw new Error('Clip不存在');
    op = {
      kind: 'clip-audio',
      id: clip.id,
      settings: AudioSettingsSchema.parse({ ...defaultAudio(), ...clip.audio, ...input.settings }),
    };
  } else if (input.kind === 'delete-element') {
    if (!input.id) throw new Error('请选择删除对象');
    op = { kind: 'delete-element', id: input.id };
    details.push(
      input.id === 'subtitles'
        ? `删除全轨${p.subtitles.length}条字幕；不可撤销`
        : '仅删除元素，不删除源文件；不可撤销',
    );
  } else if (input.kind === 'layer') {
    if (!input.id || input.id === 'subtitles' || !input.position)
      throw new Error('请选择图文对象及置顶/置底');
    const target = p.overlays.find((o) => o.id === input.id);
    if (!target || !effectiveRange(target.range, frames))
      throw new Error('暂不生效对象仅可查看或删除');
    op = { kind: 'layer', id: input.id, position: input.position };
  } else {
    const original = p.overlays.find((o) => o.id === input.id);
    if (!original) throw new Error('只支持复制文字或图像');
    if (!effectiveRange(original.range, frames)) throw new Error('暂不生效对象仅可查看或删除');
    if (input.startFrame === undefined) throw new Error('复制需要指定新起帧');
    const r = plannedRange(original.range, frames),
      length = r.endFrame - r.startFrame + 1;
    op = {
      kind: 'overlay',
      item: {
        ...structuredClone(original),
        id: randomUUID(),
        number: allocate(original.kind === 'text' ? 'T' : 'I'),
        range: {
          mode: 'fixed',
          startFrame: input.startFrame,
          endFrame: input.startFrame + length - 1,
        },
      },
    };
    details.push('复制产生新身份；全片复制转为固定区间');
  }
  if (op.kind === 'overlay' && input.placement && t.canvas) {
    const row = input.placement.startsWith('top')
      ? 0
      : input.placement.startsWith('bottom')
        ? 2
        : 1;
    const col = input.placement.endsWith('left') ? 0 : input.placement.endsWith('right') ? 2 : 1;
    if (op.item.kind === 'text') {
      const style = op.item.style;
      op = {
        ...op,
        item: {
          ...op.item,
          style: {
            ...style,
            x: [style.width / 2, 50, 100 - style.width / 2][col]!,
            y: [0, 50, 100][row]!,
            anchor: row === 0 ? 'top' : row === 2 ? 'bottom' : 'center',
          },
        },
      };
    } else {
      const source = assets.find(
        (a) => a.id === (op.kind === 'overlay' && op.item.kind === 'image' ? op.item.assetId : ''),
      )!.auxiliary!;
      const w = op.item.width,
        h = (((w * t.canvas.width) / t.canvas.height) * source.height!) / source.width!;
      op = {
        ...op,
        item: { ...op.item, x: [w / 2, 50, 100 - w / 2][col]!, y: [h / 2, 50, 100 - h / 2][row]! },
      };
    }
  }
  const candidate = applyOperation(t, op);
  const timing = (r: Parameters<typeof plannedRange>[0]) => {
    const v = plannedRange(r, frames);
    return `${r.mode === 'whole' ? '全片 · ' : ''}${formatTimecode(v.startFrame)} → ${formatTimecode(v.endFrame)}，${v.endFrame - v.startFrame + 1}帧`;
  };
  const sound = (s: ReturnType<typeof defaultAudio>) =>
    `音量${s.volume}%${s.muted ? '（静音，保留音量）' : ''}；淡入${formatTimecode(s.fadeIn)}，淡出${formatTimecode(s.fadeOut)}`;
  if (op.kind === 'subtitle')
    details.unshift(
      `S${op.item.number}：“${op.item.text}”；${timing({ mode: 'fixed', ...op.item })}`,
    );
  if (op.kind === 'overlay') {
    const o = op.item;
    details.unshift(
      o.kind === 'text'
        ? `T${o.number}：“${o.text}”；${timing(o.range)}；字号${o.style.size}%短边，文本框${o.style.width}%，位置${o.style.x}% / ${o.style.y}%，${o.style.bold ? '粗体' : '常规'}，字色${o.style.color}，不透明度${o.style.opacity}%`
        : `I${o.number}：IMG${assets.find((a) => a.id === o.assetId)?.number}；${timing(o.range)}；宽度${o.width}%，中心${o.x}% / ${o.y}%，不透明度${o.opacity}%`,
    );
  }
  if (op.kind === 'audio')
    details.unshift(
      `A${op.item.number} · ${op.item.role === 'bgm' ? 'BGM' : '旁白'}：AUD${assets.find((a) => a.id === op.item.assetId)?.number}，源${formatTimecode(op.item.sourceStart)} → ${formatTimecode(op.item.sourceEnd)}；${timing(op.item.range)}；${sound(op.item.settings)}；${op.item.loop ? '循环' : '不循环'}`,
    );
  if (op.kind === 'clip-audio')
    details.unshift(
      `Clip${t.clips.findIndex((c) => c.id === op.id) + 1}原声：${sound(op.settings)}`,
    );
  if (op.kind === 'subtitle-style')
    details.unshift(
      `全轨${p.subtitles.length}条字幕；字号${op.style.size}%短边，文本框${op.style.width}%，位置${op.style.x}% / ${op.style.y}%，${op.style.bold ? '粗体' : '常规'}，字色${op.style.color}，不透明度${op.style.opacity}%`,
    );
  details.push('时间为固定绝对位置，不随Clip移动；仅明确全片模式随片长变化。');
  return { operation: op, candidate, details };
}
