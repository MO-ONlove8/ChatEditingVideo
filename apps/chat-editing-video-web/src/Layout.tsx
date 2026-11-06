import { NavLink, Outlet } from 'react-router';
import { isDesktop } from './lib/runtime';

const links = [
  { to: '/', label: '项目' },
  { to: '/chat', label: '对话剪辑' },
  { to: '/jobs', label: '渲染任务' },
];

export function Layout() {
  return (
    <div className="flex h-screen bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <nav
        aria-label="主导航"
        className="w-48 shrink-0 border-r border-neutral-200 p-4 dark:border-neutral-800"
      >
        <p className="mb-4 font-bold">Chat Editing Video</p>
        <ul className="space-y-1">
          {links.map((l) => (
            <li key={l.to}>
              <NavLink
                to={l.to}
                end
                className={({ isActive }) =>
                  `block rounded px-2 py-1 ${isActive ? 'bg-blue-600 text-white' : 'hover:bg-neutral-100 dark:hover:bg-neutral-800'}`
                }
              >
                {l.label}
              </NavLink>
            </li>
          ))}
        </ul>
        <p className="mt-6 text-xs text-neutral-500" data-testid="runtime">
          {isDesktop() ? '桌面端' : '浏览器'}
        </p>
      </nav>
      <main className="flex-1 overflow-y-auto p-6">
        <Outlet />
      </main>
    </div>
  );
}
