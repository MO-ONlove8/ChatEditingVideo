import { z } from 'zod';

export const ProjectSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  hasMainVideo: z.boolean().default(false),
  deletionPending: z.boolean().default(false),
  mediaCount: z.number().int().nonnegative().default(0),
  processingCount: z.number().int().nonnegative().default(0),
  failedCount: z.number().int().nonnegative().default(0),
});
export type Project = z.infer<typeof ProjectSchema>;

export const CreateProjectSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).optional(),
});
export type CreateProjectInput = z.infer<typeof CreateProjectSchema>;

export const UpdateProjectSchema = CreateProjectSchema.partial();
export type UpdateProjectInput = z.infer<typeof UpdateProjectSchema>;
