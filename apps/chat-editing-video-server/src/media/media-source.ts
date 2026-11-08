import type { MediaAssetRow } from '../database/schema.js';

/** Resolve historical normalized files and new immutable editing sources in one place. */
export function editingSource(asset: MediaAssetRow) {
  if (asset.editing && asset.editingKey) return { ...asset.editing, key: asset.editingKey };
  if (asset.normalized?.frameCount && asset.normalizedKey)
    return { kind: 'normalized' as const, info: asset.normalized, key: asset.normalizedKey };
  return null;
}
