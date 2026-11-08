import type { INestApplication } from '@nestjs/common';
import { API_PREFIX } from '@cev/shared';
import { Logger } from 'nestjs-pino';
import type { Env } from './config/env.js';

/** Shared app wiring used by main.ts and HTTP tests, so tests exercise the real setup. */
export function configureApp(app: INestApplication, env: Env): INestApplication {
  app.useLogger(app.get(Logger));
  app.setGlobalPrefix(API_PREFIX.replace(/^\//, ''));
  app.enableCors({
    origin: env.CORS_ORIGINS,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    exposedHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length'],
    credentials: false,
  });
  app.enableShutdownHooks();
  return app;
}
