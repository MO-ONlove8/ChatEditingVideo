import type { EditPlan } from './schemas/edit-plan.js';
import type { JobEvent } from './schemas/job.js';

/**
 * Where an EditPlan is rendered. Both implementations exist in the scaffold:
 *  - 'desktop': Electron main process runs FFmpeg on the user's machine (IPC).
 *  - 'server' : NestJS enqueues a BullMQ job; a worker runs FFmpeg (HTTP + SSE).
 * Which one the product uses is decided later from the requirements doc.
 */
export type ExecutorKind = 'desktop' | 'server';

export interface ExecuteOptions {
  jobId: string;
  plan: EditPlan;
  onEvent?: (event: JobEvent) => void;
  signal?: AbortSignal;
}

export interface ExecuteResult {
  /** Desktop: absolute output path. Server: storage key of the rendered file. */
  output: string;
}

export interface EditExecutor {
  readonly kind: ExecutorKind;
  execute(options: ExecuteOptions): Promise<ExecuteResult>;
}
