import { useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router';
import { useAuth } from '../../stores/auth';
import { getDesktop, isDesktop } from '../../lib/runtime';
import { logout, restoreSession } from '../../lib/session';
import { Button } from '../Button';
import { Notice } from '../Notice';
import { SessionMonitor } from './components/SessionMonitor';
import { UploadLeaveGuard } from './components/UploadLeaveGuard';
import styles from './index.module.less';
import common from '../../styles/common.module.less';

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
    <div className={styles.appShell}>
      <header className={styles.titlebar}>
        <Link className={styles.brand} to={session ? '/tasks' : '/login'}>
          <span className={styles.brandIcon} aria-hidden="true">
            ▶
          </span>
          对话剪辑
        </Link>
        <span className={styles.titlebarSubtitle}>{title}</span>
        <span data-testid="runtime" className={common.srOnly}>
          {isDesktop() ? '桌面端' : '浏览器'}
        </span>
        <div className={styles.titlebarActions}>
          {import.meta.env.DEV && (
            <Link to="/dev/ui-states" className={common.muted}>
              状态预览
            </Link>
          )}
          {session && (
            <>
              <span className={common.muted}>
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
            <div className={styles.windowActions}>
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
      <div className={styles.appContent}>
        {!preview && status === 'loading' ? (
          <div className={common.centered}>
            <Notice>正在验证登录状态…</Notice>
          </div>
        ) : !preview && status === 'offline' ? (
          <div className={common.centered}>
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
