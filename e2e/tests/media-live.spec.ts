import { randomInt } from 'node:crypto';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { videoFixture } from '../../apps/chat-editing-video-server/test/support/video.js';

/** Explicit opt-in; needs the local API, PostgreSQL, Redis and FFmpeg. */
test('real login, upload, normalization, frame inspection, reload and deletion', async ({
  page,
  context,
}) => {
  test.setTimeout(60_000);
  const file = await videoFixture(
    path.resolve('test-results', `live-${randomInt(100000, 999999)}.mov`),
  );
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/login');
  await page.getByLabel('大陆手机号').fill(`198${randomInt(10000000, 99999999)}`);
  await page.getByRole('button', { name: '获取验证码' }).click();
  await expect(page.getByText('验证码获取成功')).toBeVisible();
  await page.getByLabel('验证码', { exact: true }).fill('123456');
  await page.getByRole('button', { name: '登录 / 注册' }).click();
  await page.getByRole('link', { name: '＋ 新建' }).click();
  await page.getByLabel('选择视频素材').setInputFiles(file);
  await expect(page).toHaveURL(/\/tasks\/[^/]+\/edit$/, { timeout: 20_000 });
  await expect(page.getByRole('button', { name: 'V1 第 1 秒' })).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'V1 第 1 秒' }).scrollIntoViewIfNeeded();
  await expect(page.getByTestId('local-thumbnail').first()).toHaveAttribute('data-loaded', 'true');
  await page.reload();
  await page.getByRole('button', { name: 'V1 第 1 秒' }).scrollIntoViewIfNeeded();
  await expect(page.getByTestId('sprite-cell').first()).toHaveCSS('background-image', /blob:/);
  const spriteSize = await page
    .getByTestId('sprite-cell')
    .first()
    .evaluate(async (element) => {
      const image = new Image();
      image.src = getComputedStyle(element).backgroundImage.slice(5, -2);
      await image.decode();
      return [image.naturalWidth, image.naturalHeight];
    });
  expect(spriteSize).toEqual([1600, 270]);
  await page.getByRole('button', { name: 'V1 第 1 秒' }).click();
  await expect(page.getByRole('button', { name: '放大第 5 帧', exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole('button', { name: '放大第 5 帧', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('img')).toBeVisible();
  await page.getByRole('button', { name: '复制时间' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('00:01:05');
  await page.screenshot({ path: test.info().outputPath('live-frame.png'), fullPage: true });
  await page.getByRole('button', { name: '关闭弹窗' }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: 'V1 第 1 秒' })).toBeVisible();
  await page.setViewportSize({ width: 960, height: 600 });
  await page.getByRole('button', { name: 'V1 第 1 秒' }).scrollIntoViewIfNeeded();
  await expect(page.getByTestId('sprite-cell').first()).toHaveCSS('background-image', /blob:/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('live-editor.png'), fullPage: true });
  await page.getByRole('link', { name: '‹ 返回任务列表' }).click();
  await expect(page.getByText('素材已就绪')).toBeVisible();
  await page.getByRole('button', { name: '删除', exact: true }).click();
  await page.getByRole('button', { name: '确认删除' }).click();
  await expect(page.getByText('还没有剪辑任务')).toBeVisible();
  await page.getByRole('button', { name: '退出登录' }).click();
});

test('measures long original video preview and ready latency', async ({ page }) => {
  const file = process.env.CEV_BENCHMARK_VIDEO;
  test.skip(!file, 'Set CEV_BENCHMARK_VIDEO to a local, supported long CFR 30 video');
  test.setTimeout(120000);
  type Timings = {
    selected?: number;
    thumbnail?: number;
    uploaded?: number;
    ready?: number;
    seekStart?: number;
    seekEnd?: number;
  };
  await page.addInitScript(() => {
    const timings: Timings = {};
    (window as unknown as { mediaBenchmark: Timings }).mediaBenchmark = timings;
    document.addEventListener(
      'change',
      (event) => {
        if (event.target instanceof HTMLInputElement && event.target.type === 'file')
          timings.selected = performance.now();
      },
      true,
    );
    const send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (body) {
      this.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable && event.loaded === event.total)
          timings.uploaded = performance.now();
      });
      return send.call(this, body);
    };
    new MutationObserver(() => {
      if (
        !timings.thumbnail &&
        document.querySelector('[data-testid="local-thumbnail"][data-loaded="true"]')
      )
        timings.thumbnail = performance.now();
      if (
        !timings.ready &&
        document.querySelector('[data-testid="asset-row"][data-media-status="ready"]')
      )
        timings.ready = performance.now();
    }).observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-loaded', 'data-media-status'],
    });
  });
  await page.goto('/login');
  await page.getByLabel('大陆手机号').fill(`196${randomInt(10000000, 99999999)}`);
  await page.getByRole('button', { name: '获取验证码' }).click();
  await page.getByLabel('验证码', { exact: true }).fill('123456');
  await page.getByRole('button', { name: '登录 / 注册' }).click();
  await page.getByRole('link', { name: '＋ 新建' }).click();
  let projectId: string | undefined;
  const token = (await page.evaluate(() => sessionStorage.getItem('cev-session')))!;
  try {
    await page.getByLabel('选择视频素材').setInputFiles(file!);
    await page.getByTestId('local-thumbnail').first().scrollIntoViewIfNeeded();
    await expect(page.getByTestId('local-thumbnail').first()).toHaveAttribute(
      'data-loaded',
      'true',
    );
    await expect(page).toHaveURL(/\/tasks\/[^/]+\/edit$/, { timeout: 60000 });
    projectId = new URL(page.url()).pathname.split('/')[2]!;
    await expect(page.getByTestId('asset-row')).toHaveAttribute('data-media-status', 'ready', {
      timeout: 10000,
    });
    await expect(page.getByTestId('asset-row')).toHaveAttribute('data-source-kind', 'original');
    await page.getByRole('button', { name: '播放素材 V1' }).click();
    const video = page.getByRole('region', { name: 'V1 素材预览' }).locator('video');
    await expect
      .poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState))
      .toBeGreaterThanOrEqual(2);
    await page.getByRole('button', { name: '暂停素材预览', exact: true }).click();
    await page.evaluate(() => {
      const timings = (window as unknown as { mediaBenchmark: Timings }).mediaBenchmark;
      timings.seekStart = performance.now();
      const video = document.querySelector('video')!;
      video.addEventListener(
        'seeked',
        () => {
          timings.seekEnd = performance.now();
        },
        { once: true },
      );
      document.querySelector<HTMLElement>('[aria-label="V1 逐秒缩略图"]')!.scrollLeft = 600 * 160;
    });
    await expect
      .poll(() =>
        video.evaluate(
          (v: HTMLVideoElement) => !v.seeking && Math.abs(v.currentTime - 600) < 1 / 30,
        ),
      )
      .toBe(true);
    const timings = await page.evaluate(
      () => (window as unknown as { mediaBenchmark: Timings }).mediaBenchmark,
    );
    const metrics = {
      firstThumbnailMs: timings.thumbnail! - timings.selected!,
      uploadedToReadyMs: timings.ready! - timings.uploaded!,
      seekToTenMinutesMs: timings.seekEnd! - timings.seekStart!,
    };
    await test.info().attach('long-video-performance', {
      body: JSON.stringify(metrics, null, 2),
      contentType: 'application/json',
    });
    console.log('Long-video performance', metrics);
    expect(metrics.firstThumbnailMs).toBeLessThan(1000);
    expect(metrics.uploadedToReadyMs).toBeLessThan(3000);
    expect(metrics.seekToTenMinutesMs).toBeLessThan(1000);
    await page.screenshot({ path: test.info().outputPath('long-video-local-preview.png') });
  } finally {
    projectId ??= /\/tasks\/([^/]+)\/edit/.exec(page.url())?.[1];
    if (projectId)
      await page.request.delete(`/api/projects/${projectId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    await page.request.post('/api/auth/logout', { headers: { Authorization: `Bearer ${token}` } });
  }
});
