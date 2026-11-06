import { type DynamicModule, Global, Module } from '@nestjs/common';
import type { Env } from './env.js';

export const APP_CONFIG = Symbol('APP_CONFIG');

/**
 * Env is parsed once in main.ts (fail-fast) and passed in, so tests can supply
 * their own config and modules can make registration decisions from it.
 */
@Global()
@Module({})
export class AppConfigModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: AppConfigModule,
      providers: [{ provide: APP_CONFIG, useValue: env }],
      exports: [APP_CONFIG],
    };
  }
}
