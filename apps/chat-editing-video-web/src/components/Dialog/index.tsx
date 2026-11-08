import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Button } from '../Button';
import styles from './index.module.less';

export function Dialog({
  open,
  title,
  children,
  footer,
  onClose,
  busy = false,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!open || !dialog) return;
    const previous = document.activeElement as HTMLElement | null;
    dialog.showModal();
    return () => {
      dialog.close();
      previous?.focus();
    };
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby={id}
      aria-busy={busy}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(event) => {
        if (busy || event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        )
          onClose();
      }}
    >
      <div className={styles.dialogHeading}>
        <h2 id={id}>{title}</h2>
        <Button aria-label="关闭弹窗" disabled={busy} onClick={onClose}>
          ×
        </Button>
      </div>
      <div className={styles.dialogBody}>{children}</div>
      {footer && <div className={styles.dialogFooter}>{footer}</div>}
    </dialog>
  );
}
