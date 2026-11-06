import { EventEmitter } from 'node:events';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { JobEventSchema, type JobEvent } from '@cev/shared';
import { APP_CONFIG } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { REDIS, ensureConnected, logRedisErrors } from '../redis/redis.module.js';
import { redisOptionsFromUrl } from '../redis/redis-options.js';
import { jobEventsChannel } from './jobs.constants.js';

const PATTERN = jobEventsChannel('*');
const PREFIX = jobEventsChannel('');

/**
 * Fans job events out across processes via Redis pub/sub, so the worker and the
 * API instance holding the SSE connection don't need to be the same process.
 * One shared subscriber connection per API process; local EventEmitter fan-out.
 */
@Injectable()
export class JobEventsBus implements OnModuleDestroy {
  private readonly emitter = new EventEmitter().setMaxListeners(0);
  private sub?: Redis;
  private subReady?: Promise<unknown>;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly env: Env,
  ) {}

  async publish(event: JobEvent): Promise<void> {
    await ensureConnected(this.redis);
    await this.redis.publish(jobEventsChannel(event.jobId), JSON.stringify(event));
  }

  async subscribe(jobId: string, listener: (e: JobEvent) => void): Promise<() => void> {
    await this.ensureSubscriber();
    this.emitter.on(jobId, listener);
    return () => this.emitter.off(jobId, listener);
  }

  private ensureSubscriber() {
    if (!this.subReady) {
      const sub = logRedisErrors(
        new Redis({ ...redisOptionsFromUrl(this.env.REDIS_URL), lazyConnect: true }),
        'JobEventsBus',
      );
      sub.on('pmessage', (_pattern: string, channel: string, message: string) => {
        const parsed = JobEventSchema.safeParse(JSON.parse(message));
        if (parsed.success) this.emitter.emit(channel.slice(PREFIX.length), parsed.data);
      });
      this.sub = sub;
      this.subReady = sub.connect().then(() => sub.psubscribe(PATTERN));
      // Allow a retry on the next call if the first connect failed.
      this.subReady.catch(() => {
        this.subReady = undefined;
        sub.disconnect();
      });
    }
    return this.subReady;
  }

  onModuleDestroy() {
    this.sub?.disconnect();
  }
}
