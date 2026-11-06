import { type DynamicModule, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { LoggerModule } from 'nestjs-pino';
import { AppConfigModule } from './config/config.module.js';
import type { Env } from './config/env.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';
import { JobsModule } from './jobs/jobs.module.js';
import { LlmModule } from './llm/llm.module.js';
import { MediaModule } from './media/media.module.js';
import { ProjectsModule } from './projects/projects.module.js';
import { RedisModule } from './redis/redis.module.js';
import { redisOptionsFromUrl } from './redis/redis-options.js';
import { StorageModule } from './storage/storage.module.js';

/** BullMQ 6 has its own RedisOptions type; workers require maxRetriesPerRequest: null. */
function bullConnection(url: string) {
  const { host, port, username, password, db, tls } = redisOptionsFromUrl(url);
  return { host, port, username, password, db, tls, maxRetriesPerRequest: null };
}

@Module({})
export class AppModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: AppModule,
      imports: [
        AppConfigModule.forRoot(env),
        LoggerModule.forRoot({
          pinoHttp: {
            level:
              env.NODE_ENV === 'test' ? 'silent' : env.NODE_ENV === 'production' ? 'info' : 'debug',
            transport:
              env.NODE_ENV === 'development'
                ? { target: 'pino-pretty', options: { singleLine: true } }
                : undefined,
            autoLogging: { ignore: (req) => req.url?.endsWith('/health') ?? false },
            redact: ['req.headers.authorization', 'req.headers.cookie'],
          },
        }),
        BullModule.forRoot({
          connection: bullConnection(env.REDIS_URL),
        }),
        DatabaseModule,
        RedisModule,
        StorageModule,
        LlmModule,
        HealthModule,
        ProjectsModule,
        MediaModule,
        JobsModule.forRoot(env),
      ],
    };
  }
}
