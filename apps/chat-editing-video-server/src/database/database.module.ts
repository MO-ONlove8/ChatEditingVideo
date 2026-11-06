import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { APP_CONFIG } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import * as schema from './schema.js';

export const DB = Symbol('DB');
export const PG_CLIENT = Symbol('PG_CLIENT');
export type Database = PostgresJsDatabase<typeof schema>;

@Global()
@Module({
  providers: [
    {
      provide: PG_CLIENT,
      inject: [APP_CONFIG],
      // postgres.js connects lazily on first query, so the app boots even if PG is down.
      useFactory: (env: Env) => postgres(env.DATABASE_URL, { max: 10, onnotice: () => {} }),
    },
    {
      provide: DB,
      inject: [PG_CLIENT],
      useFactory: (client: postgres.Sql) => drizzle(client, { schema, casing: 'snake_case' }),
    },
  ],
  exports: [DB, PG_CLIENT],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(PG_CLIENT) private readonly client: postgres.Sql) {}

  async onApplicationShutdown() {
    await this.client.end({ timeout: 5 });
  }
}
