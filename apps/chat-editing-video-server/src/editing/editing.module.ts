import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module.js';
import { EditingController } from './editing.controller.js';
import { EditingService } from './editing.service.js';
@Module({
  imports: [ProjectsModule],
  controllers: [EditingController],
  providers: [EditingService],
  exports: [EditingService],
})
export class EditingModule {}
