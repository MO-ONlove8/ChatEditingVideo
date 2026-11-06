import { Inject, Injectable } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import type { MediaAsset } from '@cev/shared';
import { DB, type Database } from '../database/database.module.js';
import { mediaAssets, type MediaAssetRow } from '../database/schema.js';
import { ProjectsService } from '../projects/projects.service.js';
import { StorageService } from '../storage/storage.service.js';

function toMediaAsset(row: MediaAssetRow): MediaAsset {
  return {
    id: row.id,
    projectId: row.projectId,
    fileName: row.fileName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    storageKey: row.storageKey,
    createdAt: row.createdAt.toISOString(),
  };
}

@Injectable()
export class MediaService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly storage: StorageService,
    private readonly projects: ProjectsService,
  ) {}

  async list(projectId: string): Promise<MediaAsset[]> {
    await this.projects.get(projectId);
    const rows = await this.db
      .select()
      .from(mediaAssets)
      .where(eq(mediaAssets.projectId, projectId))
      .orderBy(desc(mediaAssets.createdAt));
    return rows.map(toMediaAsset);
  }

  /** Moves an uploaded temp file into storage and records it. Cleans up on failure. */
  async ingest(projectId: string, file: Express.Multer.File): Promise<MediaAsset> {
    await this.projects.get(projectId);
    const key = this.storage.createKey(`projects/${projectId}/media`, file.originalname);
    await this.storage.moveIn(file.path, key);
    try {
      const [row] = await this.db
        .insert(mediaAssets)
        .values({
          projectId,
          fileName: file.originalname.slice(0, 255),
          mimeType: file.mimetype,
          sizeBytes: file.size,
          storageKey: key,
        })
        .returning();
      return toMediaAsset(row!);
    } catch (err) {
      await this.storage.remove(key);
      throw err;
    }
  }
}
