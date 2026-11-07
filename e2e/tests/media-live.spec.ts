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
