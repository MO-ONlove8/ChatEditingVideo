import mediaProcessingStateStyles from '../MediaProcessingState/index.module.less';
import { useRef, useState } from 'react';
import { Button } from '../Button';
import { Notice } from '../Notice';
import common from '../../styles/common.module.less';

export function SaveFailureState({ onRetry }: { onRetry: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string>();
  const running = useRef(false);
  const retry = async () => {
    if (running.current || saved) return;
    running.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await onRetry();
      setSaved(true);
    } catch (error) {
      setError(error instanceof Error ? error.message : '保存失败，请重试');
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  return (
    <div className={mediaProcessingStateStyles.mediaState} aria-busy={busy}>
      <div className={`${common.row} ${common.between}`}>
        <strong>{saved ? '确认卡：已保存' : '确认卡：保存失败，请重试'}</strong>
        <Button disabled={busy || saved} onClick={() => void retry()}>
          {busy ? '保存中…' : saved ? '已保存' : '重试保存'}
        </Button>
      </div>
      <p className={common.muted}>
        {saved ? '操作已确认，不能重复执行' : '时间轴保持上次保存结果，重试只执行一次'}
      </p>
      {error && <Notice kind="error">{error}</Notice>}
    </div>
  );
}
