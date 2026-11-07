import {
  Body,
  Controller,
  Get,
  type MessageEvent,
  Param,
  ParseUUIDPipe,
  Post,
  Sse,
  Res,
  Req,
  Inject,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import {
  CreateEditJobSchema,
  EditingErrorCodes,
  type CreateEditJobInput,
  type JobEvent,
} from '@cev/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { JobEventsBus } from './job-events.bus.js';
import { JobsService } from './jobs.service.js';
import { CurrentSession, Public } from '../auth/auth.guard.js';
import { AuthService, type AuthSession } from '../auth/auth.service.js';
import type { Request, Response } from 'express';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { StorageService } from '../storage/storage.service.js';
import { APP_CONFIG } from '../config/config.module.js';
import type { Env } from '../config/env.js';

@Controller('jobs')
export class JobsController {
  constructor(
    private readonly jobs: JobsService,
    private readonly bus: JobEventsBus,
    private readonly auth: AuthService,
    private readonly storage: StorageService,
    @Inject(APP_CONFIG) private readonly env: Env,
  ) {}

  @Post()
  create(
    @Body(new ZodValidationPipe(CreateEditJobSchema)) body: CreateEditJobInput,
    @CurrentSession() session: AuthSession,
  ) {
    return this.jobs.create(body, session.user.id);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentSession() session: AuthSession) {
    return this.jobs.get(id, session.user.id);
  }
  @Post(':id/retry') retry(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentSession() session: AuthSession,
  ) {
    return this.jobs.retry(id, session.user.id);
  }
  @Post(':id/download-ticket') async ticket(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentSession() session: AuthSession,
    @Res({ passthrough: true }) res: Response,
  ) {
    const token = await this.jobs.ticket(id, session);
    res.cookie('cev_download', token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: this.env.NODE_ENV === 'production',
      path: `/api/jobs/${id}/download`,
      maxAge: 300000,
    });
    return { expiresIn: 300 };
  }
  @Public() @Get(':id/download') async download(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const cookie =
      (req.headers.cookie ?? '')
        .split(';')
        .map((s) => s.trim())
        .find((s) => s.startsWith('cev_download='))
        ?.slice('cev_download='.length) ?? '';
    const session = await this.jobs.ticketSession(id, cookie);
    return this.send(id, session, req, res, true);
  }
  @Get(':id/content') content(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentSession() session: AuthSession,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.send(id, session, req, res, false);
  }
  private async send(
    id: string,
    session: AuthSession,
    req: Request,
    res: Response,
    download: boolean,
  ) {
    const job = await this.jobs.get(id, session.user.id);
    if (job.status !== 'succeeded' || job.plan.version === 1 || !job.outputKey)
      throw new ConflictException({
        code: EditingErrorCodes.renderNotReady,
        message: '成品尚未生成完成',
      });
    const file = this.storage.resolve(job.outputKey);
    const info = await stat(file).catch(() => {
      throw new NotFoundException('成品文件不存在，请重新生成');
    });
    let start = 0,
      end = info.size - 1;
    if (req.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (!match || (!match[1] && !match[2])) {
        res.status(416).set('Content-Range', `bytes */${info.size}`).end();
        return;
      }
      if (!match[1]) start = Math.max(0, info.size - Number(match[2]));
      else {
        start = Number(match[1]);
        if (match[2]) end = Math.min(end, Number(match[2]));
      }
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start > end ||
        start >= info.size
      ) {
        res.status(416).set('Content-Range', `bytes */${info.size}`).end();
        return;
      }
      res.status(206).set('Content-Range', `bytes ${start}-${end}/${info.size}`);
    }
    res.set({
      'Content-Type': 'video/mp4',
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    if (download) res.attachment(`video-v${job.revision}.mp4`);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = createReadStream(file, { start, end });
    const off = this.auth.watch(session, () => {
      stream.destroy();
      res.destroy();
    });
    res.on('close', () => {
      off();
      stream.destroy();
    });
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }

  /** GET + SSE (EventSource-compatible). Emits current state first, then live events. */
  @Sse(':id/events')
  async events(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentSession() session: AuthSession,
  ): Promise<Observable<MessageEvent>> {
    await this.jobs.get(id, session.user.id); // Authorize before creating any subscription.
    return new Observable<MessageEvent>((sub) => {
      let closed = false;
      let unsubscribe: (() => void) | undefined;
      const offSession = this.auth.watch(session, () => sub.complete());
      const emit = (e: JobEvent) => {
        if (closed) return;
        void this.auth
          .authenticate(session.token)
          .then(() => {
            if (closed) return;
            sub.next({ data: e });
            if (e.type !== 'progress') sub.complete();
          })
          .catch(() => sub.complete());
      };

      (async () => {
        // Subscribe before reading the snapshot so no event can fall in between.
        unsubscribe = await this.bus.subscribe(id, emit);
        const job = await this.jobs.get(id, session.user.id);
        if (closed) {
          unsubscribe?.();
          return;
        }
        if (job.status === 'succeeded')
          emit({ type: 'completed', jobId: id, outputKey: job.outputKey ?? '' });
        else if (job.status === 'failed')
          emit({ type: 'failed', jobId: id, error: job.error ?? 'unknown' });
        else emit({ type: 'progress', jobId: id, progress: job.progress });
      })().catch((err: unknown) => {
        if (!closed) sub.error(err);
      });

      return () => {
        closed = true;
        unsubscribe?.();
        offSession();
      };
    });
  }
}
