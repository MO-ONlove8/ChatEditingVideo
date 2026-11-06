import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { EditExecutor, ExecuteOptions, ExecuteResult } from '@cev/shared';

/**
 * Desktop executor: renders on the user's machine from the Electron main process.
 *
 * SCAFFOLD STUB: simulates progress and writes a JSON manifest. To make it real,
 * bundle an FFmpeg binary (e.g. ship it via electron-builder `extraResources`),
 * `spawn` it with `-progress pipe:1`, and map `out_time_ms` to a percentage.
 * Use `signal` to kill the child process on cancel.
 */
export class LocalFfmpegExecutor implements EditExecutor {
  readonly kind = 'desktop' as const;

  constructor(private readonly outputDir: string) {}

  async execute({ jobId, plan, onEvent, signal }: ExecuteOptions): Promise<ExecuteResult> {
    const steps = 5;
    for (let i = 1; i <= steps; i++) {
      signal?.throwIfAborted();
      await sleep(200, undefined, { signal });
      onEvent?.({ type: 'progress', jobId, progress: Math.round((i / steps) * 100) });
    }
    await mkdir(this.outputDir, { recursive: true });
    const safeId = jobId.replace(/[^a-zA-Z0-9-]/g, '_');
    const output = path.join(this.outputDir, `${safeId}.manifest.json`);
    await writeFile(output, JSON.stringify({ jobId, plan, stub: true }, null, 2));
    onEvent?.({ type: 'completed', jobId, outputKey: output });
    return { output };
  }
}
