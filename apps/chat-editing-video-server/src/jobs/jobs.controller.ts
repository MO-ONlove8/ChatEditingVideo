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

@Controller('jobs')
export class JobsController {
  constructor(
    private readonly jobs: JobsService,
    private readonly bus: JobEventsBus,
  ) {}

  @Post()
  create(@Body(new ZodValidationPipe(CreateEditJobSchema)) body: CreateEditJobInput) {
    return this.jobs.create(body);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.jobs.get(id);
  }

  /** GET + SSE (EventSource-compatible). Emits current state first, then live events. */
  @Sse(':id/events')
  events(@Param('id', ParseUUIDPipe) id: string): Observable<MessageEvent> {
    return new Observable<MessageEvent>((sub) => {
      let closed = false;
      let unsubscribe: (() => void) | undefined;
      const emit = (e: JobEvent) => {
        if (closed) return;
        sub.next({ data: e });
        if (e.type !== 'progress') sub.complete();
      };

      (async () => {
        // Subscribe before reading the snapshot so no event can fall in between.
        unsubscribe = await this.bus.subscribe(id, emit);
        const job = await this.jobs.get(id);
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
      };
    });
  }
}
