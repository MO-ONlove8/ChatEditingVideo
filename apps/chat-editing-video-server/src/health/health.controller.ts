import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { Redis } from 'ioredis';
import { sql } from 'drizzle-orm';
import type { Health } from '@cev/shared';
import { DB, type Database } from '../database/database.module.js';
import { REDIS, ensureConnected } from '../redis/redis.module.js';
import { LlmService } from '../llm/llm.service.js';
import { Public } from '../auth/auth.guard.js';

const TIMEOUT_MS = 1500;

async function probe(fn: () => Promise<unknown>): Promise<'up' | 'down'> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS);
      }),
    ]);
    return 'up';
  } catch {
    return 'down';
  } finally {
    clearTimeout(timer);
  }
}

@Controller('health')
@Public()
export class HealthController {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly llm: LlmService,
  ) {}

  /** 200 when DB and Redis are up; 503 otherwise. LLM is reported but non-critical. */
  @Get()
  async check(@Res({ passthrough: true }) res: Response): Promise<Health> {
    const [database, redis, llm] = await Promise.all([
      probe(() => this.db.execute(sql`select 1`)),
      probe(async () => {
        await ensureConnected(this.redis);
        return this.redis.ping();
      }),
      probe(() => this.llm.ping()),
    ]);
    const ok = database === 'up' && redis === 'up';
    res.status(ok ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return {
      status: ok ? 'ok' : 'degraded',
      uptimeSec: Math.round(process.uptime()),
      checks: { database, redis, llm },
    };
  }
}
