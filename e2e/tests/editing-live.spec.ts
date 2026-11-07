import { randomInt } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, readdir, stat } from 'node:fs/promises';
import {
  _electron as electron,
  expect,
  test,
  request as apiRequest,
  type APIRequestContext,
} from '@playwright/test';
import { videoFixture } from '../../apps/chat-editing-video-server/test/support/video.js';
import type { DesktopApi } from '../../packages/shared/src/ipc.js';

test.describe.configure({ mode: 'serial' });
const here = path.dirname(fileURLToPath(import.meta.url)),
  desktopDir = path.resolve(here, '../../apps/chat-editing-video-desktop');
let token = '',
  projectId = '',
  api: APIRequestContext;
test.beforeAll(async () => {
  api = await apiRequest.newContext({ baseURL: 'http://127.0.0.1:3000/api/' });
});
test.afterAll(async () => {
  if (projectId)
    await api.delete(`projects/${projectId}`, { headers: { Authorization: `Bearer ${token}` } });
  if (token) await api.post('auth/logout', { headers: { Authorization: `Bearer ${token}` } });
  await api.dispose();
});

test('real model, saved confirmation, authenticated Remotion preview and browser MP4 download', async ({
  page,
}) => {
  test.setTimeout(180000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const file = await videoFixture(
    path.resolve('test-results', `editing-live-${randomInt(100000, 999999)}.mp4`),
    [],
    30,
    10,
  );
  await page.goto('/login');
  await page.getByLabel('大陆手机号').fill(`197${randomInt(10000000, 99999999)}`);
  await page.getByRole('button', { name: '获取验证码' }).click();
  await page.getByLabel('验证码', { exact: true }).fill('123456');
  await page.getByRole('button', { name: '登录 / 注册' }).click();
  await expect(page.getByRole('heading', { name: '我的剪辑任务' })).toBeVisible();
  token = (await page.evaluate(() => sessionStorage.getItem('cev-session')))!;
  await page.getByRole('link', { name: '＋ 新建' }).click();
  await page.getByLabel('选择视频素材').setInputFiles(file);
  await expect(page).toHaveURL(/\/tasks\/[^/]+\/edit$/, { timeout: 20000 });
  projectId = new URL(page.url()).pathname.split('/')[2]!;
  await expect(page.getByRole('button', { name: 'V1 第 1 秒' })).toBeVisible({ timeout: 20000 });
  const sourceSlider = page.getByRole('slider', { name: 'V1 素材播放位置' });
  await sourceSlider.scrollIntoViewIfNeeded();
  await sourceSlider.focus();
  await sourceSlider.press('End');
  await expect(sourceSlider).toHaveAttribute('aria-valuenow', '299');
  await expect(sourceSlider).toBeInViewport();
  const sourcePreview = page.getByRole('region', { name: 'V1 素材预览' });
  await expect(sourcePreview.locator('canvas')).toBeVisible({ timeout: 15000 });
  const canvasPixel = () =>
    sourcePreview.locator('canvas').evaluate((canvas) => {
      const ctx = (canvas as HTMLCanvasElement).getContext('2d')!;
      const data = ctx.getImageData(
        0,
        0,
        (canvas as HTMLCanvasElement).width,
        (canvas as HTMLCanvasElement).height,
      ).data;
      let hash = 0;
      for (let i = 0; i < data.length; i++)
        if (i % 4 !== 3) hash = (Math.imul(hash, 31) + data[i]!) | 0;
      return hash;
    });
  await expect.poll(canvasPixel).not.toBe(0);
  const lastPixel = await canvasPixel();
  await sourceSlider.press('Home');
  await expect(sourceSlider).toHaveAttribute('aria-valuenow', '0');
  await expect(sourceSlider).toBeInViewport();
  await expect.poll(canvasPixel).not.toEqual(lastPixel);
  const sourceStrip = page.getByLabel('V1 逐秒缩略图');
  const stripBounds = (await sourceStrip.boundingBox())!;
  const sourceCenter = stripBounds.x + stripBounds.width / 2;
  await page.mouse.move(stripBounds.x + stripBounds.width - 20, stripBounds.y + 35);
  await page.mouse.down();
  await page.mouse.move(stripBounds.x + 20, stripBounds.y + 35, { steps: 12 });
  await expect.poll(() => sourceStrip.evaluate((el) => el.scrollLeft)).toBeGreaterThan(100);
  await page.mouse.up();
  const lineBounds = (await sourceSlider.boundingBox())!;
  expect(lineBounds.x + lineBounds.width / 2).toBeCloseTo(sourceCenter, 0);
  const selectedFrame = await sourceSlider.getAttribute('aria-valuenow');
  await expect(sourcePreview.getByRole('button', { name: '播放素材预览' })).toBeVisible();
  await page.waitForTimeout(150);
  await expect(sourceSlider).toHaveAttribute('aria-valuenow', selectedFrame!);
  await page.screenshot({ path: test.info().outputPath('source-preview.png'), fullPage: true });
  await sourcePreview.getByRole('button', { name: '关闭素材预览' }).click();
  await page.getByLabel('输入剪辑指令').fill('把V1的第5秒到第8秒追加到主视频末尾');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const card = page.getByLabel('剪辑确认卡');
  await expect(card).toBeVisible({ timeout: 120000 });
  await expect(card).toContainText('91 帧');
  await expect(card).toContainText('00:05:00 → 00:08:00');
  await page.reload();
  await expect(page.getByLabel('剪辑确认卡')).toContainText('待确认');
  await page.getByRole('button', { name: '播放选段预览' }).click();
  const dialog = page.getByRole('dialog', { name: '选段播放预览' });
  await expect(dialog.locator('canvas')).toBeVisible({ timeout: 20000 });
  await expect(dialog.getByText(/预览加载失败/)).toHaveCount(0);
  await dialog.getByRole('button', { name: '关闭弹窗' }).click();
  await page.getByRole('button', { name: '确认并保存' }).click();
  await expect(card).toContainText('已保存');
  await expect(page.getByRole('button', { name: '播放Clip1', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: '主视频预览' }).locator('canvas')).toBeVisible({
    timeout: 15000,
  });
  await expect
    .poll(
      () =>
        page
          .getByRole('region', { name: '主视频预览' })
          .locator('canvas')
          .evaluate((c) => {
            const canvas = c as HTMLCanvasElement;
            const data = canvas
              .getContext('2d')!
              .getImageData(0, 0, canvas.width, canvas.height).data;
            let bright = 0;
            for (let i = 0; i < data.length; i += 400)
              if (data[i]! > 40 || data[i + 1]! > 40 || data[i + 2]! > 40) bright++;
            return bright;
          }),
      { timeout: 15000 },
    )
    .toBeGreaterThan(20);
  await page.getByRole('button', { name: '播放全部', exact: true }).click();
  await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  const timelineHead = page.getByRole('slider', { name: '时间轴播放位置' });
  await timelineHead.scrollIntoViewIfNeeded();
  const timelineBox = (await timelineHead.locator('..').boundingBox())!;
  await page.mouse.move(timelineBox.x + (timelineBox.width * 45) / 91, timelineBox.y + 50);
  await page.mouse.down();
  await expect(page.getByRole('slider', { name: '播放进度', exact: true })).toHaveValue('45');
  await page.mouse.up();
  await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await page.screenshot({ path: test.info().outputPath('editing-workspace.png'), fullPage: true });
  await page.getByRole('button', { name: '下载成品', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存v1到本地' })).toBeVisible({ timeout: 30000 });
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: '保存v1到本地' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toContain('.mp4');
  expect(await download.failure()).toBeNull();
  await download.saveAs(test.info().outputPath('result.mp4'));
  await page.reload();
  await expect(page.getByRole('button', { name: '播放Clip1', exact: true })).toBeVisible();
  await page.getByRole('link', { name: '‹ 返回任务列表' }).click();
  await page.getByRole('link', { name: '查看', exact: true }).click();
  await expect(page.locator('canvas')).toBeVisible();
  await expect(page.getByLabel('播放倍速')).toBeEnabled();
  expect(errors).toEqual([]);
});

test('app protocol plays protected clips at 960x600 and streams a native save', async () => {
  test.setTimeout(60000);
  await mkdir(path.resolve('test-results'), { recursive: true });
  const profile = await mkdtemp(path.resolve('test-results', 'editing-electron-'));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    executablePath: createRequire(path.join(desktopDir, 'package.json'))('electron') as string,
    args: [desktopDir],
    cwd: desktopDir,
    env: {
      ...env,
      ELECTRON_RENDERER_URL: '',
      CEV_API_BASE_URL: 'http://127.0.0.1:3000/api',
      CEV_USER_DATA_DIR: profile,
    },
  });
  try {
    await app.context().tracing.start({ screenshots: true, snapshots: true });
    const page = await app.firstWindow();
    // Let the initial loadURL finish before reloading with the test session.
    await page.waitForLoadState('load');
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.evaluate(
      (t) => (window as unknown as { desktop: DesktopApi }).desktop.saveSession(t),
      token,
    );
    await page.reload();
    await expect(page.getByRole('heading', { name: '我的剪辑任务' })).toBeVisible();
    await page.getByRole('link', { name: '继续编辑', exact: true }).click();
    await expect(page).toHaveURL(`app://local/tasks/${projectId}/edit`);
    await expect(page.getByRole('region', { name: '主视频预览' }).locator('canvas')).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByText(/预览加载失败/)).toHaveCount(0);
    await page.getByRole('button', { name: '播放全部', exact: true }).click();
    await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(960, 600));
    const sourceSlider = page.getByRole('slider', { name: 'V1 素材播放位置' });
    await sourceSlider.scrollIntoViewIfNeeded();
    await sourceSlider.focus();
    await sourceSlider.press('ArrowRight');
    const sourcePreview = page.getByRole('region', { name: 'V1 素材预览' });
    await expect(sourcePreview.locator('canvas')).toBeVisible({ timeout: 15000 });
    const previewBounds = (await sourcePreview.boundingBox())!;
    expect(previewBounds.x).toBeGreaterThanOrEqual(0);
    expect(previewBounds.x + previewBounds.width).toBeLessThanOrEqual(960);
    await page.screenshot({
      path: test.info().outputPath('source-preview-desktop.png'),
      fullPage: true,
    });
    await sourcePreview.getByRole('button', { name: '关闭素材预览' }).click();
    const timelineHead = page.getByRole('slider', { name: '时间轴播放位置' });
    await timelineHead.scrollIntoViewIfNeeded();
    const timelineBox = (await timelineHead.locator('..').boundingBox())!;
    await page.mouse.move(timelineBox.x + (timelineBox.width * 30) / 91, timelineBox.y + 50);
    await page.mouse.down();
    await expect(page.getByRole('slider', { name: '播放进度', exact: true })).toHaveValue('30');
    await page.mouse.move(timelineBox.x + (timelineBox.width * 60) / 91, timelineBox.y + 50, {
      steps: 8,
    });
    await expect(page.getByRole('slider', { name: '播放进度', exact: true })).toHaveValue('60');
    await page.mouse.up();
    await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await expect(page.getByLabel('输入剪辑指令')).toBeInViewport();
    await page.screenshot({ path: test.info().outputPath('editing-desktop.png'), fullPage: true });
    const target = test.info().outputPath('desktop-result.mp4');
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, target);
    await page.getByRole('button', { name: '保存v1到本地' }).click();
    await expect(page.getByText('成品已保存到本地')).toBeVisible({ timeout: 15000 });
    const projectResponse = await api.get(`projects/${projectId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(projectResponse.ok()).toBe(true);
    const jobId = (await projectResponse.json()).latestJob.id as string;
    const cancelledTarget = test.info().outputPath('cancelled.mp4');
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
      const globals = globalThis as typeof globalThis & { cevOriginalFetch?: typeof fetch };
      globals.cevOriginalFetch = fetch;
      globals.fetch = (async (...args: Parameters<typeof fetch>) => {
        if (String(args[0]).includes('/content'))
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(1024));
              },
            }),
          );
        return globals.cevOriginalFetch!(...args);
      }) as typeof fetch;
    }, cancelledTarget);
    await page.getByRole('button', { name: '保存v1到本地' }).click();
    const parts = () =>
      readdir(path.dirname(cancelledTarget)).then((files) =>
        files.filter((f) => f.startsWith('cancelled.mp4.') && f.endsWith('.part')),
      );
    await expect.poll(async () => (await parts()).length).toBe(1);
    const duplicate = await page.evaluate(async (id) => {
      try {
        await (window as unknown as { desktop: DesktopApi }).desktop.downloadRender(id);
      } catch (error) {
        return (error as Error).message;
      }
      return '';
    }, jobId);
    expect(duplicate).toContain('该成品正在保存');
    await page.getByRole('button', { name: '取消保存' }).click();
    await expect(page.getByText('已取消保存')).toBeVisible();
    await expect.poll(async () => (await parts()).length).toBe(0);
    expect(
      await stat(cancelledTarget).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    await app.evaluate(() => {
      const globals = globalThis as typeof globalThis & { cevOriginalFetch?: typeof fetch };
      globals.fetch = globals.cevOriginalFetch!;
      delete globals.cevOriginalFetch;
    });
    expect(errors).toEqual([]);
  } finally {
    await app.context().tracing.stop({ path: test.info().outputPath('desktop-runtime.zip') });
    await app.close();
  }
});
