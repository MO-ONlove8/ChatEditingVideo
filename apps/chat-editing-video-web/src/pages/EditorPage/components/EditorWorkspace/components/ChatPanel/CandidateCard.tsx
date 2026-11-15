import { useRef, useState } from 'react';
import { z } from 'zod';
import { EditorStateSchema, formatTimecode, type EditorState, type Proposal } from '@cev/shared';
import { api } from '../../../../../../lib/api';
import { editorPath } from '../../../../../../lib/editing';
import { Button } from '../../../../../../components/Button';
import { Notice } from '../../../../../../components/Notice';
import { TimelinePlayer } from '../../../../../../components/TimelinePlayer';
import common from '../../../../../../styles/common.module.less';
import styles from './index.module.less';

export function CandidateCard({
  card,
  requestId,
  projectId,
  onState,
  onBeforeChange,
  candidateLoaded,
  onCandidatePreview,
  dirty = false,
}: {
  candidateLoaded?: string;
  onCandidatePreview?: () => void;
  dirty?: boolean;
  card: Proposal;
  requestId: string;
  projectId: string;
  onState: (s: EditorState) => void;
  onBeforeChange: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [loaded, setLoaded] = useState('');
  const lock = useRef(false),
    uncertain = useRef(false);
  const pureDelete = ['delete-element', 'delete-clip'].includes(card.operation.kind);
  const signature = card.generation + ':' + card.contentHash;
  const decide = async (action: 'confirm' | 'cancel') => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    onBeforeChange();
    try {
      if (action === 'confirm' && uncertain.current) {
        const result = await api(
          z.object({
            status: z.enum(['committed', 'not-committed', 'unknown']),
            revision: z.number().nullable(),
          }),
          editorPath(projectId) + '/operations/' + requestId,
        );
        if (result.status === 'committed') {
          onState(await api(EditorStateSchema, editorPath(projectId) + '/editor-state'));
          uncertain.current = false;
          return;
        }
        if (result.status === 'unknown') throw new Error('保存结果仍待核对，请稍后重试核对');
      }
      if (action === 'confirm') uncertain.current = true;
      onState(
        await api(
          EditorStateSchema,
          editorPath(projectId) + '/proposals/' + card.id + '/' + action,
          {
            method: 'POST',
            ...(action === 'confirm'
              ? {
                  body: JSON.stringify({
                    requestId,
                    contentHash: card.contentHash,
                    generation: card.generation,
                  }),
                }
              : {}),
          },
        ),
      );
      uncertain.current = false;
    } catch (e) {
      setError(
        (action === 'confirm' ? '保存未确认；再次点击会先核对原操作结果。' : '') +
          (e as Error).message,
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const retry = async () => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      onState(
        await api(
          EditorStateSchema,
          editorPath(projectId) + '/proposals/' + card.id + '/preview/retry',
          { method: 'POST' },
        ),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return (
    <div className={styles.proposalCard} aria-label="剪辑确认卡">
      <strong>操作候选 · 基于 v{card.baseRevision}</strong>
      <span className={common.badge}>
        {
          { pending: '待确认', confirmed: '已保存', cancelled: '已取消', invalid: '已失效' }[
            card.status
          ]
        }
      </span>
      <p>
        {card.sourceLabel} → {card.destinationLabel}
      </p>
      {card.previewClip && (
        <p>
          {formatTimecode(card.previewClip.startFrame)} →{' '}
          {formatTimecode(card.previewClip.endFrame)} ·{' '}
          {card.previewClip.endFrame - card.previewClip.startFrame + 1} 帧
        </p>
      )}
      {!!card.details.length && (
        <details open={card.details.length < 10}>
          <summary>差异、默认参数与影响（{card.details.length}）</summary>
          <ul>
            {card.details.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </details>
      )}
      {card.status === 'pending' && (
        <>
          {pureDelete ? (
            <Notice>仅删除所列对象；其他已确认定义保留。确认后不可撤销。</Notice>
          ) : card.previewStatus === 'ready' && card.candidate && card.manifest ? (
            <>
              <p>完整候选预览 · 尚未保存</p>
              {onCandidatePreview ? (
                <Button onClick={onCandidatePreview}>播放完整候选合成（左侧）</Button>
              ) : (
                <TimelinePlayer
                  key={signature}
                  timeline={card.candidate}
                  manifest={card.manifest}
                  projectId={projectId}
                  onReady={() => setLoaded(signature)}
                />
              )}
            </>
          ) : (
            <Notice kind={card.previewStatus === 'failed' ? 'error' : undefined}>
              {card.previewStatus === 'failed'
                ? '候选准备失败：' + card.previewError
                : '正在准备文字、图像与整段混音…'}
              {card.previewStatus === 'failed' && (
                <Button disabled={busy} onClick={() => void retry()}>
                  重试候选预览
                </Button>
              )}
            </Notice>
          )}
          <div className={common.row + ' ' + styles.proposalActions}>
            <Button
              variant="primary"
              disabled={
                busy ||
                dirty ||
                (!pureDelete &&
                  (card.previewStatus !== 'ready' ||
                    (onCandidatePreview ? candidateLoaded : loaded) !== signature))
              }
              onClick={() => void decide('confirm')}
            >
              {busy ? '处理中…' : uncertain.current ? '核对并重试保存' : '确认并保存'}
            </Button>
            <Button disabled={busy} onClick={() => void decide('cancel')}>
              取消
            </Button>
          </div>
        </>
      )}
      {error && <Notice kind="error">{error}</Notice>}
      {dirty && card.status === 'pending' && (
        <Notice>属性参数已修改，请更新完整候选后再确认。</Notice>
      )}
    </div>
  );
}
