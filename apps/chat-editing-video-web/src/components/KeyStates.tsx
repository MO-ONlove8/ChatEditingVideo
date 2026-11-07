import { useEffect, useRef, useState } from 'react';
import { formatTimecode } from '@cev/shared';
import { Button, Dialog, Notice } from './ui';

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
          className="frame-image"
          src={imageUrl}
          alt={`${source} 在 ${formatTimecode(frame)} 的画面`}
        />
      )}
      <div className="row between">
        <strong>
          时间位置：<code>{formatTimecode(frame)}</code>
        </strong>
        <Button onClick={() => void copy()}>复制时间</Button>
      </div>
      <p className="muted">每秒 30 帧，帧编号为 0～29。</p>
      {feedback && <Notice kind={failed ? 'error' : 'info'}>{feedback}</Notice>}
    </Dialog>
  );
}

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
    <div className={`media-state ${status === 'processing' ? 'shaded' : ''}`} aria-busy={pending}>
      <div className="row between">
        <strong>
          {source} · {status === 'processing' ? '素材处理中' : '处理失败'}
        </strong>
        {status === 'failed' && (
          <div className="row">
            <Button disabled={pending || !onRetry} onClick={() => void run(onRetry)}>
              重试
            </Button>
            <Button disabled={pending || !onDelete} onClick={() => void run(onDelete)}>
              删除
            </Button>
          </div>
        )}
      </div>
      <p className="muted">
        {status === 'processing'
          ? '转换完成后才能查看帧图并用于剪辑'
          : (reason ?? '请重试，或删除后重新上传素材')}
      </p>
      {error && <Notice kind="error">{error}</Notice>}
    </div>
  );
}

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
    <div className="media-state" aria-busy={busy}>
      <div className="row between">
        <strong>{saved ? '确认卡：已保存' : '确认卡：保存失败，请重试'}</strong>
        <Button disabled={busy || saved} onClick={() => void retry()}>
          {busy ? '保存中…' : saved ? '已保存' : '重试保存'}
        </Button>
      </div>
      <p className="muted">
        {saved ? '操作已确认，不能重复执行' : '时间轴保持上次保存结果，重试只执行一次'}
      </p>
      {error && <Notice kind="error">{error}</Notice>}
    </div>
  );
}
