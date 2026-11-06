import { Inject, Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import type { ChatMessage } from '@cev/shared';
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

  constructor(@Inject(APP_CONFIG) env: Env) {
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
}
