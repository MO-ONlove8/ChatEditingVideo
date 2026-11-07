import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { encodeSse, LoginSchema, RequestCodeSchema, type LoginInput } from '@cev/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { CurrentSession, Public } from './auth.guard.js';
import { AuthService, sessionMessages, type AuthSession } from './auth.service.js';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('code')
  @HttpCode(200)
  code(@Body(new ZodValidationPipe(RequestCodeSchema)) body: { phone: string }) {
    return this.auth.requestCode(body.phone);
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body(new ZodValidationPipe(LoginSchema)) body: LoginInput) {
    return this.auth.login(body.phone, body.code);
  }

  @Get('me')
  me(@CurrentSession() session: AuthSession) {
    return { user: session.user, expiresAt: session.expiresAt };
  }

  @Post('logout')
  @HttpCode(204)
  logout(@CurrentSession() session: AuthSession) {
    return this.auth.logout(session);
  }

  @Get('events')
  events(@CurrentSession() session: AuthSession, @Req() _req: Request, @Res() res: Response) {
    res.status(200).set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write(encodeSse({ type: 'ready' }));
    const off = this.auth.watch(session, (code) => {
      res.write(encodeSse({ type: 'session-ended', code, message: sessionMessages[code] }));
      res.end();
    });
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15_000);
    res.on('close', () => {
      off();
      clearInterval(heartbeat);
    });
  }
}
