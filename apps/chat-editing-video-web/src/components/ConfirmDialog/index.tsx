import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '../Button';
import { Notice } from '../Notice';
import { Dialog } from '../Dialog';

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel = '确认删除',
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel?: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const running = useRef(false);
  useEffect(() => {
    if (!open) setError(undefined);
  }, [open]);
  const confirm = async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await onConfirm();
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : '操作失败，请重试');
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      title={title}
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void confirm()}>
            {busy ? '处理中…' : confirmLabel}
          </Button>
        </>
      }
    >
      {children}
      {error && <Notice kind="error">{error}</Notice>}
    </Dialog>
  );
}
