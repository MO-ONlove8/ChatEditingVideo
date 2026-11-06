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

@Controller('projects/:projectId/media')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Get()
  list(@Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.media.list(projectId);
  }

  /** multipart/form-data with a single `file` field. */
  @Post()
  @UseInterceptors(FileInterceptor('file'))
  upload(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (!file) throw new BadRequestException('Missing "file" field');
    return this.media.ingest(projectId, file);
  }
}
