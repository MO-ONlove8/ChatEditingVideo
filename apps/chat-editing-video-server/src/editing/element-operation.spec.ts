import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  ElementEditSchema,
  MediaAssetSchema,
  defaultAudio,
  defaultTextStyle,
  emptyPackaging,
  type Timeline,
} from '@cev/shared';
import { resolveElementEdit } from './element-operation.js';
import { subtitleContext } from './subtitle-context.js';
const id = randomUUID(),
  source = randomUUID();
const timeline = (): Timeline => ({
  revision: 1,
  fps: 30,
  canvas: { width: 1920, height: 1080 },
  clips: [{ id, source, generation: 1, startFrame: 0, endFrame: 299 }],
  packaging: emptyPackaging(),
});
const asset = MediaAssetSchema.parse({
  id: source,
  projectId: id,
  kind: 'audio',
  fileName: 'voice.wav',
  mimeType: 'audio/wav',
  sizeBytes: 1000,
  storageKey: 'source.wav',
  number: 1,
  status: 'ready',
  stage: 'ready',
  progress: 100,
  error: null,
  generation: 1,
  deleting: false,
  original: null,
  normalized: null,
  auxiliary: { frames: 300, workingKey: 'source.wav' },
  createdAt: new Date().toISOString(),
});
const resolve = (input: Record<string, unknown>, t = timeline()) =>
  resolveElementEdit(
    ElementEditSchema.parse({ requestId: randomUUID(), expectedRevision: t.revision, ...input }),
    t,
    [asset],
    () => 1,
  );
describe('D1 operation boundaries', () => {
  it('resolves 60..89 as exactly 30 source frames and preserves volume on mute', () => {
    const first = resolve({
      kind: 'audio',
      assetId: source,
      role: 'narration',
      sourceStart: 60,
      sourceEnd: 89,
      startFrame: 0,
    }).candidate;
    expect(first.packaging?.audio[0]).toMatchObject({
      sourceStart: 60,
      sourceEnd: 89,
      range: { mode: 'fixed', startFrame: 0, endFrame: 29 },
      settings: { volume: 100 },
    });
    const a = first.packaging!.audio[0]!;
    expect(
      resolve({ kind: 'audio', id: a.id, settings: { muted: true } }, first).candidate.packaging
        ?.audio[0]?.settings,
    ).toEqual({ ...defaultAudio(), muted: true });
  });
  it('whole to fixed is explicit and never leaves old whole mode in audio', () => {
    const first = resolve({ kind: 'audio', assetId: source, role: 'bgm', whole: true }).candidate;
    const result = resolve(
      { kind: 'audio', id: first.packaging!.audio[0]!.id, whole: false },
      first,
    ).candidate;
    expect(result.packaging?.audio[0]?.range).toEqual({
      mode: 'fixed',
      startFrame: 0,
      endFrame: 299,
    });
  });
  it('inactive objects allow deletion but reject copy, layer and edits', () => {
    const t = timeline(),
      o = {
        id: randomUUID(),
        number: 9,
        kind: 'text' as const,
        text: '标题',
        style: defaultTextStyle(),
        range: { mode: 'fixed' as const, startFrame: 500, endFrame: 589 },
      };
    t.packaging!.overlays = [o];
    expect(() => resolve({ kind: 'copy-overlay', id: o.id, startFrame: 0 }, t)).toThrow('暂不生效');
    expect(() => resolve({ kind: 'layer', id: o.id, position: 'front' }, t)).toThrow('暂不生效');
    expect(
      resolve({ kind: 'delete-element', id: o.id }, t).candidate.packaging?.overlays,
    ).toHaveLength(0);
  });
  it('copy creates an independent identity and rejects even one frame beyond current end', () => {
    const t = timeline(),
      o = {
        id: randomUUID(),
        number: 7,
        kind: 'text' as const,
        text: '标题',
        style: defaultTextStyle(),
        range: { mode: 'whole' as const },
      };
    t.packaging!.overlays = [o];
    const copy = resolve({ kind: 'copy-overlay', id: o.id, startFrame: 0 }, t).candidate.packaging!
      .overlays[1]!;
    expect(copy.id).not.toBe(o.id);
    expect(copy.range).toEqual({ mode: 'fixed', startFrame: 0, endFrame: 299 });
    expect(() => resolve({ kind: 'copy-overlay', id: o.id, startFrame: 1 }, t)).toThrow('超出');
  });
  it('summarizes a thousand subtitles and retains selected, stable and ordinal refs', () => {
    const t = timeline();
    t.packaging!.subtitles = Array.from({ length: 1000 }, (_, i) => ({
      id: randomUUID(),
      number: i + 1,
      text: '字幕' + i,
      startFrame: i * 30,
      endFrame: i * 30 + 29,
    }));
    const result = subtitleContext(
      t,
      '修改S998和第十九条字幕',
      100,
      t.packaging!.subtitles[500]!.id,
    );
    expect(result.total).toBe(1000);
    expect(result.items.length).toBeLessThan(12);
    expect(result.items.map((s) => s.number)).toEqual(expect.arrayContaining([19, 501, 998]));
  });
});
