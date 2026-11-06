import { describe, expect, it } from 'vitest';
import { EnvSchema, loadEnv } from './env.js';

const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
};

describe('env', () => {
  it('applies defaults for local Ollama', () => {
    const env = EnvSchema.parse(base);
    expect(env.LLM_BASE_URL).toBe('http://localhost:11434/v1');
    expect(env.LLM_MODEL).toBe('qwen3:8b');
    expect(env.PORT).toBe(3000);
    expect(env.JOBS_WORKER_ENABLED).toBe(true);
  });

  it('parses CSV origins and booleans', () => {
    const env = EnvSchema.parse({ ...base, CORS_ORIGINS: 'a, b,,c', JOBS_WORKER_ENABLED: 'false' });
    expect(env.CORS_ORIGINS).toEqual(['a', 'b', 'c']);
    expect(env.JOBS_WORKER_ENABLED).toBe(false);
  });

  it('fails fast with a readable message', () => {
    expect(() => loadEnv({ REDIS_URL: 'http://nope' })).toThrow(/DATABASE_URL[\s\S]*REDIS_URL/);
  });
});
