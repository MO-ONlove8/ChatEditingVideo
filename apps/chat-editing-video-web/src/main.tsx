import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router';
import { initRuntime } from './lib/runtime';
import { createRouter } from './router';
import './index.css';
import { restoreSession } from './lib/session';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

await initRuntime();
void restoreSession();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={createRouter()} />
    </QueryClientProvider>
  </StrictMode>,
);
