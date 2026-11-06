import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';
import { APP_CONFIG } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { redisOptionsFromUrl } from './redis-options.js';

/** General-purpose Redis client (cache, pub/sub publishing). BullMQ manages its own connections. */
export const REDIS = Symbol('REDIS');

/** Attach a rate-limited error logger so a down Redis doesn't spam "Unhandled error event". */
export function logRedisErrors(redis: Redis, name: string): Redis {
  const logger = new Logger(name);
  let last = 0;
  redis.on('error', (err: Error) => {
    const now = Date.now();
    if (now - last > 30_000) {
      last = now;
      logger.warn(`Redis unavailable: ${err.message || err.name}`);
    }
  });
  return redis;
}

/** The client is lazy and has no offline queue, so connect on first use. */
export async function ensureConnected(redis: Redis): Promise<void> {
  if (redis.status === 'wait' || redis.status === 'end') await redis.connect();
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [APP_CONFIG],
      useFactory: (env: Env) =>
        logRedisErrors(
          new Redis({
            ...redisOptionsFromUrl(env.REDIS_URL),
            lazyConnect: true,
            maxRetriesPerRequest: 1,
            enableOfflineQueue: false,
          }),
          'Redis',
        ),
    },
  ],
  exports: [REDIS],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  onApplicationShutdown() {
    if (this.redis.status !== 'end') this.redis.disconnect();
  }
}
