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
  QUEUE_PREFIX: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/)
    .default('bull'),
  STORAGE_DIR: z.string().min(1).default('./storage'),
  /** Max upload size in MB. */
  UPLOAD_MAX_MB: z.coerce.number().int().positive().default(1024),
  MEDIA_MAX_ASSETS: z.coerce.number().int().positive().default(10),
  FFMPEG_PATH: z.string().default('ffmpeg'),
  FFPROBE_PATH: z.string().default('ffprobe'),
  MEDIA_WORKER_ENABLED: z.stringbool().default(true),
  MEDIA_THREADS: z.coerce.number().int().min(1).max(32).default(4),
  MEDIA_CACHE_MB: z.coerce.number().positive().default(2048),
  LLM_BASE_URL: z.url().default('http://localhost:11434/v1'),
  LLM_API_KEY: z.string().default('ollama'),
  LLM_MODEL: z.string().min(1).default('qwen3:8b'),
  LLM_OLLAMA_CPU: z.stringbool().default(false),
  LLM_TIMEOUT_MS: z.coerce.number().int().min(1000).default(180000),
  /** Disable to run the API without consuming render jobs (e.g. a separate worker process later). */
  JOBS_WORKER_ENABLED: z.stringbool().default(true),
  AUTH_CODE_TTL_SECONDS: z.coerce.number().int().min(60).default(300),
  AUTH_CODE_RESEND_SECONDS: z.coerce.number().int().min(1).default(60),
  AUTH_SESSION_TTL_SECONDS: z.coerce.number().int().min(60).default(604800),
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
