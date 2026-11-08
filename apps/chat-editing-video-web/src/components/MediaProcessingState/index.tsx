import styles from './index.module.less';
import { useRef, useState } from 'react';
import { Button } from '../Button';
import { Notice } from '../Notice';
import common from '../../styles/common.module.less';

export function MediaProcessingState({
  source,
  status,
  reason,
  onRetry,
  onDelete,
}: {
  source: string;
  status: 'processing' | 'failed';
  reason?: string;
  onRetry?: () => Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const running = useRef(false);
  const run = async (callback?: () => Promise<void>) => {
    if (!callback || running.current) return;
    running.current = true;
    setPending(true);
    setError(undefined);
    try {
      await callback();
    } catch (error) {
      setError(error instanceof Error ? error.message : '操作失败，请重试');
    } finally {
      running.current = false;
      setPending(false);
    }
  };
  return (
    <div
      className={`${styles.mediaState} ${status === 'processing' ? common.shaded : ''}`}
      aria-busy={pending}
    >
      <div className={`${common.row} ${common.between}`}>
        <strong>
          {source} · {status === 'processing' ? '素材处理中' : '处理失败'}
        </strong>
        {status === 'failed' && (
          <div className={common.row}>
            <Button disabled={pending || !onRetry} onClick={() => void run(onRetry)}>
              重试
            </Button>
            <Button disabled={pending || !onDelete} onClick={() => void run(onDelete)}>
              删除
            </Button>
          </div>
        )}
      </div>
      <p className={common.muted}>
        {status === 'processing'
          ? '转换完成后才能查看帧图并用于剪辑'
          : (reason ?? '请重试，或删除后重新上传素材')}
      </p>
      {error && <Notice kind="error">{error}</Notice>}
    </div>
  );
}
