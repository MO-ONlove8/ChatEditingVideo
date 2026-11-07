import styles from './index.module.less';
import { useEffect, useState } from 'react';
import { formatTimecode } from '@cev/shared';
import { Button } from '../Button';
import { Dialog } from '../Dialog';
import { Notice } from '../Notice';
import common from '../../styles/common.module.less';

export function FramePreview({
  open,
  onClose,
  source,
  imageUrl,
  frame,
  loading = false,
  error,
  onRetry,
}: {
  open: boolean;
  onClose: () => void;
  source: string;
  imageUrl: string;
  frame: number;
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
}) {
  const [feedback, setFeedback] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFeedback(undefined);
    setFailed(false);
  }, [open, frame]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(formatTimecode(frame));
      setFailed(false);
      setFeedback('时间已复制');
    } catch {
      setFailed(true);
      setFeedback('复制失败，请重试或手动选择时间');
    }
  };
  return (
    <Dialog open={open} title={`帧图放大 · ${source}`} onClose={onClose}>
      {loading ? (
        <p role="status">正在加载完整帧图…</p>
      ) : error ? (
        <Notice kind="error">
          {error} {onRetry && <Button onClick={onRetry}>重试图片</Button>}
        </Notice>
      ) : (
        <img
          className={styles.frameImage}
          src={imageUrl}
          alt={`${source} 在 ${formatTimecode(frame)} 的画面`}
        />
      )}
      <div className={`${common.row} ${common.between}`}>
        <strong>
          时间位置：<code>{formatTimecode(frame)}</code>
        </strong>
        <Button onClick={() => void copy()}>复制时间</Button>
      </div>
      <p className={common.muted}>每秒 30 帧，帧编号为 0～29。</p>
      {feedback && <Notice kind={failed ? 'error' : 'info'}>{feedback}</Notice>}
    </Dialog>
  );
}
