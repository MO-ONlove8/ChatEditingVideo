import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Env } from '../config/env.js';
import { StorageService } from './storage.service.js';

const storage = new StorageService({ STORAGE_DIR: './tmp-storage' } as Env);

describe('StorageService', () => {
  it('creates keys that keep only a sanitized extension', () => {
    const key = storage.createKey('uploads', '../../evil name.MP4');
    expect(key).toMatch(/^uploads\/[0-9a-f-]{36}\.mp4$/);
  });

  it('resolves keys inside the root', () => {
    expect(storage.resolve('a/b.mp4')).toBe(path.join(storage.root, 'a', 'b.mp4'));
  });

  it('rejects keys that escape the root', () => {
    expect(() => storage.resolve('../outside.txt')).toThrow(/escapes/);
    expect(() => storage.resolve(path.resolve('/etc/passwd'))).toThrow(/escapes/);
  });
});
