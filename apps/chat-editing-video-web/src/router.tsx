import { createBrowserRouter, Link, Navigate, Outlet } from 'react-router';
import { AppShell } from './AppShell';
import { LoginPage } from './pages/LoginPage';
import { TasksPage } from './pages/TasksPage';
import { EditorPage } from './pages/EditorPage';
import { PlayerPage } from './pages/PlayerPage';
import { UiStatesPage } from './pages/UiStatesPage';
import { useAuth } from './stores/auth';

function RequireAuth() {
  return useAuth((s) => s.session) ? <Outlet /> : <Navigate to="/login" replace />;
}

export const routes = [
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="/tasks" replace /> },
      { path: 'login', element: <LoginPage /> },
      {
        element: <RequireAuth />,
        children: [
          { path: 'tasks', element: <TasksPage /> },
          { path: 'tasks/new', element: <EditorPage /> },
          { path: 'tasks/:id/edit', element: <EditorPage /> },
          { path: 'tasks/:id/player', element: <PlayerPage /> },
        ],
      },
      ...(import.meta.env.DEV ? [{ path: 'dev/ui-states', element: <UiStatesPage /> }] : []),
      {
        path: '*',
        element: (
          <main className="centered">
            <h1>页面不存在</h1>
            <Link to="/tasks">返回任务列表</Link>
          </main>
        ),
      },
    ],
  },
];

export const createRouter = () => createBrowserRouter(routes);
