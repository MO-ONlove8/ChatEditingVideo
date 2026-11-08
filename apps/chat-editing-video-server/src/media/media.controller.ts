import {
  BadRequestException,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { MediaService } from './media.service.js';
import { CurrentSession } from '../auth/auth.guard.js';
import type { AuthSession } from '../auth/auth.service.js';

@Controller('projects/:projectId/media')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Get()
  list(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @CurrentSession() session: AuthSession,
  ) {
    return this.media.list(projectId, session.user.id);
  }

  /** multipart/form-data with a single `file` field. */
  @Post()
  @UseInterceptors(FileInterceptor('file'))
  upload(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentSession() session: AuthSession,
  ) {
    if (!file) throw new BadRequestException('Missing "file" field');
    return this.media.ingest(projectId, file, session.user.id);
  }
}
