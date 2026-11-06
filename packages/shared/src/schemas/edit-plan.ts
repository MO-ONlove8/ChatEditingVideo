import { z } from 'zod';

/**
 * An EditPlan is what the chat/LLM produces: a declarative timeline.
 * Executors (desktop-local or server-worker) turn it into a rendered file.
 * Keep it declarative so either executor can run the same plan.
 */
export const ClipSchema = z
  .object({
    /** MediaAsset id (server) or local file path (desktop) depending on executor. */
    source: z.string().min(1),
    startSec: z.number().nonnegative(),
    endSec: z.number().positive(),
  })
  .refine((c) => c.endSec > c.startSec, { message: 'endSec must be greater than startSec' });
export type Clip = z.infer<typeof ClipSchema>;

export const OutputSpecSchema = z.object({
  container: z.enum(['mp4', 'webm']).default('mp4'),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});

export const EditPlanSchema = z.object({
  version: z.literal(1),
  clips: z.array(ClipSchema).min(1),
  output: OutputSpecSchema.default({ container: 'mp4' }),
});
export type EditPlan = z.infer<typeof EditPlanSchema>;
