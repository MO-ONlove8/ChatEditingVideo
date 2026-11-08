import { type ReactNode } from 'react';
import styles from './index.module.less';

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className={styles.emptyState}>
      <strong>{title}</strong>
      {children && <p>{children}</p>}
    </div>
  );
}
