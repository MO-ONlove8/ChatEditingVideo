import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AuthService, type AuthSession } from './auth.service.js';

export const Public = () => SetMetadata('public', true);
export const CurrentSession = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthSession =>
    context.switchToHttp().getRequest<Request & { auth: AuthSession }>().auth,
);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}
  async canActivate(context: ExecutionContext) {
    if (this.reflector.getAllAndOverride('public', [context.getHandler(), context.getClass()]))
      return true;
    const req = context.switchToHttp().getRequest<Request & { auth: AuthSession }>();
    const authorization = req.headers.authorization ?? '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    req.auth = await this.auth.authenticate(token);
    return true;
  }
}
