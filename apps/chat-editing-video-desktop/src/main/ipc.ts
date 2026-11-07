import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import {
  ExecutorCancelRequestSchema,
  ExecutorRunRequestSchema,
  IpcChannels,
  type AppInfo,
  type JobEvent,
} from '@cev/shared';
import { APP_ORIGIN } from './app-protocol.js';
import { LocalFfmpegExecutor } from './local-executor.js';
import { SessionStore } from './session-store.js';

/** Only our own renderer (app:// in prod, the dev server in dev) may call IPC. */
function assertTrustedSender(event: IpcMainInvokeEvent, devOrigin: string | undefined) {
  const url = event.senderFrame?.url ?? '';
  let ok = false;
  try {
    const parsed = new URL(url);
    ok =
      `${parsed.protocol}//${parsed.host}` === APP_ORIGIN ||
      (devOrigin !== undefined && parsed.origin === devOrigin);
  } catch {
    /* Malformed URLs are never trusted. */
  }
  if (!ok) throw new Error(`Untrusted IPC sender: ${url}`);
}

export function registerIpc(opts: {
  appInfo: AppInfo;
  outputDir: string;
  devOrigin: string | undefined;
  sessionDir: string;
  closeGuard: { enabled: boolean; confirmed: boolean };
}) {
  const executor = new LocalFfmpegExecutor(opts.outputDir);
  const running = new Map<string, AbortController>();
  const guard = (e: IpcMainInvokeEvent) => assertTrustedSender(e, opts.devOrigin);
  const sessions = new SessionStore(opts.sessionDir);
  ipcMain.handle(IpcChannels.readSession, (e) => {
    guard(e);
    return sessions.read();
  });
  ipcMain.handle(IpcChannels.saveSession, (e, token: unknown) => {
    guard(e);
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new Error('Invalid session');
    return sessions.save(token);
  });
  ipcMain.handle(IpcChannels.clearSession, (e) => {
    guard(e);
    return sessions.clear();
  });
  ipcMain.handle(IpcChannels.windowAction, (e, action: unknown) => {
    guard(e);
    const win = BrowserWindow.fromWebContents(e.sender);
    if (action === 'minimize') win?.minimize();
    else if (action === 'maximize') {
      if (win?.isMaximized()) win.unmaximize();
      else win?.maximize();
    } else if (action === 'close') win?.close();
    else throw new Error('Invalid window action');
  });
  ipcMain.handle(IpcChannels.setCloseGuard, (e, enabled: unknown) => {
    guard(e);
    if (typeof enabled !== 'boolean') throw new Error('Invalid close guard');
    opts.closeGuard.enabled = enabled;
  });
  ipcMain.handle(IpcChannels.confirmClose, (e) => {
    guard(e);
    opts.closeGuard.confirmed = true;
    BrowserWindow.fromWebContents(e.sender)?.close();
  });

  ipcMain.handle(IpcChannels.getAppInfo, (e) => {
    guard(e);
    return opts.appInfo;
  });

  ipcMain.handle(IpcChannels.pickVideoFiles, async (e) => {
    guard(e);
    const win = BrowserWindow.fromWebContents(e.sender);
    const result = await dialog.showOpenDialog(win!, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Video', extensions: ['mp4', 'mov'] }],
    });
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle(IpcChannels.executorRun, async (e, payload: unknown) => {
    guard(e);
    // Never trust renderer input: validate with the shared schema.
    const { jobId, plan } = ExecutorRunRequestSchema.parse(payload);
    if (running.has(jobId)) throw new Error(`Job ${jobId} is already running`);
    const abort = new AbortController();
    running.set(jobId, abort);
    const send = (event: JobEvent) => {
      if (!e.sender.isDestroyed()) e.sender.send(IpcChannels.executorEvent, event);
    };
    try {
      return await executor.execute({ jobId, plan, onEvent: send, signal: abort.signal });
    } catch (err) {
      send({ type: 'failed', jobId, error: err instanceof Error ? err.message : String(err) });
      throw err;
    } finally {
      running.delete(jobId);
    }
  });

  ipcMain.handle(IpcChannels.executorCancel, (e, payload: unknown) => {
    guard(e);
    const { jobId } = ExecutorCancelRequestSchema.parse(payload);
    running.get(jobId)?.abort();
  });
}
