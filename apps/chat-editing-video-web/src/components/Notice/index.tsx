import { type ReactNode } from 'react';
import styles from './index.module.less';

export function Notice({
  children,
  kind = 'info',
}: {
  children: ReactNode;
  kind?: 'info' | 'error';
}) {
  return (
    <div
      className={`${styles.notice} ${kind === 'error' ? styles.error : ''}`}
      role={kind === 'error' ? 'alert' : 'status'}
    >
      {children}
    </div>
  );
}
