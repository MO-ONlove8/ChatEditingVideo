import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(here, '../../apps/chat-editing-video-desktop');
// Resolve the electron binary from the desktop package (pnpm keeps deps per-package).
const electronPath = createRequire(path.join(desktopDir, 'package.json'))('electron') as string;

let app: ElectronApplication;
let page: Page;

/**
 * Launches the BUILT desktop app (out/main + web dist over app://).
 * Covers: custom protocol, CSP, preload/contextBridge, IPC, and the desktop executor.
 * No server needed — the local executor path doesn't touch the API.
 */
test.beforeAll(async () => {
  app = await electron.launch({
    executablePath: electronPath,
    args: [desktopDir],
    cwd: desktopDir,
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app?.close();
});

test('loads the web UI through app:// with the desktop bridge', async () => {
  expect(page.url()).toBe('app://local/');
  await expect(page.getByTestId('runtime')).toHaveText('桌面端');
  const hasNode = await page.evaluate(() => typeof (globalThis as { require?: unknown }).require);
  expect(hasNode).toBe('undefined'); // sandboxed: no Node in the renderer
});

test('runs an edit plan with the local executor over IPC', async () => {
  await page.getByRole('link', { name: '渲染任务' }).click();
  const desktopRadio = page.getByRole('radio', { name: /桌面端本地/ });
  await expect(desktopRadio).toBeEnabled();
  await desktopRadio.check();
  await page.getByRole('button', { name: '运行示例剪辑方案' }).click();
  await expect(page.getByRole('status')).toContainText('manifest.json', { timeout: 15_000 });
});
