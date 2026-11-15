import type { Subtitle } from './elements.js';
import { MAX_SUBTITLES, validateText } from './elements.js';

export type SrtCue = {
  originalNumber: string;
  position: number;
  text: string;
  startFrame: number;
  endFrame: number;
  startMs: number;
  endMs: number;
};
export class SrtError extends Error {
  constructor(
    readonly position: number,
    readonly originalNumber: string,
    reason: string,
  ) {
    super(`第${position}条（原序号${originalNumber}）：${reason}`);
  }
}
const quantize = (ms: number) => Math.floor((ms * 30 + 500) / 1000);
const toMs = (value: string) => {
  const m = /^(\d{2,}):([0-5]\d):([0-5]\d),(\d{3})$/.exec(value);
  if (!m) throw new Error('请使用 HH:MM:SS,mmm 时间格式');
  const v = ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4]);
  if (!Number.isSafeInteger(v) || v > Number.MAX_SAFE_INTEGER / 30) throw new Error('时间数值过大');
  return v;
};
export function parseSrt(input: string, frames?: number): SrtCue[] {
  const text = input
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .trim();
  if (!text) throw new Error('SRT没有字幕');
  const blocks = text.split(/\n[ \t]*\n+/);
  if (blocks.length > MAX_SUBTITLES) throw new Error('SRT最多1000条字幕');
  const cues = blocks
    .map((block, i) => {
      const lines = block.split('\n'),
        originalNumber = lines.shift()?.trim() ?? '?';
      try {
        if (!/^\d+$/.test(originalNumber)) throw new Error('缺少合法条目序号');
        const time = /^(\S+)\s+-->\s+(\S+)$/.exec(lines.shift()?.trim() ?? '');
        if (!time) throw new Error('时间行格式错误');
        const startMs = toMs(time[1]!),
          endMs = toMs(time[2]!);
        if (endMs <= startMs) throw new Error('结束时间必须晚于开始');
        const content = lines.join('\n');
        validateText(content, 2);
        if (/<[^>]*>|\{\\[^}]*\}/u.test(content)) throw new Error('不支持格式标签，请使用纯文本');
        const startFrame = quantize(startMs),
          endFrame = quantize(endMs) - 1;
        if (endFrame < startFrame) throw new Error('量化后为零帧，不能自动补帧');
        if (frames !== undefined && (startFrame >= frames || endFrame >= frames))
          throw new Error('字幕超出当前主视频');
        return {
          originalNumber,
          position: i + 1,
          text: content,
          startMs,
          endMs,
          startFrame,
          endFrame,
        };
      } catch (e) {
        throw new SrtError(i + 1, originalNumber, (e as Error).message);
      }
    })
    .sort((a, b) => a.startMs - b.startMs || a.position - b.position);
  for (let i = 1; i < cues.length; i++) {
    const a = cues[i - 1]!,
      b = cues[i]!;
    if (b.startMs < a.endMs || b.startFrame <= a.endFrame)
      throw new SrtError(b.position, b.originalNumber, '字幕区间重叠');
  }
  return cues;
}
const timestamp = (frame: number) => {
  const ms = Math.floor((frame * 1000 + 15) / 30);
  const h = Math.floor(ms / 3600000),
    m = Math.floor(ms / 60000) % 60,
    s = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
};
export function exportSrt(subtitles: Subtitle[], frames: number) {
  const cues = subtitles
    .filter((s) => s.startFrame < frames)
    .sort((a, b) => a.startFrame - b.startFrame);
  if (frames <= 0 || !cues.length) throw new Error('当前没有有效字幕');
  return cues
    .map(
      (s, i) =>
        `${i + 1}\n${timestamp(s.startFrame)} --> ${timestamp(Math.min(s.endFrame + 1, frames))}\n${s.text}\n`,
    )
    .join('\n');
}
