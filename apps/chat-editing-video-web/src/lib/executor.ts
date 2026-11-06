import {
  ApiRoutes,
  EditJobSchema,
  JobEventSchema,
  type EditExecutor,
  type ExecuteOptions,
  type ExecuteResult,
  type ExecutorKind,
  type JobEvent,
} from '@cev/shared';
import { api } from './api';
import { apiBaseUrl, getDesktop } from './runtime';

/**
 * Both execution paths behind the same EditExecutor interface (from @cev/shared).
 * UI code calls `execute()` and never cares where rendering happens.
 */

/** Runs in the Electron main process via IPC. */
export function createDesktopExecutor(): EditExecutor {
  return {
    kind: 'desktop',
    async execute({ jobId, plan, onEvent, signal }: ExecuteOptions): Promise<ExecuteResult> {
      const desktop = getDesktop();
      if (!desktop) throw new Error('Desktop executor is only available in the desktop app');
      const off = desktop.onExecutorEvent((e) => e.jobId === jobId && onEvent?.(e));
      const onAbort = () => void desktop.cancelEditPlan(jobId);
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        return await desktop.runEditPlan({ jobId, plan });
      } finally {
        off();
        signal?.removeEventListener('abort', onAbort);
      }
    },
  };
}

/** Enqueues on the server (BullMQ) and follows progress over SSE. */
export function createServerExecutor(projectId: string): EditExecutor {
  return {
    kind: 'server',
    async execute({ plan, onEvent, signal }: ExecuteOptions): Promise<ExecuteResult> {
      const job = await api(EditJobSchema, ApiRoutes.jobs, {
        method: 'POST',
        body: JSON.stringify({ projectId, plan }),
        signal,
      });
      return new Promise<ExecuteResult>((resolve, reject) => {
        const source = new EventSource(`${apiBaseUrl()}${ApiRoutes.jobEvents(job.id)}`);
        const close = () => source.close();
        signal?.addEventListener('abort', () => {
          close();
          reject(new DOMException('Aborted', 'AbortError'));
        });
        source.onmessage = (msg) => {
          const parsed = JobEventSchema.safeParse(JSON.parse(msg.data as string));
          if (!parsed.success) return;
          const event: JobEvent = parsed.data;
          onEvent?.(event);
          if (event.type === 'completed') {
            close();
            resolve({ output: event.outputKey });
          } else if (event.type === 'failed') {
            close();
            reject(new Error(event.error));
          }
        };
        source.onerror = () => {
          // EventSource auto-reconnects; only give up once the stream is closed for good.
          if (source.readyState === EventSource.CLOSED) reject(new Error('Progress stream closed'));
        };
      });
    },
  };
}

export function createExecutor(kind: ExecutorKind, projectId: string): EditExecutor {
  return kind === 'desktop' ? createDesktopExecutor() : createServerExecutor(projectId);
}
