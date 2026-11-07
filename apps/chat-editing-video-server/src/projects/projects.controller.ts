import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import {
  CreateProjectSchema,
  UpdateProjectSchema,
  type CreateProjectInput,
  type UpdateProjectInput,
} from '@cev/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ProjectsService } from './projects.service.js';
import { CurrentSession } from '../auth/auth.guard.js';
import type { AuthSession } from '../auth/auth.service.js';

@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  list(@CurrentSession() session: AuthSession) {
    return this.projects.list(session.user.id);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentSession() session: AuthSession) {
    return this.projects.get(id, session.user.id);
  }

  @Post()
  create(
    @Body(new ZodValidationPipe(CreateProjectSchema)) body: CreateProjectInput,
    @CurrentSession() session: AuthSession,
  ) {
    return this.projects.create(body, session.user.id);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(UpdateProjectSchema)) body: UpdateProjectInput,
    @CurrentSession() session: AuthSession,
  ) {
    return this.projects.update(id, body, session.user.id);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentSession() session: AuthSession) {
    await this.projects.remove(id, session.user.id);
  }
}
