import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type Route } from '@playwright/test';
import { videoFixture } from '../../apps/chat-editing-video-server/test/support/video.js';

const token = 'a'.repeat(43);
const projectId = '00000000-0000-4000-8000-000000000101';
const project = {
  id: projectId,
  name: '上传后的任务',
  description: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};
const session = {
  user: { id: '00000000-0000-4000-8000-000000000102', phone: '13800138000' },
  expiresAt: '2099-01-01T00:00:00.000Z',
};
const pixel = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1sAAAAASUVORK5CYII=',
  'base64',
);
let file: string;
test.beforeAll(async () => {
  file = await videoFixture(path.resolve('test-results', 'numbered.mp4'));
});

async function install(page: Page, failImages = false) {
  const uploads = new Map<
    string,
    {
      id: string;
      contextId: string;
      fileName: string;
      sizeBytes: number;
      status: string;
      error: null;
      asset: object | null;
    }
  >();
  const pending: Route[] = [];
  const assets: object[] = [];
  let deletions = 0;
  let smallAttempts = 0;
  let fullAttempts = 0;
  await page.addInitScript((value) => sessionStorage.setItem('cev-session', value), token);
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const endpoint = url.pathname.slice(4);
    if (endpoint === '/auth/me') return route.fulfill({ json: session });
    if (endpoint === '/auth/events' || endpoint.endsWith('/media/events'))
      return route.fulfill({
        contentType: 'text/event-stream',
        body: 'data: {"type":"ready"}\n\n',
      });
    if (endpoint === '/media/policy')
      return route.fulfill({
        json: { maxBatch: 3, maxAssets: 10, maxBytes: 1024 ** 3, fps: 30 },
      });
    if (endpoint === '/projects') return route.fulfill({ json: assets.length ? [project] : [] });
    if (endpoint === `/projects/${projectId}`) return route.fulfill({ json: project });
    if (endpoint === `/projects/${projectId}/media`) return route.fulfill({ json: assets });
    if (endpoint === '/uploads') {
      const input = req.postDataJSON();
      const result = input.files.map((f: { id: string; fileName: string; sizeBytes: number }) => {
        const item = {
          ...f,
          contextId: input.contextId,
          status: 'pending',
          error: null,
          asset: null,
        };
        uploads.set(f.id, item);
        return { ...item, projectId: null };
      });
      return route.fulfill({ status: 201, json: result });
    }
    const upload = /^\/uploads\/([^/]+)(\/content)?$/.exec(endpoint);
    if (upload) {
      const item = uploads.get(upload[1]!)!;
      if (upload[2]) {
        item.status = 'uploading';
        pending.push(route);
        return;
      }
      if (req.method() === 'DELETE') {
        deletions++;
        if (item.status !== 'saved') item.status = 'cancelled';
      }
      return route.fulfill({ json: { ...item, projectId: assets.length ? projectId : null } });
    }
    if (endpoint.endsWith('/thumbnails'))
      return route.fulfill({
        json: {
          status: 'ready',
          generation: 1,
          images: [
            { frame: 0, path: '/test-image' },
            { frame: 30, path: '/test-image' },
          ],
          sprite: { path: '/test-image', width: 160, height: 90, columns: 10 },
        },
      });
    if (endpoint.endsWith('/frames'))
      return route.fulfill({
        json: {
          status: 'ready',
          generation: 1,
          images: Array.from(
            { length: url.searchParams.get('second') === '1' ? 6 : 30 },
            (_, i) => ({
              frame: Number(url.searchParams.get('second')) * 30 + i,
              path: `/test-frame-${i}`,
            }),
          ),
        },
      });
    if (
      failImages &&
      ((endpoint === '/test-frame-0' && smallAttempts++ === 0) ||
        (endpoint.endsWith('/image') && fullAttempts++ === 0))
    )
      return route.fulfill({ status: 503, json: { message: '图片暂不可用，请重试' } });
    if (
      endpoint === '/test-image' ||
      endpoint.startsWith('/test-frame-') ||
      endpoint.endsWith('/image')
    )
      return route.fulfill({ contentType: 'image/png', body: pixel });
    if (/^\/media\/[^/]+\/content$/.test(endpoint)) {
      expect(req.headers()['authorization']).toBe(`Bearer ${token}`);
      const video = await readFile(file);
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers()['range'] ?? '');
      const start = range ? Number(range[1]) : 0;
      const end = range?.[2] ? Math.min(Number(range[2]), video.length - 1) : video.length - 1;
      return route.fulfill({
        status: range ? 206 : 200,
        contentType: 'video/mp4',
        headers: {
          'accept-ranges': 'bytes',
          ...(range ? { 'content-range': `bytes ${start}-${end}/${video.length}` } : {}),
        },
        body: video.subarray(start, end + 1),
      });
    }
    return route.fulfill({ status: 404, json: { message: 'Not found' } });
  });
  return {
    pending,
    deletions: () => deletions,
    async save(index: number) {
      const route = pending[index]!;
      const id = /uploads\/([^/]+)/.exec(route.request().url())![1]!;
      const item = uploads.get(id)!;
      const asset = {
        id,
        projectId,
        fileName: item.fileName,
        sizeBytes: item.sizeBytes,
        mimeType: 'video/mp4',
        storageKey: 'test.mp4',
        number: assets.length + 1,
        status: 'ready',
        stage: '处理完成',
        progress: 100,
        error: null,
        generation: 1,
        original: null,
        normalized: {
          duration: 1.2,
          frameCount: 36,
          width: 320,
          height: 180,
          hasAudio: true,
          rotation: 0,
          hdr: false,
        },
        createdAt: new Date().toISOString(),
      };
      assets.push(asset);
      item.asset = asset;
      item.status = 'saved';
      await route.fulfill({ json: { ...item, projectId } });
    },
  };
}

test('uploads actual files, transitions to saved editor during a batch, and opens the last real frame', async ({
  page,
  context,
}) => {
  const api = await install(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/tasks/new');
  await page.getByLabel('选择视频素材').setInputFiles([file, file]);
  await expect.poll(() => api.pending.length).toBe(2);
  await api.save(0);
  await expect(page).toHaveURL(new RegExp(`/tasks/${projectId}/edit$`));
  await expect(page.getByRole('dialog', { name: '还有素材正在上传' })).not.toBeVisible();
  await page.getByRole('link', { name: '‹ 返回任务列表' }).click();
  await expect(page.getByRole('dialog', { name: '还有素材正在上传' })).toBeVisible();
  await page.getByRole('button', { name: '继续上传' }).click();
  await api.save(1);
  await page.getByRole('button', { name: 'V1 第 1 秒' }).click();
  await expect(page.getByText('第 1 秒 · 帧编号 0～5')).toBeVisible();
  await expect(page.getByRole('button', { name: '放大第', exact: false })).toHaveCount(6);
  await page.getByRole('button', { name: '放大第 5 帧', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('00:01:05');
  await page.getByRole('button', { name: '复制时间' }).click();
  await expect(page.getByText('时间已复制')).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('00:01:05');
  await page.getByRole('button', { name: '关闭弹窗' }).click();
  await page.setViewportSize({ width: 960, height: 600 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('media-minimum.png'), fullPage: true });
});

test('drags source thumbnails under a fixed center playhead, pauses on release and preserves frame inspection', async ({
  page,
}) => {
  const api = await install(page);
  await page.goto('/tasks/new');
  await page.getByLabel('选择视频素材').setInputFiles(file);
  await expect.poll(() => api.pending.length).toBe(1);
  await api.save(0);
  const slider = page.getByRole('slider', { name: 'V1 素材播放位置' });
  const strip = page.getByLabel('V1 逐秒缩略图');
  await slider.scrollIntoViewIfNeeded();
  const bounds = (await strip.boundingBox())!;
  const center = bounds.x + bounds.width / 2;
  const playheadCenter = async () => {
    const box = (await slider.boundingBox())!;
    return box.x + box.width / 2;
  };
  expect(await playheadCenter()).toBeCloseTo(center, 0);
  const firstThumbnail = page.getByRole('button', { name: 'V1 第 0 秒', exact: true });
  expect((await firstThumbnail.boundingBox())!.x).toBeCloseTo(center, 0);
  await page.mouse.move(center + 100, bounds.y + 40);
  await page.mouse.down();
  await page.mouse.move(center + 20, bounds.y + 40, { steps: 8 });
  await page.mouse.up();
  await expect(slider).toHaveAttribute('aria-valuenow', '15');
  expect(await playheadCenter()).toBeCloseTo(center, 0);
  expect((await firstThumbnail.boundingBox())!.x).toBeCloseTo(center - 80, 0);
  const preview = page.getByRole('region', { name: 'V1 素材预览' });
  await expect(preview).toBeVisible();
  await expect(preview.locator('canvas')).toBeVisible();
  await expect(preview.getByRole('button', { name: '播放素材预览' })).toBeVisible();
  await expect(page.getByText('第 0 秒 · 帧编号')).not.toBeVisible();
  const popup = (await preview.boundingBox())!;
  expect(popup.width).toBeGreaterThanOrEqual(340);
  expect(popup.y + popup.height).toBeLessThanOrEqual(bounds.y - 8);
  expect(popup.x + popup.width / 2).toBeCloseTo(center, 0);
  await page.waitForTimeout(150);
  await expect(slider).toHaveAttribute('aria-valuenow', '15');
  await page.getByRole('button', { name: '播放素材预览' }).click();
  await expect.poll(() => slider.getAttribute('aria-valuenow')).not.toBe('15');
  expect(await playheadCenter()).toBeCloseTo(center, 0);
  // Dragging during playback pauses and can reach either boundary without moving the line.
  await page.mouse.move(center + 100, bounds.y + 40);
  await page.mouse.down();
  await page.mouse.move(center - 200, bounds.y + 40, { steps: 8 });
  await page.mouse.up();
  await expect(slider).toHaveAttribute('aria-valuenow', '35');
  await expect(preview.getByRole('button', { name: '播放素材预览' })).toBeVisible();
  const lastThumbnail = page.getByRole('button', { name: 'V1 第 1 秒', exact: true });
  const lastBox = (await lastThumbnail.boundingBox())!;
  expect(lastBox.x + lastBox.width).toBeLessThan(bounds.x + bounds.width - 100);
  await page.mouse.move(center - 200, bounds.y + 40);
  await page.mouse.down();
  await page.mouse.move(center + 100, bounds.y + 40, { steps: 8 });
  await page.mouse.up();
  await expect(slider).toHaveAttribute('aria-valuenow', '0');
  expect(await playheadCenter()).toBeCloseTo(center, 0);
  expect((await firstThumbnail.boundingBox())!.x).toBeCloseTo(center, 0);
  await page.getByRole('button', { name: '关闭素材预览' }).click();
  await expect(preview).not.toBeVisible();
  await slider.focus();
  await slider.press('End');
  await expect(slider).toHaveAttribute('aria-valuenow', '35');
  await expect(preview).toContainText('00:01:05');
  expect(await playheadCenter()).toBeCloseTo(center, 0);
  await page.keyboard.press('Escape');
  await expect(preview).not.toBeVisible();
  await page.getByRole('button', { name: 'V1 第 1 秒' }).click();
  await expect(page.getByText('第 1 秒 · 帧编号 0～5')).toBeVisible();
  await page.getByRole('button', { name: '放大第 5 帧', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('00:01:05');
});

test('retries failed source playback and closes the previous source preview', async ({ page }) => {
  const api = await install(page);
  let fail = true;
  await page.route('**/api/media/*/content**', (route) =>
    fail
      ? route.fulfill({ status: 503, json: { message: 'Preview unavailable' } })
      : route.fallback(),
  );
  await page.goto('/tasks/new');
  await page.getByLabel('选择视频素材').setInputFiles([file, file]);
  await expect.poll(() => api.pending.length).toBe(2);
  await api.save(0);
  await api.save(1);
  await page.getByRole('button', { name: '播放素材 V1' }).click();
  const first = page.getByRole('region', { name: 'V1 素材预览' });
  await expect(first.getByRole('button', { name: '重试预览' })).toBeVisible();
  fail = false;
  await first.getByRole('button', { name: '重试预览' }).click();
  await expect(first.locator('canvas')).toBeVisible();
  await expect(first.getByRole('alert')).not.toBeVisible();
  await page.getByRole('button', { name: '播放素材 V2' }).click();
  await expect(first).not.toBeVisible();
  const second = page.getByRole('region', { name: 'V2 素材预览' });
  await expect(second.locator('canvas')).toBeVisible();
  await second.getByRole('button', { name: '关闭素材预览' }).click();
  await expect(second).not.toBeVisible();
});

test('cancel and leave aborts pending transfers without creating an empty task', async ({
  page,
}) => {
  const api = await install(page);
  await page.goto('/tasks/new');
  await page.getByLabel('选择视频素材').setInputFiles(file);
  await expect.poll(() => api.pending.length).toBe(1);
  await page.getByRole('link', { name: '‹ 返回任务列表' }).click();
  await page.getByRole('button', { name: '取消上传并离开' }).click();
  await expect(page).toHaveURL(/\/tasks$/);
  await expect.poll(api.deletions).toBe(1);
  await expect(page.getByText('还没有剪辑任务')).toBeVisible();
});

test('rejects an invalid file before reserving or uploading', async ({ page }) => {
  const api = await install(page);
  await page.goto('/tasks/new');
  await page
    .getByLabel('选择视频素材')
    .setInputFiles({ name: 'broken.mp4', mimeType: 'video/mp4', buffer: Buffer.from('invalid') });
  await expect(page.getByRole('alert')).toContainText('broken.mp4');
  expect(api.pending).toHaveLength(0);
  const valid = await readFile(file);
  expect(valid.length).toBeGreaterThan(1000);
});

test('retries a failed small frame by keyboard and a failed full frame in the dialog', async ({
  page,
}) => {
  const api = await install(page, true);
  await page.goto('/tasks/new');
  await page.getByLabel('选择视频素材').setInputFiles(file);
  await expect.poll(() => api.pending.length).toBe(1);
  await api.save(0);
  await page.getByRole('button', { name: 'V1 第 0 秒' }).click();
  await page.getByRole('button', { name: '重试第 0 帧图片', exact: true }).press('Enter');
  await expect(page.getByRole('img', { name: '第 0 帧', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '放大第 0 帧', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('图片暂不可用');
  await page.getByRole('button', { name: '重试图片', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('img')).toBeVisible();
});
