import { Body, Controller, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Logger } from 'nestjs-pino';
import { ChatRequestSchema, encodeSse, type ChatRequest, type ChatStreamEvent } from '@cev/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { LlmService } from './llm.service.js';

@Controller('chat')
export class ChatController {
  constructor(
    private readonly llm: LlmService,
    private readonly logger: Logger,
  ) {}

  /**
   * POST + SSE response. (EventSource only supports GET, so clients read this with
   * fetch + a ReadableStream and `createSseParser` from @cev/shared.)
   */
  @Post('stream')
  async stream(
    @Body(new ZodValidationPipe(ChatRequestSchema)) body: ChatRequest,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    const abort = new AbortController();
    req.on('close', () => abort.abort());
    const send = (e: ChatStreamEvent) => res.write(encodeSse(e));

    try {
      for await (const delta of this.llm.streamChat(body.messages, abort.signal)) {
        send({ type: 'delta', content: delta });
      }
      send({ type: 'done' });
    } catch (err) {
      if (!abort.signal.aborted) {
        this.logger.error({ err }, 'LLM stream failed');
        send({ type: 'error', message: 'LLM 服务不可用，请确认 Ollama 已启动' });
      }
    } finally {
      res.end();
    }
  }
}
