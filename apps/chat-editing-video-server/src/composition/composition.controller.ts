import {
  Controller,
  Get,
  Post,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
  Res,
  BadRequestException,
  NotFoundException,
  ParseIntPipe,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { stat } from 'node:fs/promises';
import { CurrentSession } from '../auth/auth.guard.js';
import { AuthService, type AuthSession } from '../auth/auth.service.js';
import { CompositionService } from './composition.service.js';
import { StorageService } from '../storage/storage.service.js';
@Controller('projects/:id')
export class CompositionController {
  constructor(
    private readonly composition: CompositionService,
    private readonly storage: StorageService,
    private readonly auth: AuthService,
  ) {}
  @Get('operations/:requestId') operation(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @CurrentSession() session: AuthSession,
  ) {
    return this.composition.operation(id, session.user.id, requestId);
  }
  @Post('composition/:revision/retry') retry(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('revision', ParseIntPipe) revision: number,
    @CurrentSession() session: AuthSession,
  ) {
    return this.composition.retry(id, session.user.id, revision);
  }
  @Get('composition/:revision') async state(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('revision', ParseIntPipe) revision: number,
    @CurrentSession() session: AuthSession,
  ) {
    await this.composition.assertProject(id, session.user.id);
    const state = await this.composition.state(id, revision);
    if (!state) throw new NotFoundException('该版本尚无正式合成预览');
    return state;
  }
  @Get('composition-resource') async resource(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('key') key: string,
    @CurrentSession() session: AuthSession,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    await this.composition.assertProject(id, session.user.id);
    if (
      !key?.startsWith(`projects/${id}/composition/`) ||
      !/^projects\/[\da-f-]+\/composition\/[\da-f]{64}\/(?:(?:S|T|I)\d+\.png|mix\/audio\.m4a)$/.test(
        key,
      )
    )
      throw new BadRequestException('无效的合成资源');
    const info = await stat(this.storage.resolve(key)).catch(() => {
      throw new NotFoundException('合成资源不存在，请重试预览');
    });
    let start = 0,
      end = info.size - 1;
    if (req.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (!match || (!match[1] && !match[2])) {
        res
          .status(416)
          .set('Content-Range', 'bytes */' + info.size)
          .end();
        return;
      }
      if (!match[1]) start = Math.max(0, info.size - Number(match[2]));
      else {
        start = Number(match[1]);
        if (match[2]) end = Math.min(end, Number(match[2]));
      }
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start > end ||
        start >= info.size
      ) {
        res
          .status(416)
          .set('Content-Range', 'bytes */' + info.size)
          .end();
        return;
      }
      res.status(206).set('Content-Range', 'bytes ' + start + '-' + end + '/' + info.size);
    }
    res.set({
      'Content-Type': key.endsWith('.png') ? 'image/png' : 'audio/mp4',
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, no-store',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const { createReadStream } = await import('node:fs');
    const stream = createReadStream(this.storage.resolve(key), { start, end });
    const timer = setInterval(
      () =>
        void this.composition.assertProject(id, session.user.id).catch(() => {
          stream.destroy();
          res.destroy();
        }),
      1000,
    );
    const off = this.auth.watch(session, () => {
      stream.destroy();
      res.destroy();
    });
    res.on('close', () => {
      off();
      clearInterval(timer);
      stream.destroy();
    });
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }
}
