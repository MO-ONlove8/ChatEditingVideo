import { z } from 'zod';
import { EditPlanSchema } from './edit-plan.js';

export const JobStatusSchema = z.enum(['queued', 'running', 'succeeded', 'failed']);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const EditJobSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  status: JobStatusSchema,
  progress: z.number().min(0).max(100),
  plan: EditPlanSchema,
  outputKey: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type EditJob = z.infer<typeof EditJobSchema>;

export const CreateEditJobSchema = z
  .object({
    projectId: z.uuid(),
    plan: EditPlanSchema,
  })
  .refine((input) => input.plan.clips.every((clip) => z.uuid().safeParse(clip.source).success), {
    message: '服务端剪辑方案必须引用已上传的素材 ID',
    path: ['plan', 'clips'],
  });
export type CreateEditJobInput = z.infer<typeof CreateEditJobSchema>;

/** Events streamed over SSE (server) or IPC (desktop) while a job runs. */
export const JobEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('progress'),
    jobId: z.string(),
    progress: z.number().min(0).max(100),
  }),
  z.object({ type: z.literal('completed'), jobId: z.string(), outputKey: z.string() }),
  z.object({ type: z.literal('failed'), jobId: z.string(), error: z.string() }),
]);
export type JobEvent = z.infer<typeof JobEventSchema>;
