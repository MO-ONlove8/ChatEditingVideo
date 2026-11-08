import { expect, test, type Page } from '@playwright/test';

const token = 'a'.repeat(43);
const session = {
  user: { id: '00000000-0000-4000-8000-000000000010', phone: '13800138000' },
  expiresAt: '2099-01-01T00:00:00.000Z',
};
const project = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'E2E 剪辑任务',
  description: null,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  hasMainVideo: false,
  deletionPending: false,
};

async function installApi(page: Page, signedIn = false) {
  let tasks = [project];
  let deletions = 0;
  let creations = 0;
  await page.addInitScript(
    ({ token, signedIn }) => {
      if (signedIn) sessionStorage.setItem('cev-session', token);
    },
    { token, signedIn },
  );
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const endpoint = new URL(req.url()).pathname;
    if (endpoint === '/api/auth/code')
      return route.fulfill({
        json: {
          testCode: '123456',
          resendAt: new Date(Date.now() + 60_000).toISOString(),
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
        },
      });
    if (endpoint === '/api/auth/login') {
      if (req.postDataJSON().code !== '123456')
        return route.fulfill({
          status: 400,
          json: {
            statusCode: 400,
            message: '验证码错误或已失效，请重新获取',
            code: 'CODE_INVALID',
          },
        });
      return route.fulfill({ json: { ...session, token } });
    }
    expect(req.headers()['authorization']).toBe(`Bearer ${token}`);
    if (endpoint === '/api/auth/me') return route.fulfill({ json: session });
    if (endpoint === '/api/auth/events')
      return route.fulfill({
        contentType: 'text/event-stream',
        body: 'data: {"type":"ready"}\n\n',
      });
    if (endpoint === '/api/auth/logout') return route.fulfill({ status: 204 });
    if (endpoint === '/api/media/policy')
      return route.fulfill({
        json: { maxBatch: 3, maxAssets: 10, maxBytes: 1024 ** 3, fps: 30 },
      });
    if (endpoint === '/api/projects') {
      if (req.method() === 'POST') {
        creations++;
        return route.fulfill({ status: 201, json: project });
      }
      return route.fulfill({ json: tasks });
    }
    if (endpoint === `/api/projects/${project.id}`) {
      if (req.method() === 'DELETE') {
        deletions++;
        if (deletions === 1)
          return route.fulfill({
            status: 503,
            json: { statusCode: 503, message: '删除失败，请重试' },
          });
        tasks = [];
        return route.fulfill({ status: 204 });
      }
      return route.fulfill({ json: project });
    }
    if (endpoint.endsWith('/media')) return route.fulfill({ json: [] });
    return route.fulfill({ status: 404, json: { message: 'Not found' } });
  });
  return { deletions: () => deletions, creations: () => creations };
}

test('login validation, countdown, successful login and reload restoration', async ({ page }) => {
  await installApi(page);
  await page.goto('/tasks/new');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByRole('button', { name: '获取验证码' }).click();
  await expect(page.getByRole('alert')).toContainText('11 位');
  await page.getByLabel('大陆手机号').fill('13800138000');
  await page.getByRole('button', { name: '获取验证码' }).click();
  await expect(page.getByRole('button', { name: /秒后重试/ })).toBeDisabled();
  await page.getByLabel('验证码', { exact: true }).fill('000000');
  await page.getByRole('button', { name: '登录 / 注册' }).click();
  await expect(page.getByRole('alert')).toContainText('验证码错误');
  await page.getByLabel('验证码', { exact: true }).fill('123456');
  await page.getByRole('button', { name: '登录 / 注册' }).click();
  await expect(page.getByRole('heading', { name: '我的剪辑任务' })).toBeVisible();
  await page.reload();
  await expect(page.getByText(project.name)).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('tasks.png'), fullPage: true });
  await page.getByRole('button', { name: '退出登录' }).click();
  await expect(page.getByRole('heading', { name: '手机号登录' })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('cev-session'))).toBeNull();
});

test('task deletion can cancel and retry; unavailable actions stay disabled', async ({ page }) => {
  const api = await installApi(page, true);
  await page.goto('/tasks');
  await expect(page.getByText(project.name)).toBeVisible();
  await expect(page.getByRole('button', { name: '查看' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '下载', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '删除', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('不可恢复');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  expect(api.deletions()).toBe(0);
  await page.getByRole('button', { name: '删除', exact: true }).click();
  await page.getByRole('button', { name: '确认删除' }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('删除失败');
  await page.getByRole('button', { name: '确认删除' }).click();
  await expect(page.getByText('还没有剪辑任务')).toBeVisible();
  expect(api.deletions()).toBe(2);
});

test('new editor creates no task and fits the minimum window', async ({ page }) => {
  const api = await installApi(page, true);
  await page.setViewportSize({ width: 960, height: 600 });
  await page.goto('/tasks/new');
  await expect(page.getByRole('heading', { name: '新建剪辑' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '对话剪辑' })).toBeVisible();
  expect(api.creations()).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('editor-minimum.png'), fullPage: true });
});

test('production build excludes the development preview route', async ({ page }) => {
  await installApi(page);
  await page.goto('/dev/ui-states');
  await expect(page.getByRole('heading', { name: '页面不存在' })).toBeVisible();
});

test('login form remains reachable at minimum window size', async ({ page }) => {
  await installApi(page);
  await page.setViewportSize({ width: 960, height: 600 });
  await page.goto('/login');
  await expect(page.getByLabel('大陆手机号')).toBeVisible();
  await page.getByRole('button', { name: '登录 / 注册' }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: '登录 / 注册' })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('login-minimum.png'), fullPage: true });
});
