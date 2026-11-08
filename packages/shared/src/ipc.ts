import { z } from 'zod';
import { EditPlanSchema } from './schemas/edit-plan.js';
import type { JobEvent } from './schemas/job.js';

/** Electron IPC channel names. Renderer never sees raw ipcRenderer; only DesktopApi. */
export const IpcChannels = {
  getAppInfo: 'app:get-info',
  pickVideoFiles: 'dialog:pick-video-files',
  executorRun: 'executor:run',
  executorCancel: 'executor:cancel',
  executorEvent: 'executor:event',
  readSession: 'session:read',
  saveSession: 'session:save',
  clearSession: 'session:clear',
  windowAction: 'window:action',
  setCloseGuard: 'window:set-close-guard',
  closeRequested: 'window:close-requested',
  confirmClose: 'window:confirm-close',
  downloadRender: 'render:download',
  cancelRenderDownload: 'render:cancel-download',
} as const;

export const AppInfoSchema = z.object({
  platform: z.string(),
  appVersion: z.string(),
  apiBaseUrl: z.url(),
});
export type AppInfo = z.infer<typeof AppInfoSchema>;

/** Payloads crossing the IPC boundary are validated in main with these schemas. */
export const ExecutorRunRequestSchema = z.object({
  jobId: z.string().min(1).max(100),
  plan: EditPlanSchema,
});
export type ExecutorRunRequest = z.infer<typeof ExecutorRunRequestSchema>;

export const ExecutorCancelRequestSchema = z.object({ jobId: z.string().min(1).max(100) });

/** Shape exposed on `window.desktop` by the preload script. */
export interface DesktopApi {
  downloadRender(jobId: string): Promise<{ cancelled: boolean }>;
  cancelRenderDownload(jobId: string): Promise<void>;
  readSession(): Promise<string | null>;
  saveSession(token: string): Promise<void>;
  clearSession(): Promise<void>;
  windowAction(action: 'minimize' | 'maximize' | 'close'): Promise<void>;
  setCloseGuard(enabled: boolean): Promise<void>;
  onCloseRequested(listener: () => void): () => void;
  confirmClose(): Promise<void>;
  getAppInfo(): Promise<AppInfo>;
  pickVideoFiles(): Promise<string[]>;
  runEditPlan(request: ExecutorRunRequest): Promise<{ output: string }>;
  cancelEditPlan(jobId: string): Promise<void>;
  /** Returns an unsubscribe function. */
  onExecutorEvent(listener: (event: JobEvent) => void): () => void;
}
