import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from './router';
import { useAuth } from './stores/auth';
import { useUploads } from './stores/uploads';

const token = 'a'.repeat(43);
const session = {
  user: { id: '00000000-0000-4000-8000-000000000010', phone: '13800138000' },
  expiresAt: '2099-01-01T00:00:00.000Z',
};
const project = {
  id: '00000000-0000-4000-8000-000000000001',
  name: '示例任务',
  description: null,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  hasMainVideo: false,
  deletionPending: false,
};

function renderAt(path: string, authenticated = true) {
  useAuth.setState({
    status: 'ready',
    token: authenticated ? token : null,
    session: authenticated ? session : null,
    notice: null,
  });
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}
function mockFetch(handler?: (path: string, init?: RequestInit) => Response) {
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    if (input.endsWith('/auth/events'))
      return new Response('data: {"type":"ready"}\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      });
    if (input.endsWith('/auth/me')) return Response.json(session);
    return handler?.(input, init) ?? Response.json([project]);
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
  useUploads.setState({ entries: [] });
});

describe('application routes and login', () => {
  it('redirects anonymous deep links to login without loading tasks', async () => {
    const fetch = mockFetch();
    const router = renderAt('/tasks/new', false);
    expect(await screen.findByRole('heading', { name: '手机号登录' })).toBeVisible();
    expect(router.state.location.pathname).toBe('/login');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('requests a test code, shows cooldown and logs in', async () => {
    const fetch = mockFetch((path) =>
      path.endsWith('/auth/code')
        ? Response.json({
            testCode: '123456',
            resendAt: new Date(Date.now() + 60_000).toISOString(),
            expiresAt: new Date(Date.now() + 300_000).toISOString(),
          })
        : path.endsWith('/auth/login')
          ? Response.json({ ...session, token })
          : Response.json([project]),
    );
    renderAt('/login', false);
    await userEvent.type(screen.getByLabelText('大陆手机号'), session.user.phone);
    await userEvent.click(screen.getByRole('button', { name: '获取验证码' }));
    expect(await screen.findByText('验证码获取成功')).toBeVisible();
    expect(screen.getByRole('button', { name: /秒后重试/ })).toBeDisabled();
    await userEvent.type(screen.getByLabelText('验证码', { exact: true }), '123456');
    await userEvent.click(screen.getByRole('button', { name: '登录 / 注册' }));
    expect(await screen.findByRole('heading', { name: '我的剪辑任务' })).toBeVisible();
    expect(sessionStorage.getItem('cev-session')).toBe(token);
    expect(fetch.mock.calls.filter(([path]) => path.endsWith('/auth/login'))).toHaveLength(1);
  });
  it('lists real tasks, disables unavailable video actions and does not create a blank task', async () => {
    const fetch = mockFetch();
    renderAt('/tasks');
    expect(await screen.findByText('示例任务')).toBeVisible();
    expect(screen.getByRole('button', { name: '查看' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^下载$/ })).toBeDisabled();
    await userEvent.click(screen.getByRole('link', { name: '＋ 新建' }));
    expect(await screen.findByRole('heading', { name: '新建剪辑' })).toBeVisible();
    expect(
      fetch.mock.calls.some(
        ([path, init]) => path.endsWith('/projects') && init?.method === 'POST',
      ),
    ).toBe(false);
  });
  it('returns to login on replaced session and keeps the reason visible', async () => {
    mockFetch(() =>
      Response.json(
        { statusCode: 401, code: 'SESSION_REPLACED', message: '账号已在其他位置登录' },
        { status: 401 },
      ),
    );
    renderAt('/tasks');
    expect(await screen.findByRole('heading', { name: '手机号登录' })).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent('账号已在其他位置登录');
    expect(useAuth.getState().token).toBeNull();
  });
  it('can keep uploading or cancel and leave from the preview', async () => {
    mockFetch();
    const router = renderAt('/dev/ui-states');
    await userEvent.click(screen.getByRole('button', { name: '模拟上传中' }));
    await userEvent.click(screen.getByRole('link', { name: '尝试离开' }));
    expect(await screen.findByRole('dialog', { name: '还有素材正在上传' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: '继续上传' }));
    expect(router.state.location.pathname).toBe('/dev/ui-states');
    expect(useUploads.getState().entries).toHaveLength(1);
    await userEvent.click(screen.getByRole('link', { name: '尝试离开' }));
    await userEvent.click(screen.getByRole('button', { name: '取消上传并离开' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/tasks'));
    expect(useUploads.getState().entries).toHaveLength(0);
  });
});
