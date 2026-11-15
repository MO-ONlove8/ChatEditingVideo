import { describe, it, expect } from 'vitest';
import { IntentSchema } from '@cev/shared';
import { explicitParameters } from './explicit-parameters.js';
const id = '00000000-0000-4000-8000-000000000401';
const intent = (element: unknown) =>
  IntentSchema.parse({
    kind: 'element',
    sourceNumber: null,
    startTime: null,
    endTime: null,
    destination: null,
    targetNumber: null,
    message: '候选',
    element,
  });
describe('literal parameters and model defaults', () => {
  it('preserves every explicit audio parameter and rejects a source as a target', () => {
    const result = explicitParameters(
      intent({
        kind: 'audio',
        id,
        assetId: id,
        role: 'bgm',
        whole: true,
        startTime: '00:00:00',
        endTime: '00:00:00',
        sourceStartTime: '00:00:00',
        sourceEndTime: '00:00:00',
      }),
      '添加AUD1作为全片BGM，音量20%，循环，淡入1秒',
      { assets: [{ id, label: 'AUD1' }] },
    );
    expect(result.element).toMatchObject({
      kind: 'audio',
      assetId: id,
      whole: true,
      loop: true,
      fadeInTime: '00:01:00',
      settings: { volume: 20 },
    });
    expect(result.element).not.toHaveProperty('id');
    expect(result.element).not.toHaveProperty('startTime');
    expect(result.element).not.toHaveProperty('sourceEndTime');
  });
  it('does not reset title time or unmentioned style fields', () => {
    const result = explicitParameters(
      intent({
        kind: 'text',
        id,
        text: '旅行',
        startTime: '00:00:00',
        endTime: '00:30:00',
        style: { backgroundOpacity: 50 },
      }),
      '这个标题改成「旅行」',
      { selectedId: id },
    );
    expect(result.element).not.toHaveProperty('endTime');
    expect(result.element?.style).toEqual({});
  });
  it('all subtitle style changes are literal patches', () => {
    const result = explicitParameters(
      intent({ kind: 'subtitle-style', style: { color: '#FFFFFF', backgroundOpacity: 0.5 } }),
      '给所有字幕统一设置白色粗体',
      {},
    );
    expect(result.element?.style).toEqual({ color: '#FFFFFF', bold: true });
  });
  it('keeps zero gain and explicit mute/loop toggles', () => {
    const result = explicitParameters(
      intent({ kind: 'audio', settings: { volume: 100, muted: true }, loop: true }),
      'A1音量0%，恢复声音，关闭循环',
      {},
    );
    expect(result.element?.settings).toEqual({ volume: 0, muted: false });
    expect(result.element?.loop).toBe(false);
  });
  it('clarifies ambiguous references and freezes the selected object instead of model guesses', () => {
    const inferred = intent({
      kind: 'text',
      id: '00000000-0000-4000-8000-000000000402',
      text: '新标题',
    });
    expect(explicitParameters(inferred, '这个标题改成新标题', {})).toMatchObject({
      kind: 'clarify',
      element: null,
    });
    expect(explicitParameters(inferred, '这个标题改成新标题', { selectedId: id }).element?.id).toBe(
      id,
    );
  });
});
