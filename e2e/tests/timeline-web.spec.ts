import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { videoFixture } from '../../apps/chat-editing-video-server/test/support/video.js';

const token = 'a'.repeat(43);
const projectId = '00000000-0000-4000-8000-000000000201';
const source = '00000000-0000-4000-8000-000000000202';
let video: Buffer;
test.beforeAll(async () => {
  video = await readFile(
    await videoFixture(path.resolve('test-results', 'timeline.mp4'), [], 30, 10),
  );
});

async function openTimeline(page: Page, long = false) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const project = {
    id: projectId,
    name: '时间轴定位',
    description: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
  await page.addInitScript((value) => sessionStorage.setItem('cev-session', value), token);
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const endpoint = new URL(req.url()).pathname.slice(4);
    if (endpoint === '/auth/me')
      return route.fulfill({
        json: {
          user: { id: source, phone: '13800138000' },
          expiresAt: '2099-01-01T00:00:00.000Z',
        },
      });
    if (endpoint.endsWith('/events'))
      return route.fulfill({
        contentType: 'text/event-stream',
        body: 'data: {"type":"ready"}\n\n',
      });
    if (endpoint === `/projects/${projectId}`) return route.fulfill({ json: project });
    if (endpoint === `/projects/${projectId}/editor-state`)
      return route.fulfill({
        json: {
          project,
          timeline: {
            revision: 1,
            fps: 30,
            canvas: { width: 320, height: 180 },
            clips: Array.from({ length: long ? 10 : 2 }, (_, i) => ({
              id: `00000000-0000-4000-8000-${String(i + 300).padStart(12, '0')}`,
              source,
              generation: 1,
              startFrame: long ? 0 : i * 150,
              endFrame: long ? 299 : i * 150 + 149,
            })),
          },
          turns: [],
          nextCursor: null,
        },
      });
    if (endpoint.endsWith('/media')) return route.fulfill({ json: [] });
    if (endpoint === '/media/policy')
      return route.fulfill({ json: { maxBatch: 3, maxAssets: 10, maxBytes: 1024 ** 3, fps: 30 } });
    if (endpoint === `/media/${source}/content`) {
      expect(req.headers()['authorization']).toBe(`Bearer ${token}`);
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
  await page.goto(`/tasks/${projectId}/edit`);
  await expect(page.getByRole('region', { name: '主视频预览' }).locator('canvas')).toBeVisible();
  const timeline = page.getByRole('region', { name: '主视频时间轴' });
  await timeline.scrollIntoViewIfNeeded();
  const slider = timeline.getByRole('slider', { name: '时间轴播放位置' });
  await expect(slider).toHaveAttribute('aria-valuenow', '0');
  const progress = page.getByRole('slider', { name: '播放进度', exact: true });
  return { timeline, slider, progress, track: slider.locator('..'), errors };
}

test('clicks exact timeline positions, plays across clips and drags the playhead without restarting clips', async ({
  page,
}) => {
  const { timeline, slider, progress, track, errors } = await openTimeline(page);
  let box = (await track.boundingBox())!;
  const x = (frame: number) => box.x + (frame / 300) * box.width;
  let y = box.y + 50;
  // A point inside Clip2 must select frame 210, not its beginning (frame 150).
  await page.mouse.move(x(210), y);
  await page.mouse.down();
  await expect(progress).toHaveValue('210');
  await expect(slider).toHaveAttribute('aria-valuenow', '210');
  await page.mouse.up();
  await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeVisible();
  await expect.poll(async () => Number(await progress.inputValue())).toBeGreaterThanOrEqual(210);
  await page.getByRole('button', { name: '暂停', exact: true }).click();

  // The ruler also seeks, and playback continues across the old clip boundary.
  await timeline.scrollIntoViewIfNeeded();
  box = (await track.boundingBox())!;
  await page.mouse.move(x(140), box.y + 12);
  await page.mouse.down();
  await expect(progress).toHaveValue('140');
  await page.mouse.up();
  await expect.poll(async () => Number(await progress.inputValue())).toBeGreaterThan(170);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await timeline.scrollIntoViewIfNeeded();
  box = (await track.boundingBox())!;
  y = box.y + 50;
  const line = (await slider.boundingBox())!;
  await page.mouse.move(line.x + line.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(x(75), y, { steps: 8 });
  await expect(progress).toHaveValue('75');
  await expect(slider).toHaveAttribute('aria-valuenow', '75');
  await page.mouse.up();
  await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeVisible();
  await expect.poll(async () => Number(await progress.inputValue())).toBeGreaterThanOrEqual(75);
  await page.getByRole('button', { name: '暂停', exact: true }).click();

  // Delete controls must not seek or start playback.
  const beforeDelete = await progress.inputValue();
  await timeline.getByRole('button', { name: '删除Clip1', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '删除Clip1？' })).toBeVisible();
  await expect(progress).toHaveValue(beforeDelete);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('button', { name: '播放全部', exact: true })).toBeVisible();

  await slider.focus();
  await slider.press('End');
  await expect(progress).toHaveValue('299');
  await slider.press('Home');
  await expect(progress).toHaveValue('0');
  await page.screenshot({ path: test.info().outputPath('timeline-seeking.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('seeks on a horizontally scrolled timeline and follows a playhead dragged to the edge', async ({
  page,
}) => {
  const { timeline, slider, progress, track, errors } = await openTimeline(page, true);
  const scroll = timeline.getByLabel('时间轴轨道');
  await scroll.evaluate((el) => {
    el.scrollLeft = 600;
  });
  await expect(progress).toHaveValue('450');
  const bounds = (await scroll.boundingBox())!;
  const trackBounds = (await track.boundingBox())!;
  const targetX = bounds.x + 300;
  const selected = Math.round(((targetX - trackBounds.x) / trackBounds.width) * 3000);
  await page.mouse.move(targetX, bounds.y + 50);
  await page.mouse.down();
  await expect(progress).toHaveValue(String(selected));
  await page.mouse.up();
  await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '暂停', exact: true }).click();

  await scroll.evaluate((el) => {
    el.scrollLeft = 0;
  });
  await slider.focus();
  await slider.press('Home');
  await expect(progress).toHaveValue('0');
  await timeline.scrollIntoViewIfNeeded();
  const resetBounds = (await scroll.boundingBox())!;
  await page.mouse.move(resetBounds.x + 2, resetBounds.y + 50);
  await page.mouse.down();
  await page.mouse.move(resetBounds.x + resetBounds.width - 3, resetBounds.y + 50, { steps: 10 });
  await expect.poll(() => scroll.evaluate((el) => el.scrollLeft)).toBeGreaterThan(100);
  await expect
    .poll(async () => Number(await progress.inputValue()))
    .toBeGreaterThan(Math.ceil((bounds.width * 30) / 40));
  await page.mouse.up();
  await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  expect(errors).toEqual([]);
});
