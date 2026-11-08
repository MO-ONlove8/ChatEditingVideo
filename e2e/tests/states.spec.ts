import { expect, test } from '@playwright/test';

test('development preview opens frame dialog, copies time and restores focus', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.setViewportSize({ width: 1600, height: 1080 });
  await page.goto('/dev/ui-states');
  await expect(page.getByRole('heading', { name: '确认、放大与异常提示' })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('states-overview.png'), fullPage: true });
  const trigger = page.getByRole('button', { name: '放大查看' });
  await trigger.click();
  const frameDialog = page.getByRole('dialog', { name: '帧图放大 · V1' });
  await expect(frameDialog).toBeVisible();
  const bounds = await frameDialog.boundingBox();
  expect(bounds).not.toBeNull();
  expect(Math.abs(bounds!.x + bounds!.width / 2 - 800)).toBeLessThanOrEqual(1);
  expect(Math.abs(bounds!.y + bounds!.height / 2 - 540)).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: '复制时间' }).click();
  await expect(page.getByRole('status')).toContainText('时间已复制');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('00:05:12');
  await page.screenshot({ path: test.info().outputPath('frame-dialog.png') });
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
});

test('failed save can retry once without losing the pending card', async ({ page }) => {
  await page.goto('/dev/ui-states');
  await page.getByLabel('模拟请求失败').check();
  await page.getByRole('button', { name: '重试保存' }).click();
  await expect(page.getByRole('alert')).toContainText('演示请求失败');
  await expect(page.getByText('时间轴保持上次保存结果，重试只执行一次')).toBeVisible();
  await page.getByLabel('模拟请求失败').uncheck();
  await page.getByRole('button', { name: '重试保存' }).click();
  await expect(page.getByRole('button', { name: '已保存', exact: true })).toBeDisabled();
});

test('upload leave protection supports staying, browser close and cancellation', async ({
  page,
}) => {
  await page.goto('/dev/ui-states');
  await page.getByRole('button', { name: '模拟上传中' }).click();
  await page.getByRole('link', { name: '尝试离开' }).click();
  await expect(page.getByRole('dialog', { name: '还有素材正在上传' })).toBeVisible();
  await page.getByRole('button', { name: '继续上传' }).click();
  await expect(page).toHaveURL(/\/dev\/ui-states$/);
  const nativeDialog = page.waitForEvent('dialog');
  await page.close({ runBeforeUnload: true });
  const dialog = await nativeDialog;
  expect(dialog.type()).toBe('beforeunload');
  await dialog.dismiss();
  expect(page.isClosed()).toBe(false);
  await expect(page.getByRole('button', { name: '结束演示上传' })).toBeVisible();
  await page.getByRole('link', { name: '尝试离开' }).click();
  await page.getByRole('button', { name: '取消上传并离开' }).click();
  await expect(page).toHaveURL(/\/login$/);
});
