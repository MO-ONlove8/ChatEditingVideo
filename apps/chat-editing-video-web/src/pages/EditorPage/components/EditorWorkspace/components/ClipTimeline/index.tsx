import { useEffect, useRef, useState, type RefObject } from 'react';
import type { PlayerRef } from '@remotion/player';
import { clipFrames, formatTimecode, timelineFrames, type Timeline } from '@cev/shared';
import { Button } from '../../../../../../components/Button';
import { ConfirmDialog } from '../../../../../../components/ConfirmDialog';
import common from '../../../../../../styles/common.module.less';
import styles from './index.module.less';

export function ClipTimeline({
  timeline,
  frame,
  playing,
  playerRef,
  stopAt,
  onDelete,
}: {
  timeline: Timeline;
  frame: number;
  playing: boolean;
  playerRef: RefObject<PlayerRef | null>;
  stopAt: RefObject<number | null>;
  onDelete: (id: string, requestId: string) => Promise<void>;
}) {
  const scroll = useRef<HTMLDivElement>(null),
    auto = useRef<number | null>(null),
    end = stopAt,
    manualCursor = useRef(0);
  const [width, setWidth] = useState(600),
    [left, setLeft] = useState(0),
    [deleting, setDeleting] = useState<{ id: string; number: number; requestId: string } | null>(
      null,
    );
  const total = timelineFrames(timeline),
    scale = Math.max(40 / 30, width / Math.max(1, total)),
    length = total * scale;
  useEffect(() => {
    const el = scroll.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    setWidth(el.clientWidth);
    return () => observer.disconnect();
  }, [Boolean(total)]);
  useEffect(() => {
    const el = scroll.current;
    if (!el || !total) return;
    if (end.current !== null && frame >= end.current) {
      playerRef.current?.pause();
      playerRef.current?.seekTo(end.current);
      end.current = null;
    }
    if (playing) {
      const value = Math.max(0, Math.min(length - width, frame * scale - width / 2));
      auto.current = value;
      el.scrollLeft = value;
      setLeft(value);
      manualCursor.current = frame * scale - value;
    }
  }, [frame, playing, total, scale, width, length, playerRef]);
  let offset = 0;
  const tickSeconds = Math.max(1, Math.ceil(width / scale / 30 / 8));
  const ticks = Array.from(
    { length: Math.floor(total / (30 * tickSeconds)) + 1 },
    (_, i) => i * 30 * tickSeconds,
  ).filter((f) => f * scale >= left - width && f * scale <= left + 2 * width);
  return (
    <section className={`${common.panel} ${styles.timelinePanel}`}>
      <div className={`${common.row} ${common.between}`}>
        <h2>时间轴</h2>
        <span className={common.muted}>
          时间：分:秒:帧{' '}
          <span
            className={styles.help}
            tabIndex={0}
            title="时间格式为 时:分:秒:帧；未满一小时可省略小时。每秒30帧，帧编号为0～29。例如00:05:12表示5秒第12帧。"
          >
            ?
          </span>
        </span>
      </div>
      {!total ? (
        <div className={styles.timelineEmpty}>暂无片段 · 在右侧发送指令并确认后添加</div>
      ) : (
        <div
          className={styles.clipScroll}
          ref={scroll}
          onPointerDown={() => {
            playerRef.current?.pause();
            manualCursor.current = Math.max(0, frame * scale - (scroll.current?.scrollLeft ?? 0));
            auto.current = null;
            end.current = null;
          }}
          onWheel={() => {
            playerRef.current?.pause();
            manualCursor.current = Math.max(
              0,
              Math.min(width, frame * scale - (scroll.current?.scrollLeft ?? 0)),
            );
            auto.current = null;
            end.current = null;
          }}
          onScroll={(e) => {
            const x = e.currentTarget.scrollLeft;
            setLeft(x);
            if (auto.current !== null && Math.abs(auto.current - x) < 2) {
              auto.current = null;
              return;
            }
            playerRef.current?.pause();
            end.current = null;
            playerRef.current?.seekTo(
              Math.max(0, Math.min(total - 1, Math.round((x + manualCursor.current) / scale))),
            );
          }}
        >
          <div className={styles.clipTrack} style={{ width: length }}>
            <div className={styles.clipTicks}>
              {ticks.map((f) => (
                <span key={f} style={{ left: f * scale }}>
                  {formatTimecode(f)}
                </span>
              ))}
            </div>
            <div className={styles.clipBlocks}>
              {timeline.clips.map((c, i) => {
                const start = offset;
                offset += clipFrames(c);
                return (
                  <div
                    className={styles.clipBlock}
                    key={c.id}
                    style={{ width: clipFrames(c) * scale }}
                    title={`Clip${i + 1} · ${formatTimecode(clipFrames(c))}`}
                  >
                    <button
                      className={styles.clipSelect}
                      aria-label={`播放Clip${i + 1}`}
                      onKeyDown={(event) => {
                        if (event.key === 'Delete') {
                          event.preventDefault();
                          setDeleting({ id: c.id, number: i + 1, requestId: crypto.randomUUID() });
                        }
                      }}
                      onClick={() => {
                        end.current = start + clipFrames(c) - 1;
                        playerRef.current?.seekTo(start);
                        void playerRef.current?.play();
                      }}
                    >
                      Clip{i + 1} · {formatTimecode(clipFrames(c))}
                    </button>
                    <Button
                      className={styles.clipDelete}
                      aria-label={`删除Clip${i + 1}`}
                      onClick={() =>
                        setDeleting({ id: c.id, number: i + 1, requestId: crypto.randomUUID() })
                      }
                    >
                      ×
                    </Button>
                  </div>
                );
              })}
            </div>
            <div className={styles.playhead} style={{ left: Math.min(total - 1, frame) * scale }} />
          </div>
        </div>
      )}
      <ConfirmDialog
        open={Boolean(deleting)}
        title={`删除Clip${deleting?.number ?? ''}？`}
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          await onDelete(deleting!.id, deleting!.requestId);
          end.current = null;
        }}
      >
        <p>仅删除该片段，素材和其他复制片段保留。首版不支持撤销。</p>
      </ConfirmDialog>
    </section>
  );
}
