import { Inject, Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import { ElementEditSchema, IntentSchema, type ChatMessage, type EditingIntent } from '@cev/shared';
import { z } from 'zod';
import { APP_CONFIG } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { explicitParameters } from './explicit-parameters.js';

const SYSTEM_PROMPT =
  '你是一个视频剪辑助手。根据用户的描述理解剪辑意图，给出清晰、可执行的剪辑建议。回答使用中文。';

const ElementWire = ElementEditSchema.omit({
  requestId: true,
  expectedRevision: true,
  playhead: true,
  range: true,
  startFrame: true,
  endFrame: true,
  sourceStart: true,
  sourceEnd: true,
}).extend({
  id: z
    .union([z.uuid(), z.literal('subtitles')])
    .optional()
    .describe('只用于修改已存在的S/T/I/A或Clip，添加时不得填写；来源文件必须放assetId'),
  assetId: z.uuid().optional().describe('来源IMG/AUD/SRT文件的真实id，绝不是元素id'),
  title: z.boolean().optional(),
  settings: z
    .object({
      volume: z
        .number()
        .int()
        .min(0)
        .max(200)
        .optional()
        .describe('线性百分比：20%写20，100%写100'),
      muted: z.boolean().optional(),
    })
    .optional(),
  fadeInTime: z.string().optional().describe('淡入时长，分:秒:帧；1秒必须00:01:00'),
  fadeOutTime: z.string().optional().describe('淡出时长，分:秒:帧；1秒必须00:01:00'),
});
const times = { startTime: true, endTime: true, whole: true } as const;
const ElementWireSchema = z.discriminatedUnion('kind', [
  ElementWire.pick({ id: true, text: true, startTime: true, endTime: true }).extend({
    kind: z.literal('subtitle'),
  }),
  ElementWire.pick({ style: true, placement: true }).extend({ kind: z.literal('subtitle-style') }),
  ElementWire.pick({ assetId: true }).extend({ kind: z.literal('subtitle-replace') }),
  ElementWire.pick({
    id: true,
    text: true,
    style: true,
    placement: true,
    title: true,
    ...times,
  }).extend({ kind: z.literal('text') }),
  ElementWire.pick({
    id: true,
    assetId: true,
    x: true,
    y: true,
    width: true,
    opacity: true,
    placement: true,
    ...times,
  }).extend({ kind: z.literal('image') }),
  ElementWire.pick({
    id: true,
    assetId: true,
    role: true,
    sourceStartTime: true,
    sourceEndTime: true,
    settings: true,
    fadeInTime: true,
    fadeOutTime: true,
    loop: true,
    ...times,
  }).extend({ kind: z.literal('audio') }),
  ElementWire.pick({ id: true, settings: true, fadeInTime: true, fadeOutTime: true }).extend({
    kind: z.literal('clip-audio'),
  }),
  ElementWire.pick({ id: true }).extend({ kind: z.literal('delete-element') }),
  ElementWire.pick({ id: true, position: true }).extend({ kind: z.literal('layer') }),
  ElementWire.pick({ id: true, startTime: true }).extend({ kind: z.literal('copy-overlay') }),
]);
// Each branch exposes only fields relevant to that operation; no numeric frame
// conversion or candidate defaults are delegated to the language model.
const ClassificationSchema = z.object({
  kind: IntentSchema.shape.kind,
  elementKind: ElementEditSchema.shape.kind.nullable(),
  message: z.string(),
});
function completeSchema(schema: z.ZodType): z.ZodType {
  if (schema instanceof z.ZodOptional)
    return completeSchema(schema.unwrap() as z.ZodType).nullable();
  if (schema instanceof z.ZodDefault) return completeSchema(schema.removeDefault() as z.ZodType);
  if (schema instanceof z.ZodObject)
    return z.object(
      Object.fromEntries(
        Object.entries(schema.shape).map(([key, value]) => [
          key,
          completeSchema(value as z.ZodType),
        ]),
      ),
    );
  return schema;
}
function omitNulls(value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value))
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== null)
        .map(([k, v]) => [k, omitNulls(v)]),
    );
  return value;
}

/**
 * Thin wrapper over an OpenAI-compatible endpoint. Defaults to local Ollama
 * (http://localhost:11434/v1, qwen3:8b). Pointing LLM_BASE_URL elsewhere
 * (vLLM, LM Studio, a hosted API) needs no code change.
 */
@Injectable()
export class LlmService {
  private readonly client: OpenAI;
  readonly model: string;

  constructor(@Inject(APP_CONFIG) private readonly env: Env) {
    this.client = new OpenAI({ baseURL: env.LLM_BASE_URL, apiKey: env.LLM_API_KEY, maxRetries: 0 });
    this.model = env.LLM_MODEL;
  }

  /** Yields assistant text deltas. Abort via `signal` (e.g. client disconnected). */
  async *streamChat(messages: ChatMessage[], signal?: AbortSignal): AsyncGenerator<string> {
    const stream = await this.client.chat.completions.create(
      {
        model: this.model,
        stream: true,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
      },
      { signal },
    );
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) yield delta;
    }
  }

  async ping(): Promise<void> {
    await this.client.models.list({ timeout: 1500 });
  }

  async understand(
    context: unknown,
    history: ChatMessage[],
    text: string,
    signal?: AbortSignal,
  ): Promise<EditingIntent> {
    const prompt = `你是视频剪辑指令解析器，只返回JSON。每条消息只允许一个操作。kind只能是add（截取素材添加），move（移动已有Clip），copy（复制已有Clip），element（字幕图文声音），clarify（需补充信息），unsupported（不支持），multiple（多个独立操作）。
sourceNumber是V编号（add）或Clip编号（move/copy）；destination是end/before/after，targetNumber仅before/after填写目标Clip编号，end时为null。
startTime/endTime使用分:秒:帧（或时:分:秒:帧）字符串，省略帧补00；只提取用户明确指定的时间，不能自行改变范围。5秒到8秒必须是00:05:00到00:08:00，含首尾帧共91帧。单帧可起止相同。move/copy不填写时间。
当前编号映射优先于历史消息；不能把历史编号当当前编号。缺少必要信息、不能确定指代时返回clarify及中文说明，其他无关字段为null。多个独立操作返回multiple，不能只提取第一条。不支持内容语义识别、动画、ASR、录音、TTS。
字幕、标题、图像、声音及原声编辑用kind=element，element.kind可用subtitle/subtitle-style/subtitle-replace/text/image/audio/clip-audio/delete-element/layer/copy-overlay。单对象修改多个字段是一个操作；统一字幕样式、删除整轨各为一个集合操作。不同对象独立动作必须multiple。
element.id只能使用当前上下文真实id。S/T/I/A是稳定编号，第三条字幕指当前时间排序第3条；这个标题优先selectedId，不明确则clarify。图像assetId用IMG映射，声音用AUD，原声用Clip真实id，不能编造id。删除全轨用id=subtitles。
时间仅提取明确给出的startTime/endTime（分:秒:帧字符串），源声音用sourceStartTime/sourceEndTime；不要自行把时间换算帧数。缺省字段不填，服务端决定默认值。明确全片用whole=true；从某时到结尾仍固定到当前末帧。不要把未说出的全片或循环加进去。
文字content用element.text；style包含size（短边百分比1～20）、x/y中心百分比0～100、width文本框10～100、color六位RGB、bold、align、opacity、outline、backgroundOpacity、anchor(center/top/bottom)。九宫格位置使用element.placement=top-left/top-center/top-right/center-left/center/center-right/bottom-left/bottom-center/bottom-right，由服务端按尺寸定位；不要估算坐标。
图像用x/y、width画布百分比、opacity；audio.role=narration/bgm，settings.volume为0～200整数百分比，muted独立开关，fadeIn/fadeOut为明确指定淡化帧数，用户给出秒时用element.fadeInTime/fadeOutTime时码交由服务端换算，loop仅明确循环时true。BGM及旁白不支持复制。置顶/置底用layer.position=front/back。element字段未改变的不填。
输出示例（id必须替换为上下文的真实id，未提及的字段一律省略）：
添加字幕“你好”从0秒到1秒：{"kind":"element","element":{"kind":"subtitle","text":"你好","startTime":"00:00:00","endTime":"00:01:00"},"message":"请预览字幕"}
修改选中标题文字为“旅行”、顶部居中：{"kind":"element","element":{"kind":"text","id":"选中标题id","text":"旅行","placement":"top-center"},"message":"保留原时间和其他样式"}
添加AUD1为全片BGM、音量20%、循环、淡入1秒：{"kind":"element","element":{"kind":"audio","assetId":"AUD1文件id","role":"bgm","whole":true,"settings":{"volume":20},"loop":true,"fadeInTime":"00:01:00"},"message":"请预览完整混音"}
所有字幕白色粗体：{"kind":"element","element":{"kind":"subtitle-style","style":{"color":"#FFFFFF","bold":true}},"message":"仅改变字色和粗体"}
message仅用于解释或澄清，不能声称操作已执行。当前任务上下文：${JSON.stringify(context)}`;
    const messages = [
      { role: 'system' as const, content: prompt },
      ...history,
      { role: 'user' as const, content: text },
    ];
    const timeout = AbortSignal.timeout(this.env.LLM_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const classification = ClassificationSchema.parse(
      await this.structured(messages, z.toJSONSchema(ClassificationSchema), combined),
    );
    if (['clarify', 'unsupported', 'multiple'].includes(classification.kind))
      return IntentSchema.parse({
        ...classification,
        sourceNumber: null,
        startTime: null,
        endTime: null,
        destination: null,
        targetNumber: null,
      });
    if (classification.kind === 'element') {
      const operation = ElementWireSchema.options.find(
        (s) => s.shape.kind.value === classification.elementKind,
      );
      if (!operation) throw new Error('模型未明确操作类型');
      const extraction = z.object({ element: operation, message: z.string() });
      const parsed = z
        .object({ element: z.record(z.string(), z.unknown()), message: z.string() })
        .parse(
          omitNulls(
            await this.structured(
              [
                ...messages,
                {
                  role: 'system',
                  content: `本条已分类为${classification.elementKind}。只提取这一个操作的参数，包含用户指定的全部字段。每个未指定字段输出null，不补默认值。settings/style没有修改时为null。输出element与message。`,
                },
              ],
              z.toJSONSchema(completeSchema(extraction)),
              combined,
            ),
          ),
        );
      return IntentSchema.parse(
        explicitParameters(
          {
            kind: 'element',
            sourceNumber: null,
            startTime: null,
            endTime: null,
            destination: null,
            targetNumber: null,
            ...parsed,
          } as EditingIntent,
          text,
          context,
        ),
      );
    }
    const legacy = IntentSchema.omit({ element: true });
    return legacy.parse(await this.structured(messages, z.toJSONSchema(legacy), combined));
  }
  private async structured(
    messages: ChatMessage[],
    schema: Record<string, unknown>,
    combined: AbortSignal,
  ): Promise<unknown> {
    let content: string;
    if (this.env.LLM_OLLAMA_CPU) {
      const base = new URL(this.env.LLM_BASE_URL);
      if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))
        throw new Error('CPU模式仅用于本地Ollama');
      const response = await fetch(new URL('/api/chat', base), {
        method: 'POST',
        signal: combined,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages,
          format: schema,
          stream: false,
          think: false,
          options: { num_gpu: 0, temperature: 0, num_predict: 800 },
        }),
      });
      if (!response.ok) throw new Error('本地模型推理失败');
      const result = (await response.json()) as { message?: { content: string }; error?: string };
      if (!result.message) throw new Error(result.error ?? '模型未返回内容');
      content = result.message.content;
    } else {
      const result = await this.client.chat.completions.create(
        {
          model: this.model,
          temperature: 0,
          max_tokens: 800,
          reasoning_effort: 'none',
          messages,
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'editing_intent', strict: true, schema },
          },
        },
        { signal: combined },
      );
      content = result.choices[0]?.message.content ?? '';
    }
    return JSON.parse(content);
  }
}
