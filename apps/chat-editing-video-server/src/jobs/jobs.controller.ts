import {
  Body,
  Controller,
  Get,
  type MessageEvent,
  Param,
  ParseUUIDPipe,
  Post,
  Sse,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { CreateEditJobSchema, type CreateEditJobInput, type JobEvent } from '@cev/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { JobEventsBus } from './job-events.bus.js';
import { JobsService } from './jobs.service.js';
import { CurrentSession } from '../auth/auth.guard.js';
import { AuthService, type AuthSession } from '../auth/auth.service.js';

@Controller('jobs')
export class JobsController {
  constructor(
    private readonly jobs: JobsService,
    private readonly bus: JobEventsBus,
    private readonly auth: AuthService,
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
