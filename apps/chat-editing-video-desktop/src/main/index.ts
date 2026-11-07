import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { BrowserWindow, app, net, protocol, shell } from 'electron';
import { APP_ORIGIN, APP_SCHEME, resolveAppFile } from './app-protocol.js';
import { registerIpc } from './ipc.js';
import { IpcChannels } from '@cev/shared';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Dev: the web app's Vite server. Unset (or empty) in production/preview builds. */
const DEV_URL = (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) || undefined;
const API_BASE_URL = process.env.CEV_API_BASE_URL || 'http://localhost:3000/api';
const closeGuard = { enabled: false, confirmed: false };
// Isolate development/test profiles from the user's installed application.
if (!app.isPackaged && process.env.CEV_USER_DATA_DIR) {
  mkdirSync(process.env.CEV_USER_DATA_DIR, { recursive: true });
  app.setPath('userData', process.env.CEV_USER_DATA_DIR);
}

/** Packaged: resources/web (electron-builder extraResources). Unpackaged: the web app's dist. */
const WEB_DIST = app.isPackaged
  ? path.join(process.resourcesPath, 'web')
  : path.resolve(here, '../../../chat-editing-video-web/dist');

// Must run before app 'ready'. Makes app:// behave like https (fetch, CORS, storage).
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob: data:",
  "worker-src 'self' blob:",
  `connect-src 'self' ${new URL(API_BASE_URL).origin}`,
].join('; ');

function registerAppProtocol() {
  protocol.handle(APP_SCHEME, async (request) => {
    const file = resolveAppFile(WEB_DIST, request.url);
    if (!file || !existsSync(file)) return new Response('Not found', { status: 404 });
    const res = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers(res.headers);
    if (file.endsWith('.html')) headers.set('Content-Security-Policy', CSP);
    return new Response(res.body, { status: res.status, headers });
  });
}

async function loadWithRetry(win: BrowserWindow, url: string, attempts = 30) {
  for (let i = 1; ; i++) {
    try {
      return await win.loadURL(url);
    } catch (err) {
      // In `pnpm dev` the web dev server may still be starting.
      if (i >= attempts || win.isDestroyed()) throw err;
      await sleep(1000);
    }
  }
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    title: 'Chat Editing Video',
    show: false,
    frame: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(here, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  win.once('ready-to-show', () => win.show());
  win.on('close', (event) => {
    if (closeGuard.enabled && !closeGuard.confirmed) {
      event.preventDefault();
      win.webContents.send(IpcChannels.closeRequested);
    }
  });

  // Open external links in the system browser; never spawn in-app windows.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  const allowedOrigin = DEV_URL ? new URL(DEV_URL).origin : APP_ORIGIN;
  win.webContents.on('will-navigate', (event, url) => {
    const parsed = new URL(url);
    // Node's URL reports "null" for the privileged app scheme.
    const origin =
      parsed.protocol === `${APP_SCHEME}:` ? `${parsed.protocol}//${parsed.host}` : parsed.origin;
    if (origin !== allowedOrigin) event.preventDefault();
  });

  await loadWithRetry(win, DEV_URL ?? `${APP_ORIGIN}/`);
  if (DEV_URL) win.webContents.openDevTools({ mode: 'detach' });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    app.setAppUserModelId('com.chateditingvideo.desktop');
    registerAppProtocol();
    registerIpc({
      appInfo: {
        platform: process.platform,
        appVersion: app.getVersion(),
        apiBaseUrl: API_BASE_URL,
      },
      outputDir: path.join(app.getPath('videos'), 'ChatEditingVideo'),
      devOrigin: DEV_URL ? new URL(DEV_URL).origin : undefined,
      sessionDir: app.getPath('userData'),
      closeGuard,
    });
    await createWindow();
  });

  app.on('window-all-closed', () => app.quit());
}
