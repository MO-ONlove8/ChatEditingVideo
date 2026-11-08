import { Module } from '@nestjs/common';
import { ProjectsController } from './projects.controller.js';
import { ProjectsService } from './projects.service.js';
import { BullModule } from '@nestjs/bullmq';
import { EDIT_QUEUE } from '../jobs/jobs.constants.js';
import { MediaCoreModule } from '../media/media-core.module.js';

@Module({
  imports: [BullModule.registerQueue({ name: EDIT_QUEUE }), MediaCoreModule],
  controllers: [ProjectsController],
  providers: [ProjectsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
