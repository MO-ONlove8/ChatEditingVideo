import { z } from 'zod';
import { FrameClipSchema } from '../timeline.js';

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

export const LegacyEditPlanSchema = z.object({
  version: z.literal(1),
  clips: z.array(ClipSchema).min(1),
  output: OutputSpecSchema.default({ container: 'mp4' }),
});
export const RenderPlanSchema = z.object({
  version: z.literal(2),
  revision: z.number().int().nonnegative(),
  clips: z
    .array(FrameClipSchema.safeExtend({ sourceKey: z.string().min(1) }))
    .min(1)
    .max(100),
  output: z.object({
    container: z.literal('mp4'),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
});
export type RenderPlan = z.infer<typeof RenderPlanSchema>;
export const EditPlanSchema = z.discriminatedUnion('version', [
  LegacyEditPlanSchema,
  RenderPlanSchema,
]);
export type EditPlan = z.infer<typeof EditPlanSchema>;
