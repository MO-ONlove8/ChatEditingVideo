import { useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router';
import { useAuth } from './stores/auth';
import { getDesktop, isDesktop } from './lib/runtime';
import { logout, restoreSession } from './lib/session';
import { Button, Notice } from './components/ui';
import { SessionMonitor } from './components/SessionMonitor';
import { UploadLeaveGuard } from './components/UploadLeaveGuard';

export function AppShell() {
  const { pathname } = useLocation();
  const session = useAuth((s) => s.session);
  const status = useAuth((s) => s.status);
  const [exiting, setExiting] = useState(false);
  const preview = import.meta.env.DEV && pathname === '/dev/ui-states';
  const title =
    pathname.includes('/edit') || pathname.endsWith('/new')
      ? '剪辑工作台'
      : pathname.includes('/player')
        ? '独立播放页'
        : pathname === '/tasks'
          ? '我的任务'
          : preview
            ? '关键弹窗与状态'
            : isDesktop()
              ? 'Windows 桌面版 / 测试版'
              : '浏览器预览 / 测试版';
  return (
    <div className="app-shell">
      <header className="titlebar">
        <Link className="brand" to={session ? '/tasks' : '/login'}>
          <span className="brand-icon" aria-hidden="true">
            ▶
          </span>
          对话剪辑
        </Link>
        <span className="titlebar-subtitle">{title}</span>
        <span data-testid="runtime" className="sr-only">
          {isDesktop() ? '桌面端' : '浏览器'}
        </span>
        <div className="titlebar-actions">
          {import.meta.env.DEV && (
            <Link to="/dev/ui-states" className="muted">
              状态预览
            </Link>
          )}
          {session && (
            <>
              <span className="muted">
                {session.user.phone.slice(0, 3)}****{session.user.phone.slice(7)}
              </span>
              <Button
                disabled={exiting}
                onClick={() => {
                  setExiting(true);
                  void logout()
                    .catch(() => {})
                    .finally(() => setExiting(false));
                }}
              >
                退出登录
              </Button>
            </>
          )}
          {isDesktop() && (
            <div className="window-actions">
              <button
                aria-label="最小化"
                onClick={() => void getDesktop()?.windowAction('minimize')}
              >
                —
              </button>
              <button
                aria-label="最大化或还原"
                onClick={() => void getDesktop()?.windowAction('maximize')}
              >
                □
              </button>
              <button
                aria-label="关闭应用"
                onClick={() => void getDesktop()?.windowAction('close')}
              >
                ×
              </button>
            </div>
          )}
        </div>
      </header>
      <SessionMonitor />
      <UploadLeaveGuard />
      <div className="app-content">
        {!preview && status === 'loading' ? (
          <div className="centered">
            <Notice>正在验证登录状态…</Notice>
          </div>
        ) : !preview && status === 'offline' ? (
          <div className="centered">
            <Notice kind="error">
              暂时无法连接服务，请检查网络后重试。
              <Button onClick={() => void restoreSession()}>重试连接</Button>
            </Notice>
          </div>
        ) : (
          <Outlet />
        )}
      </div>
    </div>
  );
}
