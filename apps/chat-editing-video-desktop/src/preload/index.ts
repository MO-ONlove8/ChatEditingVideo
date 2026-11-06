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
} as const;

/** The only surface the renderer gets. No raw ipcRenderer, no Node APIs. */
const api: DesktopApi = {
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
