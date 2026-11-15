import { formatTimecode, type EditingIntent } from '@cev/shared';

/** Enforce literal parameters after inference; a model cannot invent defaults. */
export function explicitParameters(
  intent: EditingIntent,
  text: string,
  context: unknown,
): EditingIntent {
  if (intent.kind !== 'element' || !intent.element) return intent;
  const e = { ...intent.element },
    ctx = context as { selectedId?: string; assets?: { id: string; label: string }[] };
  const source = /\b(?:IMG|AUD|SRT)\d+\b/i.exec(text)?.[0];
  if (
    /这个|该标题|该文字|该字幕|该图像|该声音/.test(text) &&
    !/\b(?:S|T|I|A|Clip)\d+\b/i.test(text)
  ) {
    if (!ctx.selectedId)
      return {
        ...intent,
        kind: 'clarify',
        element: null,
        message: '请先选中要修改的对象，或提供明确的 S / T / I / A 编号。',
      };
    e.id = ctx.selectedId;
  }
  if (source) {
    const a = ctx.assets?.find((a) => a.label.toUpperCase() === source.toUpperCase());
    if (!a) throw new Error('来源文件编号不存在');
    e.assetId = a.id;
    if (e.id === a.id) delete e.id;
  }
  if (/(?:添加|新增|加一|新建|导入)/.test(text) && !/(?:修改|更改|替换|复制)/.test(text))
    delete e.id;
  const timingText = text.replace(/淡[入出]\s*\d+(?:\.\d+)?\s*(?:秒|帧)/g, '');
  const hasRange = /(?:\d+\s*[:：]|\d+\s*(?:秒|分|帧)|开头|结尾|起点|尾帧)/.test(timingText);
  if (!hasRange) {
    delete e.startTime;
    delete e.endTime;
  }
  if (!/(?:源选段|源起|源尾|源.*(?:从|秒|帧))/.test(text)) {
    delete e.sourceStartTime;
    delete e.sourceEndTime;
  }
  if (!/全片/.test(text)) delete e.whole;
  else e.whole = true;
  if (e.kind === 'audio' || e.kind === 'clip-audio') {
    const settings = { ...e.settings };
    const volume = /音量\s*(\d+(?:\.\d+)?)\s*[%％]/.exec(text);
    if (volume) settings.volume = Number(volume[1]);
    else if (!/音量|增益/.test(text)) delete settings.volume;
    if (/(?:取消|关闭|解除|恢复).*静音|恢复.*声音/.test(text)) settings.muted = false;
    else if (/静音/.test(text)) settings.muted = true;
    else delete settings.muted;
    delete settings.fadeIn;
    delete settings.fadeOut;
    e.settings = settings;
    for (const [word, key] of [
      ['入', 'fadeInTime'],
      ['出', 'fadeOutTime'],
    ] as const) {
      const match = new RegExp('淡' + word + '\\s*(\\d+(?:\\.\\d+)?)\\s*(秒|帧)').exec(text);
      if (match) {
        const frames = Number(match[1]) * (match[2] === '秒' ? 30 : 1);
        if (!Number.isSafeInteger(frames)) throw new Error('淡化时长必须落在整数帧');
        e[key] = formatTimecode(frames);
      } else if (!text.includes('淡' + word)) delete e[key];
    }
    if (/循环/.test(text)) e.loop = !/(?:不|关闭|取消)循环/.test(text);
    else delete e.loop;
  }
  if (e.style || e.kind === 'subtitle-style') {
    const style = { ...e.style };
    const fields: Record<string, RegExp> = {
      font: /字体/,
      bold: /粗体|加粗/,
      size: /字号|大小/,
      color: /字色|文字颜色|白色|黑色|红色|蓝色|绿色|#[0-9a-f]{6}/i,
      opacity: /不透明|透明度/,
      align: /对齐|左对齐|右对齐/,
      width: /文本框|宽度/,
      x: /坐标|中心|水平|位置/,
      y: /坐标|中心|垂直|位置/,
      anchor: /锚点/,
      outline: /描边/,
      outlineColor: /描边/,
      background: /背景/,
      backgroundOpacity: /背景/,
    };
    for (const key of Object.keys(style) as (keyof typeof style)[])
      if (!fields[key]?.test(text)) delete style[key];
    if (/粗体|加粗/.test(text)) style.bold = !/(?:取消|关闭|不).*?(?:粗体|加粗)/.test(text);
    if (/白色/.test(text) && !/背景.*白色|描边.*白色/.test(text)) style.color = '#FFFFFF';
    e.style = style;
  }
  return { ...intent, element: e };
}
