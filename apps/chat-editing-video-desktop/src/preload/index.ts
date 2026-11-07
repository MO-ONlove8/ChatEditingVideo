import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { DesktopApi, JobEvent } from '@cev/shared';

// Channel names duplicated from @cev/shared's IpcChannels on purpose: the sandboxed
// preload must stay tiny and dependency-free. ipc.contract.test.ts keeps them in sync.
const CH = {
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

/** The only surface the renderer gets. No raw ipcRenderer, no Node APIs. */
const api: DesktopApi = {
  downloadRender: (jobId) => ipcRenderer.invoke(CH.downloadRender, jobId),
  cancelRenderDownload: (jobId) => ipcRenderer.invoke(CH.cancelRenderDownload, jobId),
  readSession: () => ipcRenderer.invoke(CH.readSession),
  saveSession: (token) => ipcRenderer.invoke(CH.saveSession, token),
  clearSession: () => ipcRenderer.invoke(CH.clearSession),
  windowAction: (action) => ipcRenderer.invoke(CH.windowAction, action),
  setCloseGuard: (enabled) => ipcRenderer.invoke(CH.setCloseGuard, enabled),
  confirmClose: () => ipcRenderer.invoke(CH.confirmClose),
  onCloseRequested: (listener) => {
    ipcRenderer.on(CH.closeRequested, listener);
    return () => {
      ipcRenderer.off(CH.closeRequested, listener);
    };
  },
  getAppInfo: () => ipcRenderer.invoke(CH.getAppInfo),
  pickVideoFiles: () => ipcRenderer.invoke(CH.pickVideoFiles),
  runEditPlan: (request) => ipcRenderer.invoke(CH.executorRun, request),
  cancelEditPlan: (jobId) => ipcRenderer.invoke(CH.executorCancel, { jobId }),
  onExecutorEvent: (listener) => {
    const handler = (_e: IpcRendererEvent, event: JobEvent) => listener(event);
    ipcRenderer.on(CH.executorEvent, handler);
    return () => ipcRenderer.off(CH.executorEvent, handler);
  },
};

contextBridge.exposeInMainWorld('desktop', api);
