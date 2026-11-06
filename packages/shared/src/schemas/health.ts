import { z } from 'zod';

export const DependencyStatusSchema = z.enum(['up', 'down']);

export const HealthSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  uptimeSec: z.number(),
  checks: z.object({
    database: DependencyStatusSchema,
    redis: DependencyStatusSchema,
    llm: DependencyStatusSchema,
  }),
});
export type Health = z.infer<typeof HealthSchema>;
