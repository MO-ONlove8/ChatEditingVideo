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
import { api, apiFetch } from './api';
import { getDesktop } from './runtime';
import { readSseJson } from './sse';

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
      if (plan.version === 1) throw new Error('请先确认并保存剪辑结果，再生成成品');
      const job = await api(EditJobSchema, ApiRoutes.jobs, {
        method: 'POST',
        body: JSON.stringify({
          projectId,
          expectedRevision: plan.revision,
          requestId: crypto.randomUUID(),
        }),
        signal,
      });
      const controller = new AbortController();
      const combinedSignal = signal
        ? AbortSignal.any([signal, controller.signal])
        : controller.signal;
      try {
        const response = await apiFetch(ApiRoutes.jobEvents(job.id), { signal: combinedSignal });
        for await (const raw of readSseJson(response)) {
          const parsed = JobEventSchema.safeParse(raw);
          if (!parsed.success) continue;
          const event: JobEvent = parsed.data;
          onEvent?.(event);
          if (event.type === 'completed') {
            return { output: event.outputKey };
          } else if (event.type === 'failed') {
            throw new Error(event.error);
          }
        }
        throw new Error('进度连接已中断，请重新查看任务状态');
      } finally {
        controller.abort();
      }
    },
  };
}

export function createExecutor(kind: ExecutorKind, projectId: string): EditExecutor {
  return kind === 'desktop' ? createDesktopExecutor() : createServerExecutor(projectId);
}
