import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import type { DesktopApi } from '../../packages/shared/src/ipc.js';
import { videoFixture } from '../../apps/chat-editing-video-server/test/support/video.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(here, '../../apps/chat-editing-video-desktop');
const electronPath = createRequire(path.join(desktopDir, 'package.json'))('electron') as string;
const token = 'a'.repeat(43);
const session = {
  user: { id: '00000000-0000-4000-8000-000000000010', phone: '13800138000' },
  expiresAt: '2099-01-01T00:00:00.000Z',
};
let app: ElectronApplication;
let page: Page;
let profile: string;

test.beforeAll(async () => {
  const root = path.resolve(here, '../test-results');
  await mkdir(root, { recursive: true });
  profile = await mkdtemp(path.join(root, 'electron-profile-'));
  const launchEnv: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    ELECTRON_RENDERER_URL: '',
    CEV_API_BASE_URL: 'http://127.0.0.1:49999/api',
    CEV_USER_DATA_DIR: profile,
  };
  delete launchEnv.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    executablePath: electronPath,
    args: [desktopDir],
    cwd: desktopDir,
    env: launchEnv,
  });
  page = await app.firstWindow();
  await page.route('**/api/**', async (route) => {
    const endpoint = new URL(route.request().url()).pathname;
    const headers = {
      'access-control-allow-origin': 'app://local',
      'access-control-allow-headers': 'authorization,content-type',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
    };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (endpoint.endsWith('/auth/code'))
      return route.fulfill({
        headers,
        json: {
          testCode: '123456',
          resendAt: new Date(Date.now() + 60_000).toISOString(),
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
        },
      });
    if (endpoint.endsWith('/auth/login'))
      return route.fulfill({ headers, json: { ...session, token } });
    if (endpoint.endsWith('/auth/me')) return route.fulfill({ headers, json: session });
    if (endpoint.endsWith('/auth/events'))
      return route.fulfill({
        headers,
        contentType: 'text/event-stream',
        body: 'data: {"type":"ready"}\n\n',
      });
    return route.fulfill({ headers, json: [] });
  });
  await page.waitForLoadState('domcontentloaded');
});
test.afterAll(async () => {
  await app?.close().catch(() => {});
});

test('loads app:// login with a restricted desktop bridge', async () => {
  await expect(page.getByRole('heading', { name: '手机号登录' })).toBeVisible();
  expect(page.url()).toBe('app://local/login');
  await expect(page.getByTestId('runtime')).toHaveText('桌面端');
  expect(await page.evaluate(() => typeof (globalThis as { require?: unknown }).require)).toBe(
    'undefined',
  );
  await page.screenshot({ path: test.info().outputPath('desktop-login.png') });
});

test('logs in and keeps the desktop token encrypted or only in memory', async () => {
  await page.getByLabel('大陆手机号').fill('13800138000');
  await page.getByRole('button', { name: '获取验证码' }).click();
  await page.getByLabel('验证码', { exact: true }).fill('123456');
  await page.getByRole('button', { name: '登录 / 注册' }).click();
  await expect(page.getByRole('heading', { name: '我的剪辑任务' })).toBeVisible();
  expect(
    await page.evaluate(() => (window as unknown as { desktop: DesktopApi }).desktop.readSession()),
  ).toBe(token);
  const encrypted = await app.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable());
  if (encrypted)
    expect((await readFile(path.join(profile, 'session.bin'))).includes(Buffer.from(token))).toBe(
      false,
    );
  await page.reload();
  await expect(page.getByRole('heading', { name: '我的剪辑任务' })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('cev-session'))).toBeNull();
});

test('opens the editor in the minimum native window', async () => {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(960, 600));
  await page.getByRole('link', { name: '＋ 新建' }).click();
  await expect(page.getByRole('heading', { name: '新建剪辑' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '对话剪辑' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('desktop-editor.png') });
});

test('decodes local thumbnails in a worker and previews a File under app:// CSP', async () => {
  const file = await videoFixture(path.resolve(here, '../test-results/desktop-local.mp4'));
  let upload: Record<string, unknown>;
  const headers = {
    'access-control-allow-origin': 'app://local',
    'access-control-allow-headers': 'authorization,content-type',
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
  };
  await page.route('**/api/media/policy', (route) =>
    route.fulfill({ headers, json: { maxBatch: 3, maxAssets: 10, maxBytes: 1024 ** 3, fps: 30 } }),
  );
  await page.route('**/api/uploads', async (route) => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers });
      return;
    }
    const input = route.request().postDataJSON();
    upload = {
      ...input.files[0],
      contextId: input.contextId,
      projectId: null,
      status: 'pending',
      error: null,
      asset: null,
    };
    await route.fulfill({ status: 201, headers, json: [upload] });
  });
  await page.route('**/api/uploads/*/content', async (route) => {
    if (route.request().method() === 'OPTIONS') await route.fulfill({ status: 204, headers });
  });
  await page.route('**/api/uploads/*', (route) =>
    route.fulfill({ headers, json: { ...upload, status: 'cancelled' } }),
  );
  await page.getByLabel('选择视频素材').setInputFiles(file);
  await page.getByTestId('local-thumbnail').first().scrollIntoViewIfNeeded();
  await expect(page.getByTestId('local-thumbnail').first()).toHaveAttribute('data-loaded', 'true');
  await page.getByRole('button', { name: '播放素材 V0' }).click();
  const video = page.getByRole('region', { name: 'V0 素材预览' }).locator('video');
  await expect(video).toBeVisible();
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState))
    .toBeGreaterThanOrEqual(2);
  await page.getByRole('button', { name: '取消上传', exact: true }).click();
  await expect(video).not.toBeVisible();
  await expect.poll(() => page.workers().length).toBe(0);
});

test('intercepts native close and presents the application confirmation', async () => {
  await page.evaluate(() =>
    (window as unknown as { desktop: DesktopApi }).desktop.setCloseGuard(true),
  );
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
  await expect(page.getByRole('dialog', { name: '还有素材正在上传' })).toBeVisible();
  await page.getByRole('button', { name: '继续上传' }).click();
  expect(app.windows()).toHaveLength(1);
  await page.evaluate(() => (window as unknown as { desktop: DesktopApi }).desktop.clearSession());
  await page.evaluate(() =>
    (window as unknown as { desktop: DesktopApi }).desktop.setCloseGuard(false),
  );
});
