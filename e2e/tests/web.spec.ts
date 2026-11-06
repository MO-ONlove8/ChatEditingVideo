import { expect, test } from '@playwright/test';

const project = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'E2E 项目',
  description: null,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

/**
 * Runs the built web app (vite preview) with the API mocked at the network layer,
 * so it needs no server/DB. Full-stack coverage lives in the server integration tests.
 */
test.beforeEach(async ({ page }) => {
  await page.route('**/api/projects', (route) => route.fulfill({ json: [project] }));
  await page.route('**/api/chat/stream', (route) =>
    route.fulfill({
      contentType: 'text/event-stream',
      body:
        'data: {"type":"delta","content":"好的，"}\n\n' +
        'data: {"type":"delta","content":"已为你剪掉片头"}\n\n' +
        'data: {"type":"done"}\n\n',
    }),
  );
});

test('lists projects and navigates', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('E2E 项目')).toBeVisible();
  await expect(page.getByTestId('runtime')).toHaveText('浏览器');

  await page.getByRole('link', { name: '渲染任务' }).click();
  await expect(page).toHaveURL(/\/jobs$/);
  await expect(page.getByRole('radio', { name: /桌面端本地/ })).toBeDisabled();
});

test('streams a chat reply', async ({ page }) => {
  await page.goto('/chat');
  await page.getByLabel('输入剪辑需求').fill('剪掉片头');
  await page.getByRole('button', { name: '发送' }).click();
  await expect(page.getByText('好的，已为你剪掉片头')).toBeVisible();
});

test('deep links work (SPA fallback)', async ({ page }) => {
  await page.goto('/jobs');
  await expect(page.getByRole('heading', { name: '渲染任务' })).toBeVisible();
});
