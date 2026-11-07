import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  EditingErrorCodeSchema,
  EditingRequestSchema,
  InstructionSchema,
  encodeSse,
} from '@cev/shared';
import { z } from 'zod';
import { AuthService, type AuthSession } from '../auth/auth.service.js';
import { CurrentSession } from '../auth/auth.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { EditingService } from './editing.service.js';

@Controller('projects/:id')
export class EditingController {
  constructor(
    private readonly editing: EditingService,
    private readonly auth: AuthService,
  ) {}
  @Get('editor-state') state(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentSession() session: AuthSession,
  ) {
    return this.editing.state(id, session.user.id);
  }
  @Get('chat') history(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentSession() session: AuthSession,
    @Query('before') before?: string,
  ) {
    return this.editing.history(id, session.user.id, before);
  }
  @Post('chat/stream') async chat(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentSession() session: AuthSession,
    @Body(new ZodValidationPipe(InstructionSchema)) input: z.infer<typeof InstructionSchema>,
    @Res() res: Response,
  ) {
    await this.editing.state(id, session.user.id);
    res
      .set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      })
      .flushHeaders();
    const abort = new AbortController();
    const off = this.auth.watch(session, () => {
      abort.abort();
      res.end();
    });
    const heartbeat = setInterval(() => {
      if (!res.destroyed) res.write(': heartbeat\n\n');
    }, 10000);
    res.on('close', () => {
      abort.abort();
      clearInterval(heartbeat);
      off();
    });
    res.write(encodeSse({ type: 'understanding' }));
    try {
      const state = await this.editing.instruct(id, session.user.id, input, abort.signal);
      if (!res.destroyed) res.write(encodeSse({ type: 'state', state }));
    } catch (error) {
      const body = error instanceof HttpException ? error.getResponse() : undefined;
      const code = EditingErrorCodeSchema.safeParse(
        body && typeof body === 'object' && 'code' in body ? body.code : undefined,
      );
      if (!res.destroyed)
        res.write(
          encodeSse({
            type: 'error',
            message: error instanceof Error ? error.message : '操作失败，请重试',
            ...(code.success ? { code: code.data } : {}),
          }),
        );
    } finally {
      clearInterval(heartbeat);
      off();
      res.end();
    }
  }
  @Post('proposals/:proposalId/confirm') confirm(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('proposalId', ParseUUIDPipe) proposalId: string,
    @CurrentSession() session: AuthSession,
  ) {
    return this.editing.decide(id, session.user.id, proposalId, true);
  }
  @Post('proposals/:proposalId/cancel') cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('proposalId', ParseUUIDPipe) proposalId: string,
    @CurrentSession() session: AuthSession,
  ) {
    return this.editing.decide(id, session.user.id, proposalId, false);
  }
  @Delete('clips/:clipId') remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('clipId', ParseUUIDPipe) clipId: string,
    @CurrentSession() session: AuthSession,
    @Body(new ZodValidationPipe(EditingRequestSchema)) input: z.infer<typeof EditingRequestSchema>,
  ) {
    return this.editing.removeClip(id, session.user.id, clipId, input);
  }
}
