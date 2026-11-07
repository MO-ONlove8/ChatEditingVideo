import { useEffect, useState } from 'react';
import { useBlocker, useBeforeUnload } from 'react-router';
import { cancelUploads, useUploads } from '../../../../stores/uploads';
import { getDesktop } from '../../../../lib/runtime';
import { Button } from '../../../Button';
import { Dialog } from '../../../Dialog';
import { Notice } from '../../../Notice';
import common from '../../../../styles/common.module.less';

export function UploadLeaveGuard() {
  const active = useUploads((s) => s.entries.length > 0);
  const [closeRequested, setCloseRequested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const blocker = useBlocker(
    ({ nextLocation }) => active && nextLocation.pathname !== useUploads.getState().internalPath,
  );
  useBeforeUnload((event) => {
    if (active && !getDesktop()) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
  useEffect(() => {
    const desktop = getDesktop();
    if (!desktop) return;
    void desktop.setCloseGuard(active);
    const off = desktop.onCloseRequested(() => setCloseRequested(true));
    return () => {
      off();
      void desktop.setCloseGuard(false);
    };
  }, [active]);
  const stay = () => {
    if (blocker.state === 'blocked') blocker.reset();
    setCloseRequested(false);
    setError(undefined);
  };
  const leave = async () => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await cancelUploads();
      if (closeRequested) await getDesktop()?.confirmClose();
      else if (blocker.state === 'blocked') blocker.proceed();
      setCloseRequested(false);
    } catch (error) {
      setError(error instanceof Error ? error.message : '取消上传失败，请重试');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={blocker.state === 'blocked' || closeRequested}
      title="还有素材正在上传"
      onClose={stay}
      busy={busy}
      footer={
        <>
          <Button disabled={busy} onClick={() => void leave()}>
            取消上传并离开
          </Button>
          <Button variant="primary" disabled={busy} onClick={stay}>
            继续上传
          </Button>
        </>
      }
    >
      <p>离开将取消尚未完成的上传。</p>
      <p className={common.muted}>
        已完整上传的素材保留；
        <br />
        未完成的文件需要重新上传。
      </p>
      {error && <Notice kind="error">{error}</Notice>}
    </Dialog>
  );
}
