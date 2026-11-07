import { Inject, Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import { IntentSchema, type ChatMessage, type EditingIntent } from '@cev/shared';
import { z } from 'zod';
import { APP_CONFIG } from '../config/config.module.js';
import type { Env } from '../config/env.js';

const SYSTEM_PROMPT =
  '你是一个视频剪辑助手。根据用户的描述理解剪辑意图，给出清晰、可执行的剪辑建议。回答使用中文。';

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
    const prompt = `你是视频剪辑指令解析器，只返回JSON。每条消息只允许一个操作。kind只能是add（截取素材添加），move（移动已有Clip），copy（复制已有Clip），clarify（需补充信息），unsupported（不支持），multiple（多个独立操作）。
sourceNumber是V编号（add）或Clip编号（move/copy）；destination是end/before/after，targetNumber仅before/after填写目标Clip编号，end时为null。
startTime/endTime使用分:秒:帧（或时:分:秒:帧）字符串，省略帧补00；只提取用户明确指定的时间，不能自行改变范围。5秒到8秒必须是00:05:00到00:08:00，含首尾帧共91帧。单帧可起止相同。move/copy不填写时间。
当前编号映射优先于历史消息；不能把历史编号当当前编号。缺少必要信息、不能确定指代时返回clarify及中文说明，其他无关字段为null。多个独立操作返回multiple，不能只提取第一条。不能执行删除、修改范围、字幕或内容语义识别等不支持的操作。
message仅用于解释或澄清，不能声称操作已执行。当前任务上下文：${JSON.stringify(context)}`;
    const messages = [
      { role: 'system' as const, content: prompt },
      ...history,
      { role: 'user' as const, content: text },
    ];
    const schema = z.toJSONSchema(IntentSchema);
    const timeout = AbortSignal.timeout(this.env.LLM_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
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
    return IntentSchema.parse(JSON.parse(content));
  }
}
