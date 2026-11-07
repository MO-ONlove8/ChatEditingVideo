import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { safeStorage } from 'electron';

/** Never fall back to a plaintext token on disk. */
export class SessionStore {
  private memory: string | null = null;
  constructor(private readonly directory: string) {}
  private get file() {
    return path.join(this.directory, 'session.bin');
  }
  async read(): Promise<string | null> {
    if (this.memory) return this.memory;
    if (!safeStorage.isEncryptionAvailable()) return null;
    try {
      return (this.memory = safeStorage.decryptString(await readFile(this.file)));
    } catch {
      return null;
    }
  }
  async save(token: string) {
    if (safeStorage.isEncryptionAvailable()) {
      await mkdir(this.directory, { recursive: true });
      await writeFile(this.file, safeStorage.encryptString(token));
    } else {
      await rm(this.file, { force: true });
    }
    this.memory = token;
  }
  async clear() {
    this.memory = null;
    await rm(this.file, { force: true });
  }
}
