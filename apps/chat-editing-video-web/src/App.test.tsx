import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from './router';

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  return render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const project = {
  id: '00000000-0000-4000-8000-000000000001',
  name: '示例项目',
  description: null,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

afterEach(() => vi.unstubAllGlobals());

describe('App', () => {
  it('lists projects from the API (validated by shared schema)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json([project])));
    renderAt('/');
    expect(await screen.findByText('示例项目')).toBeInTheDocument();
    expect(screen.getByTestId('runtime')).toHaveTextContent('浏览器');
  });

  it('streams chat deltas from SSE', async () => {
    const sse =
      'data: {"type":"delta","content":"你好"}\n\n' +
      'data: {"type":"delta","content":"，世界"}\n\n' +
      'data: {"type":"done"}\n\n';
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(new Response(sse, { headers: { 'content-type': 'text/event-stream' } })),
    );
    renderAt('/chat');
    await userEvent.type(screen.getByLabelText('输入剪辑需求'), '剪掉片头');
    await userEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByText('你好，世界')).toBeInTheDocument();
  });

  it('disables the desktop executor in the browser', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json([project])));
    renderAt('/jobs');
    expect(screen.getByRole('radio', { name: /桌面端本地/ })).toBeDisabled();
    expect(screen.getByRole('radio', { name: /服务端/ })).toBeChecked();
  });
});
