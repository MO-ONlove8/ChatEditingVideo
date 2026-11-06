import { describe, expect, it } from 'vitest';
import { IpcChannels } from '@cev/shared';
import { readFileSync } from 'node:fs';

/**
 * The sandboxed preload duplicates channel names instead of importing @cev/shared
 * (keeps it dependency-free). This test fails if they ever drift apart.
 */
describe('IPC contract', () => {
  it('preload channel names match @cev/shared IpcChannels', () => {
    const src = readFileSync(new URL('../preload/index.ts', import.meta.url), 'utf8');
    for (const [key, channel] of Object.entries(IpcChannels)) {
      expect(src, `preload is missing ${key}: '${channel}'`).toContain(`${key}: '${channel}'`);
    }
  });
});
