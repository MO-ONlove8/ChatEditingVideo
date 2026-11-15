import { useEffect, useRef, useState } from 'react';
import { ChatPageSchema, type ChatTurn, type EditorState } from '@cev/shared';
import { api } from '../../../../../../lib/api';
import { editorPath, sendInstruction } from '../../../../../../lib/editing';
import { Button } from '../../../../../../components/Button';
import { CandidateCard } from './CandidateCard';
import { Notice } from '../../../../../../components/Notice';
import common from '../../../../../../styles/common.module.less';
import styles from './index.module.less';

export function ChatPanel({
  projectId,
  state,
  onState,
  onBeforeChange,
  candidateLoaded,
  onCandidatePreview,
  dirtyRequest,
  playhead = 0,
  selectedId,
}: {
  candidateLoaded?: string;
  onCandidatePreview?: () => void;
  dirtyRequest?: string;
  projectId?: string;
  playhead?: number;
  selectedId?: string;
  state?: EditorState;
  onState: (state: EditorState) => void;
  onBeforeChange: () => void;
}) {
  const [text, setText] = useState(''),
    [sending, setSending] = useState(false),
    [sendingText, setSendingText] = useState(''),
    [errors, setErrors] = useState<Record<string, string>>({}),
    [older, setOlder] = useState<ChatTurn[]>([]),
    [cursor, setCursor] = useState<string | null | undefined>(undefined);
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
      await sendInstruction(projectId, value, state.timeline.revision, id, onState, abort.signal, {
        playhead,
        selectedId,
      });
      retry.current = null;
    } catch (error) {
      if (!abort.signal.aborted) setErrors((e) => ({ ...e, send: (error as Error).message }));
    } finally {
      active.current = false;
      setSending(false);
    }
  };
  return (
    <section className={`${common.panel} ${styles.chatPanel}`}>
      <h2>对话剪辑</h2>
      <p className={`${common.muted} ${styles.subtitle}`}>每条消息只处理一个操作</p>
      <div className={styles.chatHistory} ref={list}>
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
          <div className={styles.chatEmpty}>
            <strong>先上传素材，再告诉我怎么剪</strong>
            <p className={`${common.shaded} ${styles.example}`}>
              截取 V1 的 5 秒到 8 秒，追加到末尾
            </p>
            <p className={`${common.shaded} ${styles.example}`}>把 Clip2 移到 Clip1 前面</p>
            <p className={`${common.shaded} ${styles.example}`}>复制 Clip1，放到末尾</p>
            <p className={`${common.muted} ${styles.hint}`}>确认操作后才会保存剪辑结果。</p>
          </div>
        )}
        {turns.map((turn) => {
          const card = turn.proposal;
          return (
            <article className={styles.chatTurn} key={turn.id}>
              <p className={styles.chatUser}>{turn.text}</p>
              <p>{turn.status === 'understanding' ? '正在理解…' : turn.reply}</p>
              {turn.status === 'failed' && (
                <Button disabled={locked} onClick={() => void send(turn.text, turn.requestId)}>
                  重试理解
                </Button>
              )}
              {card && projectId && (
                <CandidateCard
                  card={card}
                  candidateLoaded={candidateLoaded}
                  onCandidatePreview={onCandidatePreview}
                  dirty={dirtyRequest === turn.requestId}
                  requestId={turn.requestId}
                  projectId={projectId}
                  onState={onState}
                  onBeforeChange={onBeforeChange}
                />
              )}
            </article>
          );
        })}
        {sending && (
          <div className={styles.chatTurn}>
            <p className={styles.chatUser}>{sendingText}</p>
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
        className={styles.chatComposer}
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
        <div className={`${common.row} ${common.between}`}>
          <small className={common.muted}>时间示例：00:05:12</small>
          <Button type="submit" disabled={!projectId || !state || locked || !text.trim()}>
            发送
          </Button>
        </div>
      </form>
    </section>
  );
}
