import { describe, it, expect } from 'vitest';
import {
  emptyPackaging,
  validatePackaging,
  effectiveRange,
  packagingImpacts,
  defaultAudio,
  applyElementOperation,
  defaultTextStyle,
  TextStylePatchSchema,
  AudioSettingsPatchSchema,
  validateText,
} from './elements.js';
import { parseSrt, exportSrt } from './srt.js';
const id = '01900000-0000-4000-8000-000000000001';
describe('D1字幕与时间', () => {
  it('局部参数不补默认值，颜色支持数字通道', () => {
    expect(TextStylePatchSchema.parse({ bold: true, color: '#123456' })).toEqual({
      bold: true,
      color: '#123456',
    });
    expect(AudioSettingsPatchSchema.parse({ muted: true })).toEqual({ muted: true });
  });
  it('SRT使用排他结束，共用2.001秒边界', () => {
    const cues = parseSrt(
      '1\n00:00:01,000 --> 00:00:02,001\n你好\n\n2\n00:00:02,001 --> 00:00:03,000\n世界',
      90,
    );
    expect(cues.map((c) => [c.startFrame, c.endFrame])).toEqual([
      [30, 59],
      [60, 89],
    ]);
  });
  it('量化为零帧不补帧，错误定位到原条目', () =>
    expect(() => parseSrt('7\n00:00:01,001 --> 00:00:01,002\n你好')).toThrow('原序号7'));
  it('原始区间重叠不能因量化相邻而通过', () =>
    expect(() =>
      parseSrt('1\n00:00:01,000 --> 00:00:02,001\n甲\n\n2\n00:00:02,000 --> 00:00:03,000\n乙'),
    ).toThrow('重叠'));
  it('拒绝内嵌样式和错误范围', () => {
    expect(() => parseSrt('1\n00:00:00,000 --> 00:00:01,000\n<b>甲</b>')).toThrow('纯文本');
    expect(() => parseSrt('1\n00:00:00,000 --> 00:00:01,001\n甲', 29)).toThrow('超出');
  });
  it('所有帧余数及末帧均可SRT往返，导出只保留有效区间', () => {
    for (let start = 0; start < 90; start++) {
      const text = exportSrt(
        [{ id, number: 7, text: '中文', startFrame: start, endFrame: start + 60 }],
        100,
      );
      const cue = parseSrt(text, 100)[0]!;
      expect([cue.startFrame, cue.endFrame]).toEqual([start, Math.min(start + 60, 99)]);
    }
  });
  it('计划区间包括暂不生效对象，相邻合法', () => {
    const p = emptyPackaging();
    p.subtitles = [
      { id, number: 1, text: '甲', startFrame: 180, endFrame: 200 },
      {
        id: '01900000-0000-4000-8000-000000000002',
        number: 2,
        text: '乙',
        startFrame: 201,
        endFrame: 210,
      },
    ];
    expect(() => validatePackaging(p, 120)).not.toThrow();
    p.subtitles[1]!.startFrame = 200;
    expect(() => validatePackaging(p, 120)).toThrow('重叠');
  });
  it('缩短保留计划，恢复与全片区分', () => {
    const p = emptyPackaging();
    p.subtitles = [{ id, number: 5, text: '甲', startFrame: 180, endFrame: 210 }];
    expect(packagingImpacts(p, 300, 120)[0]?.state).toBe('inactive');
    expect(packagingImpacts(p, 120, 300)[0]?.state).toBe('restored');
    expect(p.subtitles[0]!.startFrame).toBe(180);
    expect(effectiveRange({ mode: 'whole' }, 0)).toBeNull();
  });
  it('全片BGM淡化不因静音豁免，空主轨可保留', () => {
    const p = emptyPackaging();
    p.audio = [
      {
        id,
        number: 1,
        assetId: id,
        generation: 1,
        role: 'bgm',
        sourceStart: 0,
        sourceEnd: 59,
        range: { mode: 'whole' },
        loop: true,
        settings: { ...defaultAudio(), muted: true, fadeIn: 60, fadeOut: 60 },
      },
    ];
    expect(() => validatePackaging(p, 119)).toThrow('淡化');
    expect(() => validatePackaging(p, 120)).not.toThrow();
    expect(() => validatePackaging(p, 0)).not.toThrow();
  });
  it('空主轨禁止新增辅助，删除不需要预览', () => {
    const t = { revision: 2, clips: [], packaging: emptyPackaging() };
    expect(() =>
      applyElementOperation(t, {
        kind: 'overlay',
        item: {
          id,
          number: 1,
          kind: 'text',
          text: '标题',
          style: defaultTextStyle(),
          range: { mode: 'whole' },
        },
      }),
    ).toThrow('暂无主视频');
    expect(applyElementOperation(t, { kind: 'delete-element', id: 'subtitles' }).revision).toBe(3);
  });
  it('按Unicode码点校验200边界，拒绝空白及多行', () => {
    expect(() => validateText('𠮷'.repeat(200), 2)).not.toThrow();
    expect(() => validateText('𠮷'.repeat(201), 2)).toThrow('200');
    expect(() => validateText(' \n ', 2)).toThrow('不能为空');
    expect(() => validateText('甲\n乙\n丙', 2)).toThrow('2行');
    expect(() => validateText('甲\n乙\n丙\n丁', 4)).not.toThrow();
    expect(() => validateText('甲\n乙\n丙\n丁\n戊', 4)).toThrow('4行');
  });
  it('1000/1001字幕和20/21图文包括暂不生效、透明元素', () => {
    const uuid = (n: number) => '01900000-0000-4000-8000-' + String(n).padStart(12, '0');
    const p = emptyPackaging();
    p.subtitles = Array.from({ length: 1000 }, (_, i) => ({
      id: uuid(i + 1),
      number: i + 1,
      text: '甲',
      startFrame: i * 2,
      endFrame: i * 2,
    }));
    expect(() => validatePackaging(p, 1)).not.toThrow();
    p.subtitles.push({
      id: uuid(1001),
      number: 1001,
      text: '乙',
      startFrame: 2000,
      endFrame: 2000,
    });
    expect(() => validatePackaging(p, 1)).toThrow();
    p.subtitles.pop();
    p.overlays = Array.from({ length: 20 }, (_, i) => ({
      id: uuid(i + 2000),
      number: i + 1,
      kind: 'text',
      text: '甲',
      style: { ...defaultTextStyle(), opacity: 0 },
      range: { mode: 'fixed', startFrame: 90, endFrame: 120 },
    }));
    expect(() => validatePackaging(p, 1)).not.toThrow();
    p.overlays.push({ ...p.overlays[0]!, id: uuid(3000), number: 21 });
    expect(() => validatePackaging(p, 1)).toThrow();
  });
  it('SRT稳定排序并拒绝1001条，单帧边界回导不丢帧', () => {
    const cues = Array.from({ length: 1000 }, (_, i) => ({
      id,
      number: i + 1,
      text: '字幕',
      startFrame: i * 2,
      endFrame: i * 2,
    }));
    const text = exportSrt(cues, 2000);
    expect(parseSrt(text, 2000).map((s) => [s.startFrame, s.endFrame])).toEqual(
      cues.map((s) => [s.startFrame, s.endFrame]),
    );
    expect(() => parseSrt(text + '\n\n1001\n00:01:07,000 --> 00:01:08,000\n额外')).toThrow('1000');
    expect(
      parseSrt('2\n00:00:01,000 --> 00:00:02,000\n乙\n\n2\n00:00:00,000 --> 00:00:01,000\n甲').map(
        (s) => s.text,
      ),
    ).toEqual(['甲', '乙']);
  });
});
