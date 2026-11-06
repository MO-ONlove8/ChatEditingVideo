import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveAppFile } from './app-protocol.js';

const root = path.resolve('/srv/web');

describe('resolveAppFile', () => {
  it('serves assets inside the root', () => {
    expect(resolveAppFile(root, 'app://local/assets/index.js')).toBe(
      path.join(root, 'assets', 'index.js'),
    );
  });

  it('falls back to index.html for SPA routes', () => {
    expect(resolveAppFile(root, 'app://local/')).toBe(path.join(root, 'index.html'));
    expect(resolveAppFile(root, 'app://local/chat')).toBe(path.join(root, 'index.html'));
  });

  it('never resolves outside the root, however the path is encoded', () => {
    const attempts = [
      'app://local/../../secret.txt',
      'app://local/..%2F..%2Fsecret.txt',
      'app://local/%2e%2e/%2e%2e/etc/passwd',
      'app://local/..%5C..%5Cwindows%5Cwin.ini',
      'app://local/assets/../../../x.js',
    ];
    for (const url of attempts) {
      const file = resolveAppFile(root, url);
      if (file !== null) expect(file.startsWith(root + path.sep), `${url} → ${file}`).toBe(true);
    }
  });

  it('rejects foreign hosts, other schemes and NUL bytes', () => {
    expect(resolveAppFile(root, 'app://evil/index.html')).toBeNull();
    expect(resolveAppFile(root, 'file:///etc/passwd')).toBeNull();
    expect(resolveAppFile(root, 'app://local/a%00.js')).toBeNull();
  });
});
