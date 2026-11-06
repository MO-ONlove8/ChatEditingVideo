import { existsSync } from 'node:fs';
import { z } from 'zod';

const csv = z.string().transform((s) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean),
);

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  CORS_ORIGINS: csv.default(['http://localhost:5173', 'app://local']),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  STORAGE_DIR: z.string().min(1).default('./storage'),
  /** Max upload size in MB. */
  UPLOAD_MAX_MB: z.coerce.number().int().positive().default(4096),
  LLM_BASE_URL: z.url().default('http://localhost:11434/v1'),
  LLM_API_KEY: z.string().default('ollama'),
  LLM_MODEL: z.string().min(1).default('qwen3:8b'),
  /** Disable to run the API without consuming render jobs (e.g. a separate worker process later). */
  JOBS_WORKER_ENABLED: z.stringbool().default(true),
});
export type Env = z.infer<typeof EnvSchema>;

/** Parse and validate env. Fails fast at startup with a readable list of problems. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (source === process.env && existsSync('.env')) process.loadEnvFile('.env');
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  return result.data;
}
