import { z } from 'zod';

export const MediaAssetSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  fileName: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  /** Storage key relative to the storage root. Never an absolute path. */
  storageKey: z.string(),
  createdAt: z.iso.datetime(),
});
export type MediaAsset = z.infer<typeof MediaAssetSchema>;
