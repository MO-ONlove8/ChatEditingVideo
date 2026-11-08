import { describe, expect, it } from 'vitest';
import {
  applyOperation,
  clipFrames,
  emptyTimeline,
  outputCanvas,
  parseTimecode,
  timelineFrames,
  type EditOperation,
  type FrameClip,
  type Timeline,
} from './timeline.js';
const clip = (id: string, startFrame = 0, endFrame = 29): FrameClip => ({
  id,
  source: 'asset',
  generation: 1,
  startFrame,
  endFrame,
});
const add = (c: FrameClip): EditOperation => ({
  kind: 'add',
  clip: c,
  destination: { kind: 'end', clipId: null },
  canvas: outputCanvas(320, 180),
});
describe('integer frame editing', () => {
  it('includes both endpoints and accepts a single frame', () => {
    expect(clipFrames(clip('a', 150, 240))).toBe(91);
    expect(clipFrames(clip('a', 10, 20))).toBe(11);
    expect(clipFrames(clip('a', 20, 20))).toBe(1);
  });
  it('parses optional hours and omitted frames without rounding', () => {
    expect(parseTimecode('00:05:12')).toBe(162);
    expect(parseTimecode('01:00:05:12')).toBe(108162);
    expect(parseTimecode('00:05')).toBe(150);
  });
  it.each(['00:05:30', '00:60:00', '01:60:00:00', '-1:00:00', '5', '00:01.5:00'])(
    'rejects invalid time %s',
    (value) => {
      expect(() => parseTimecode(value)).toThrow();
    },
  );
  it('moves stable IDs, copies independently and inserts relative to remaining clips', () => {
    let t = applyOperation(applyOperation(emptyTimeline(), add(clip('a'))), add(clip('b')));
    t = applyOperation(t, {
      kind: 'move',
      clipId: 'a',
      newClipId: 'ignored',
      destination: { kind: 'after', clipId: 'b' },
    });
    expect(t.clips.map((c) => c.id)).toEqual(['b', 'a']);
    t = applyOperation(t, {
      kind: 'copy',
      clipId: 'a',
      newClipId: 'c',
      destination: { kind: 'before', clipId: 'b' },
    });
    expect(t.clips.map((c) => c.id)).toEqual(['c', 'b', 'a']);
    expect(t.clips[0]).not.toBe(t.clips[2]);
    expect(timelineFrames(t)).toBe(90);
  });
  it('retains the original canvas when emptied and re-filled', () => {
    const t = applyOperation(emptyTimeline(), add(clip('a')));
    const empty = { ...t, clips: [] };
    const updated = applyOperation(empty, {
      ...add(clip('b')),
      canvas: outputCanvas(180, 320),
    } as EditOperation);
    expect(updated.canvas).toEqual({ width: 1920, height: 1080 });
  });
  it('can place an independent copy next to its original', () => {
    const t = applyOperation(emptyTimeline(), add(clip('a')));
    const copied = applyOperation(t, {
      kind: 'copy',
      clipId: 'a',
      newClipId: 'copy',
      destination: { kind: 'after', clipId: 'a' },
    });
    expect(copied.clips.map((c) => c.id)).toEqual(['a', 'copy']);
    expect(copied.clips[1]).toMatchObject({ source: 'asset', startFrame: 0, endFrame: 29 });
    expect(t.clips).toHaveLength(1);
  });
  it('enforces inclusive frame duration and clip limits at exact boundaries', () => {
    expect(() => applyOperation(emptyTimeline(), add(clip('a', 0, 53999)))).not.toThrow();
    expect(() => applyOperation(emptyTimeline(), add(clip('a', 0, 54000)))).toThrow('30分钟');
    const t: Timeline = {
      ...emptyTimeline(),
      clips: Array.from({ length: 100 }, (_, i) => clip(String(i), 0, 0)),
    };
    expect(() => applyOperation(t, add(clip('next', 0, 0)))).toThrow('100');
  });
  it('rejects missing and self-referencing destinations', () => {
    const t = applyOperation(emptyTimeline(), add(clip('a')));
    expect(() =>
      applyOperation(t, {
        kind: 'move',
        clipId: 'a',
        newClipId: 'a',
        destination: { kind: 'before', clipId: 'a' },
      }),
    ).toThrow();
  });
});
