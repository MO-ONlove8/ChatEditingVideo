import { useEffect, useRef, useState } from 'react';
import {
  ChatPageSchema,
  EditorStateSchema,
  formatTimecode,
  type ChatTurn,
  type EditorState,
  type Timeline,
} from '@cev/shared';
import { api } from '../lib/api';
import { editorPath, sendInstruction } from '../lib/editing';
import { Button, Dialog, Notice } from './ui';
import { TimelinePlayer } from './TimelinePlayer';

export function ChatPanel({
  projectId,
  state,
  onState,
  onBeforeChange,
}: {
  projectId?: string;
  state?: EditorState;
  onState: (state: EditorState) => void;
  onBeforeChange: () => void;
}) {
  const [text, setText] = useState(''),
    [sending, setSending] = useState(false),
    [sendingText, setSendingText] = useState(''),
    [busy, setBusy] = useState<string | null>(null),
    [errors, setErrors] = useState<Record<string, string>>({}),
    [older, setOlder] = useState<ChatTurn[]>([]),
    [cursor, setCursor] = useState<string | null | undefined>(undefined),
    [preview, setPreview] = useState<Timeline | null>(null);
  const active = useRef(false),
    controller = useRef<AbortController | null>(null),
    list = useRef<HTMLDivElement>(null),
    previous = useRef<string[]>([]),
    retry = useRef<{ text: string; requestId: string } | null>(null);
  const turns = [...older, ...(state?.turns ?? [])].filter(
    (t, i, a) => a.findIndex((v) => v.id === t.id) === i,
  );
  const locked =
    sending ||
    Boolean(state?.turns.some((t) => t.status === 'pending' || t.status === 'understanding'));
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    const ids = state?.timeline.clips.map((c) => c.id) ?? [];
    if (previous.current.some((id, i) => ids.includes(id) && ids.indexOf(id) !== i)) setText('');
    previous.current = ids;
  }, [state?.timeline]);
  useEffect(() => {
    if (list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [state?.turns, sending]);
  const send = async (value = text, requestId?: string) => {
    if (!projectId || !state || active.current || locked) return;
    active.current = true;
    setSending(true);
    setSendingText(value);
    setText('');
    setErrors((e) => ({ ...e, send: '' }));
    const id =
      requestId ?? (retry.current?.text === value ? retry.current.requestId : crypto.randomUUID());
    retry.current = { text: value, requestId: id };
    const abort = new AbortController();
    controller.current = abort;
    try {
      await sendInstruction(projectId, value, state.timeline.revision, id, onState, abort.signal);
      retry.current = null;
    } catch (error) {
      if (!abort.signal.aborted) setErrors((e) => ({ ...e, send: (error as Error).message }));
    } finally {
      active.current = false;
      setSending(false);
    }
  };
  const decide = async (id: string, action: 'confirm' | 'cancel') => {
    if (!projectId || busy) return;
    setBusy(id);
    setErrors((e) => ({ ...e, [id]: '' }));
    onBeforeChange();
    try {
      onState(
        await api(EditorStateSchema, `${editorPath(projectId)}/proposals/${id}/${action}`, {
          method: 'POST',
        }),
      );
    } catch (error) {
      setErrors((e) => ({
        ...e,
        [id]:
          action === 'confirm'
            ? `保存失败，请重试：${(error as Error).message}`
            : (error as Error).message,
      }));
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="panel chat-panel">
      <h2>对话剪辑</h2>
      <p className="muted">每条消息只处理一个操作</p>
      <div className="chat-history" ref={list}>
        {(cursor === undefined ? state?.nextCursor : cursor) && (
          <Button
            onClick={() =>
              void (async () => {
                try {
                  const page = await api(
                    ChatPageSchema,
                    `${editorPath(projectId!)}/chat?before=${encodeURIComponent((cursor === undefined ? state?.nextCursor : cursor)!)}`,
                  );
                  setOlder((o) => [...page.turns, ...o]);
                  setCursor(page.nextCursor);
                } catch (error) {
                  setErrors((e) => ({ ...e, send: (error as Error).message }));
                }
              })()
            }
          >
            加载更早对话
          </Button>
        )}
        {!turns.length && !sending && (
          <div className="chat-empty">
            <strong>先上传素材，再告诉我怎么剪</strong>
            <p className="shaded">截取 V1 的 5 秒到 8 秒，追加到末尾</p>
            <p className="shaded">把 Clip2 移到 Clip1 前面</p>
            <p className="shaded">复制 Clip1，放到末尾</p>
            <p className="muted">确认操作后才会保存剪辑结果。</p>
          </div>
        )}
        {turns.map((turn) => {
          const card = turn.proposal;
          return (
            <article className="chat-turn" key={turn.id}>
              <p className="chat-user">{turn.text}</p>
              <p>{turn.status === 'understanding' ? '正在理解…' : turn.reply}</p>
              {turn.status === 'failed' && (
                <Button disabled={locked} onClick={() => void send(turn.text, turn.requestId)}>
                  重试理解
                </Button>
              )}
              {card && (
                <div className="proposal-card" aria-label="剪辑确认卡">
                  <strong>请确认这次剪辑</strong>
                  <span className="badge">
                    {
                      {
                        pending: '待确认',
                        confirmed: '已保存',
                        cancelled: '已取消',
                        invalid: '已失效',
                      }[card.status]
                    }
                  </span>
                  <dl>
                    <dt>来源</dt>
                    <dd>{card.sourceLabel}</dd>
                    <dt>截取范围</dt>
                    <dd>
                      {formatTimecode(card.previewClip.startFrame)} →{' '}
                      {formatTimecode(card.previewClip.endFrame)}
                    </dd>
                    <dt>片段时长</dt>
                    <dd>
                      {formatTimecode(card.previewClip.endFrame - card.previewClip.startFrame + 1)}
                      （{card.previewClip.endFrame - card.previewClip.startFrame + 1} 帧）
                    </dd>
                    <dt>目标位置</dt>
                    <dd>{card.destinationLabel}</dd>
                  </dl>
                  {card.status === 'pending' && (
                    <>
                      <Button
                        onClick={() => {
                          onBeforeChange();
                          setPreview({
                            revision: card.baseRevision,
                            fps: 30,
                            canvas:
                              state?.timeline.canvas ??
                              (card.operation.kind === 'add'
                                ? card.operation.canvas
                                : { width: 1920, height: 1080 }),
                            clips: [{ ...card.previewClip, id: card.id }],
                          });
                        }}
                      >
                        播放选段预览
                      </Button>
                      <div className="row">
                        <Button
                          variant="primary"
                          disabled={busy !== null}
                          onClick={() => void decide(card.id, 'confirm')}
                        >
                          {busy === card.id
                            ? '处理中…'
                            : errors[card.id]
                              ? '重试确认保存'
                              : '确认并保存'}
                        </Button>
                        <Button
                          disabled={busy !== null}
                          onClick={() => void decide(card.id, 'cancel')}
                        >
                          取消
                        </Button>
                      </div>
                    </>
                  )}
                  {errors[card.id] && <Notice kind="error">{errors[card.id]}</Notice>}
                </div>
              )}
            </article>
          );
        })}
        {sending && (
          <div className="chat-turn">
            <p className="chat-user">{sendingText}</p>
            <p role="status">正在理解…</p>
          </div>
        )}
      </div>
      {errors.send && (
        <Notice kind="error">
          {errors.send}
          {retry.current && (
            <Button
              disabled={locked}
              onClick={() => void send(retry.current!.text, retry.current!.requestId)}
            >
              重试
            </Button>
          )}
        </Notice>
      )}
      <form
        className="chat-composer"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) void send();
        }}
      >
        <textarea
          aria-label="输入剪辑指令"
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={4000}
          disabled={!projectId || !state || locked}
          placeholder={locked ? '请先处理上方的确认卡' : '例如：截取 V1 的 5 秒到 8 秒，追加到末尾'}
        />
        <div className="row between">
          <small className="muted">时间示例：00:05:12</small>
          <Button type="submit" disabled={!projectId || !state || locked || !text.trim()}>
            发送
          </Button>
        </div>
      </form>
      <Dialog open={Boolean(preview)} title="选段播放预览" onClose={() => setPreview(null)}>
        {preview && <TimelinePlayer timeline={preview} />}
      </Dialog>
    </section>
  );
}
