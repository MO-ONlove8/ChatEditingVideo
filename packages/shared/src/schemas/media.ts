import { z } from 'zod';
export const AssetKindSchema = z.enum(['video', 'image', 'audio', 'srt']);
export type AssetKind = z.infer<typeof AssetKindSchema>;
export const AuxiliaryInfoSchema = z.object({
  width: z.number().optional(),
  height: z.number().optional(),
  frames: z.number().int().optional(),
  audioTrackIndex: z.number().int().nonnegative().optional(),
  workingKey: z.string().optional(),
  mime: z.string().optional(),
  cues: z
    .array(
      z.object({
        text: z.string(),
        startFrame: z.number().int(),
        endFrame: z.number().int(),
        originalNumber: z.string(),
        position: z.number().int(),
        startMs: z.number(),
        endMs: z.number(),
      }),
    )
    .optional(),
});
export type AuxiliaryInfo = z.infer<typeof AuxiliaryInfoSchema>;

export const MediaPolicySchema = z.object({
  maxBatch: z.number().int().positive(),
  maxAssets: z.number().int().positive(),
  maxBytes: z.number().int().positive(),
  fps: z.literal(30),
});
export const MediaInfoSchema = z.object({
  duration: z.number().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  hasAudio: z.boolean(),
  rotation: z.number(),
  hdr: z.boolean(),
  frameCount: z.number().int().positive().optional(),
});
export type MediaInfo = z.infer<typeof MediaInfoSchema>;
export const EditingMediaSchema = z.object({
  kind: z.enum(['original', 'normalized']),
  info: MediaInfoSchema.safeExtend({ frameCount: z.number().int().positive() }),
});
export type EditingMedia = z.infer<typeof EditingMediaSchema>;
export const MediaStatusSchema = z.enum(['queued', 'processing', 'ready', 'failed']);

export const MediaAssetSchema = z.object({
  kind: AssetKindSchema.default('video'),
  auxiliary: AuxiliaryInfoSchema.nullable().default(null),
  editingKey: z.string().nullable().optional(),
  normalizedKey: z.string().nullable().optional(),
  id: z.uuid(),
  projectId: z.uuid(),
  fileName: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  /** Storage key relative to the storage root. Never an absolute path. */
  storageKey: z.string(),
  number: z.number().int().positive(),
  status: MediaStatusSchema,
  stage: z.string(),
  progress: z.number().min(0).max(100),
  error: z.string().nullable(),
  generation: z.number().int().positive(),
  deleting: z.boolean().default(false),
  original: MediaInfoSchema.nullable(),
  normalized: MediaInfoSchema.nullable(),
  editing: EditingMediaSchema.nullable().default(null),
  createdAt: z.iso.datetime(),
});
export type MediaAsset = z.infer<typeof MediaAssetSchema>;

export const CreateUploadsSchema = z.object({
  contextId: z.uuid(),
  projectId: z.uuid().optional(),
  files: z
    .array(
      z.object({
        id: z.uuid(),
        fileName: z
          .string()
          .min(1)
          .max(255)
          .regex(/\.(mp4|mov|png|jpe?g|webp|mp3|wav|m4a|srt)$/i, '文件格式不受支持'),
        kind: AssetKindSchema.default('video'),
        sizeBytes: z.number().int().positive(),
      }),
    )
    .min(1)
    .max(3),
});
export type CreateUploadsInput = z.infer<typeof CreateUploadsSchema>;
export const UploadSchema = z.object({
  id: z.uuid(),
  contextId: z.uuid(),
  projectId: z.uuid().nullable(),
  fileName: z.string(),
  sizeBytes: z.number().int(),
  status: z.enum(['pending', 'uploading', 'validating', 'saved', 'failed', 'cancelled']),
  error: z.string().nullable(),
  asset: MediaAssetSchema.nullable(),
});
export type Upload = z.infer<typeof UploadSchema>;
export const ImageIndexSchema = z.object({
  status: z.enum(['processing', 'ready']),
  generation: z.number().int(),
  images: z.array(z.object({ frame: z.number().int(), path: z.string() })),
  sprite: z
    .object({ path: z.string(), width: z.number(), height: z.number(), columns: z.number() })
    .optional(),
});
export type ImageIndex = z.infer<typeof ImageIndexSchema>;
