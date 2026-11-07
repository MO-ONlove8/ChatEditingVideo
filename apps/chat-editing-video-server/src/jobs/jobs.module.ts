import { type DynamicModule, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import type { Env } from '../config/env.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { EditJobProcessor } from './edit-job.processor.js';
import { FfmpegServerExecutor } from './executors/ffmpeg-server.executor.js';
import { JobEventsBus } from './job-events.bus.js';
import { EDIT_QUEUE } from './jobs.constants.js';
import { JobsController } from './jobs.controller.js';
import { JobsService } from './jobs.service.js';
import { EditingModule } from '../editing/editing.module.js';

@Module({})
export class JobsModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: JobsModule,
      imports: [ProjectsModule, EditingModule, BullModule.registerQueue({ name: EDIT_QUEUE })],
      controllers: [JobsController],
      providers: [
        JobsService,
        JobEventsBus,
        FfmpegServerExecutor,
        // The worker can be split into its own process later by flipping this flag.
        ...(env.JOBS_WORKER_ENABLED ? [EditJobProcessor] : []),
      ],
    };
  }
}
