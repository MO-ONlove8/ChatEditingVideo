import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  Res,
  NotFoundException,
} from '@nestjs/common';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { Request, Response } from 'express';
import { CreateUploadsSchema, encodeSse, type CreateUploadsInput } from '@cev/shared';
import { CurrentSession } from '../auth/auth.guard.js';
import { AuthService, type AuthSession } from '../auth/auth.service.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { MediaService } from './media.service.js';
import { MediaImages } from './media-images.service.js';
import { StorageService } from '../storage/storage.service.js';

@Controller()
export class MediaFilesController {
  constructor(
    private readonly media: MediaService,
    private readonly images: MediaImages,
    private readonly storage: StorageService,
    private readonly auth: AuthService,
  ) {}
  @Get('media/policy') policy() {
    return this.media.policy();
  }
  @Post('uploads') create(
    @Body(new ZodValidationPipe(CreateUploadsSchema)) input: CreateUploadsInput,
    @CurrentSession() session: AuthSession,
  ) {
    return this.media.createUploads(input, session.user.id);
  }
  @Get('uploads/:id') upload(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentSession() session: AuthSession,
  ) {
    return this.media.uploadResult(id, session.user.id);
  }
  @Delete('uploads/:id') cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentSession() session: AuthSession,
  ) {
    return this.media.cancel(id, session.user.id);
  }
  @Put('uploads/:id/content') receive(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
    @CurrentSession() session: AuthSession,
  ) {
    if (!req.is('application/octet-stream'))
      throw new BadRequestException('请使用二进制视频内容上传');
    return this.media.receive(id, req, session.user.id);
  }
  @Post('media/:id/retry') retry(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentSession() session: AuthSession,
  ) {
    return this.media.retry(id, session.user.id);
  }
  @Delete('media/:id') @HttpCode(204) remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentSession() session: AuthSession,
  ) {
    return this.media.remove(id, session.user.id);
  }
  @Get('media/:id/thumbnails') thumbnails(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('page', ParseIntPipe) page: number,
    @CurrentSession() session: AuthSession,
  ) {
    return this.images.thumbnails(id, session.user.id, page);
  }
  @Get('media/:id/frames') frames(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('second', ParseIntPipe) second: number,
    @CurrentSession() session: AuthSession,
  ) {
    return this.images.frames(id, session.user.id, second);
  }
  @Get('media/:id/frames/:frame/image') async frame(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('frame', ParseIntPipe) frame: number,
    @CurrentSession() session: AuthSession,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    await this.send(
      await this.images.fullFrame(id, session.user.id, frame),
      'image/jpeg',
      req,
      res,
      session,
    );
  }
  @Get('media/:id/images/:name') async image(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('name') name: string,
    @Query('generation', ParseIntPipe) generation: number,
    @CurrentSession() session: AuthSession,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    await this.send(
      await this.images.image(id, session.user.id, name, generation),
      'image/jpeg',
      req,
      res,
      session,
    );
  }
  @Get('media/:id/content') async content(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentSession() session: AuthSession,
    @Req() req: Request,
    @Res() res: Response,
    @Query('generation') generation?: string,
  ) {
    const asset = await this.media.get(id, session.user.id);
    if (
      generation !== undefined &&
      (!/^\d+$/.test(generation) || Number(generation) !== asset.generation)
    )
      throw new BadRequestException('素材处理版本已变化，请刷新后重试');
    if (asset.status !== 'ready' || !asset.normalizedKey)
      throw new BadRequestException('素材尚未处理完成');
    await this.send(asset.normalizedKey, 'video/mp4', req, res, session);
  }
  @Get('projects/:id/media/events') async events(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentSession() session: AuthSession,
    @Res() res: Response,
  ) {
    await this.media.assertProject(id, session.user.id);
    res.status(200).set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.flushHeaders();
    let closed = false;
    let checking = false;
    let previous = '';
    const off = this.auth.watch(session, () => res.end());
    const send = async () => {
      if (closed || checking) return;
      checking = true;
      try {
        const assets = await this.media.list(id, session.user.id);
        const value = JSON.stringify(assets);
        if (!closed && previous !== value) {
          res.write(encodeSse({ type: 'media', assets }));
          previous = value;
        }
      } catch {
        if (!closed) res.end();
      } finally {
        checking = false;
      }
    };
    const timer = setInterval(() => void send(), 1000);
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15_000);
    res.on('close', () => {
      closed = true;
      clearInterval(timer);
      clearInterval(heartbeat);
      off();
    });
    await send();
  }
  private async send(key: string, type: string, req: Request, res: Response, session: AuthSession) {
    const file = this.storage.resolve(key);
    const data = await stat(file).catch(() => {
      throw new NotFoundException('媒体文件不存在或缓存已过期，请重新加载');
    });
    let start = 0;
    let end = data.size - 1;
    if (req.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (!match || (!match[1] && !match[2])) {
        res.status(416).set('Content-Range', `bytes */${data.size}`).end();
        return;
      }
      if (!match[1]) start = Math.max(0, data.size - Number(match[2]));
      else {
        start = Number(match[1]);
        if (match[2]) end = Math.min(end, Number(match[2]));
      }
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start > end ||
        start >= data.size
      ) {
        res.status(416).set('Content-Range', `bytes */${data.size}`).end();
        return;
      }
      res.status(206).set('Content-Range', `bytes ${start}-${end}/${data.size}`);
    }
    res.set({
      'Content-Type': type,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    void this.images.touch(key);
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
}
