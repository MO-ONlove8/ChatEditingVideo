import { Global, Module, type DynamicModule } from '@nestjs/common';
import type { Env } from '../config/env.js';
import { BullModule, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { LayoutService } from './layout.service.js';
import { CompositionEngine } from './composition-engine.service.js';
import {
  CompositionService,
  COMPOSITION_QUEUE,
  type CompositionWork,
} from './composition.service.js';
import { CompositionController } from './composition.controller.js';
@Processor(COMPOSITION_QUEUE, { concurrency: 1 })
class CompositionProcessor extends WorkerHost {
  constructor(private readonly composition: CompositionService) {
    super();
  }
  async process(job: Job<CompositionWork>) {
    await this.composition.process(job.data, new AbortController().signal);
  }
}
@Global()
@Module({})
export class CompositionModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: CompositionModule,
      global: true,
      imports: [BullModule.registerQueue({ name: COMPOSITION_QUEUE })],
      providers: [
        LayoutService,
        CompositionEngine,
        CompositionService,
        ...(env.JOBS_WORKER_ENABLED ? [CompositionProcessor] : []),
      ],
      controllers: [CompositionController],
      exports: [LayoutService, CompositionEngine, CompositionService],
    };
  }
}
