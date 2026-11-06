import { setTimeout as sleep } from 'node:timers/promises';
import { Injectable } from '@nestjs/common';
import type { EditExecutor, ExecuteOptions, ExecuteResult } from '@cev/shared';
import { StorageService } from '../../storage/storage.service.js';

/**
 * Server-side executor (runs inside the BullMQ worker).
 *
 * SCAFFOLD STUB: it simulates progress and writes a JSON render manifest instead
 * of a video. Replace the body with an FFmpeg invocation (spawn `ffmpeg`, parse
 * `-progress pipe:1` for percentages) once the requirements decide the pipeline.
 */
@Injectable()
export class FfmpegServerExecutor implements EditExecutor {
  readonly kind = 'server' as const;

  constructor(private readonly storage: StorageService) {}

  async execute({ jobId, plan, onEvent, signal }: ExecuteOptions): Promise<ExecuteResult> {
    const steps = 5;
    for (let i = 1; i <= steps; i++) {
      signal?.throwIfAborted();
      await sleep(300);
      onEvent?.({ type: 'progress', jobId, progress: Math.round((i / steps) * 100) });
    }
    const outputKey = `renders/${jobId}.manifest.json`;
    await this.storage.write(outputKey, JSON.stringify({ jobId, plan, stub: true }, null, 2));
    return { output: outputKey };
  }
}
