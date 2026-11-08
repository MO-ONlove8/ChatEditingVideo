import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../config/config.module.js';
import type { Env } from '../config/env.js';

/**
 * Local-filesystem storage. Callers only ever see opaque, relative storage keys.
 * Swap this class for an S3/MinIO implementation later without touching callers.
 */
@Injectable()
export class StorageService {
  readonly root: string;

  constructor(@Inject(APP_CONFIG) env: Env) {
    this.root = path.resolve(env.STORAGE_DIR);
  }

  /** Builds a fresh key like `uploads/<uuid>.mp4`. Only the extension of the input is kept. */
  createKey(prefix: string, originalName = ''): string {
    const ext = path
      .extname(originalName)
      .toLowerCase()
      .replace(/[^.a-z0-9]/g, '')
      .slice(0, 10);
    return `${prefix}/${randomUUID()}${ext}`;
  }

  /** Resolves a key to an absolute path, rejecting anything that escapes the root. */
  resolve(key: string): string {
    const full = path.resolve(this.root, key);
    if (full !== this.root && !full.startsWith(this.root + path.sep)) {
      throw new Error(`Storage key escapes storage root: ${key}`);
    }
    return full;
  }

  async moveIn(tempPath: string, key: string): Promise<void> {
    const dest = this.resolve(key);
    await mkdir(path.dirname(dest), { recursive: true });
    await rename(tempPath, dest);
  }

  async write(key: string, data: string | Uint8Array): Promise<void> {
    const dest = this.resolve(key);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, data);
  }

  async exists(key: string): Promise<boolean> {
    return stat(this.resolve(key)).then(
      () => true,
      () => false,
    );
  }

  read(key: string) {
    return createReadStream(this.resolve(key));
  }

  async remove(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }

  async removeTree(key: string): Promise<void> {
    const target = this.resolve(key);
    if (target === this.root) throw new Error('Cannot remove storage root');
    await rm(target, { recursive: true, force: true });
  }
}
