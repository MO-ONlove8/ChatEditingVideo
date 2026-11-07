import { useCallback, useEffect, useRef, useState, type PointerEvent, type RefObject } from 'react';
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
    manualCursor = useRef(0),
    pendingSeek = useRef<number | null>(null),
    drag = useRef<{ id: number; x: number; grabOffset: number; frame: number } | null>(null);
  const [width, setWidth] = useState(600),
    [left, setLeft] = useState(0),
    [dragging, setDragging] = useState(false),
    [scrubFrame, setScrubFrame] = useState<number | null>(null),
    [deleting, setDeleting] = useState<{ id: string; number: number; requestId: string } | null>(
      null,
    );
  const total = timelineFrames(timeline),
    scale = Math.max(40 / 30, width / Math.max(1, total)),
    length = total * scale;
  const cancelSeek = useCallback(() => {
    if (pendingSeek.current !== null) cancelAnimationFrame(pendingSeek.current);
    pendingSeek.current = null;
  }, []);
  const frameAt = useCallback(
    (x: number) => {
      const el = scroll.current;
      if (!el) return 0;
      return Math.max(
        0,
        Math.min(
          total - 1,
          Math.round((x - el.getBoundingClientRect().left + el.scrollLeft) / scale),
        ),
      );
    },
    [scale, total],
  );
  const previewAt = useCallback(
    (next: number) => {
      if (drag.current) drag.current.frame = next;
      setScrubFrame(next);
      cancelSeek();
      pendingSeek.current = requestAnimationFrame(() => {
        pendingSeek.current = null;
        playerRef.current?.seekTo(next);
      });
    },
    [cancelSeek, playerRef],
  );
  const playFrom = (next: number) => {
    cancelSeek();
    end.current = null;
    playerRef.current?.pause();
    playerRef.current?.seekTo(next);
    if (next < total - 1) void playerRef.current?.play();
  };
  const finish = (event: PointerEvent<HTMLDivElement>, resume: boolean) => {
    if (drag.current?.id !== event.pointerId) return;
    const next = drag.current.frame;
    drag.current = null;
    setDragging(false);
    setScrubFrame(null);
    cancelSeek();
    if (resume) playFrom(next);
    else playerRef.current?.seekTo(next);
  };
  useEffect(() => {
    drag.current = null;
    setDragging(false);
    setScrubFrame(null);
    return cancelSeek;
  }, [timeline.revision, cancelSeek]);
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
    if (playing && !drag.current) {
      const value = Math.max(0, Math.min(length - width, frame * scale - width / 2));
      el.scrollLeft = value;
      auto.current = el.scrollLeft;
      setLeft(el.scrollLeft);
      manualCursor.current = frame * scale - el.scrollLeft;
    }
  }, [frame, playing, total, scale, width, length, playerRef]);
  useEffect(() => {
    if (!dragging) return;
    let request: number;
    const move = () => {
      const el = scroll.current,
        pointer = drag.current;
      if (!el || !pointer) return;
      const rect = el.getBoundingClientRect();
      const step = pointer.x < rect.left + 24 ? -12 : pointer.x > rect.right - 24 ? 12 : 0;
      if (step) {
        const before = el.scrollLeft;
        el.scrollLeft += step;
        if (el.scrollLeft !== before) {
          auto.current = el.scrollLeft;
          setLeft(el.scrollLeft);
          previewAt(frameAt(pointer.x - pointer.grabOffset));
        }
      }
      request = requestAnimationFrame(move);
    };
    request = requestAnimationFrame(move);
    return () => cancelAnimationFrame(request);
  }, [dragging, frameAt, previewAt]);
  let offset = 0;
  const tickSeconds = Math.max(1, Math.ceil(width / scale / 30 / 8));
  const ticks = Array.from(
    { length: Math.floor(total / (30 * tickSeconds)) + 1 },
    (_, i) => i * 30 * tickSeconds,
  ).filter((f) => f * scale >= left - width && f * scale <= left + 2 * width);
  return (
    <section aria-label="主视频时间轴" className={`${common.panel} ${styles.timelinePanel}`}>
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
          aria-label="时间轴轨道"
          ref={scroll}
          onPointerDown={(event) => {
            // Keep native scrollbar interaction separate from seeking on the track.
            if (event.target !== event.currentTarget) return;
            playerRef.current?.pause();
            manualCursor.current = Math.max(
              0,
              Math.min(width, frame * scale - event.currentTarget.scrollLeft),
            );
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
              return;
            }
            playerRef.current?.pause();
            end.current = null;
            playerRef.current?.seekTo(
              Math.max(0, Math.min(total - 1, Math.round((x + manualCursor.current) / scale))),
            );
          }}
        >
          <div
            className={styles.clipTrack}
            style={{ width: length }}
            onPointerDown={(event) => {
              if (event.button !== 0 || !event.isPrimary || !playerRef.current) return;
              if ((event.target as HTMLElement).closest('[data-timeline-action]')) return;
              event.preventDefault();
              playerRef.current.pause();
              auto.current = null;
              end.current = null;
              const handle = (event.target as HTMLElement).closest('[role="slider"]');
              const grabOffset = handle
                ? event.clientX -
                  (scroll.current!.getBoundingClientRect().left +
                    frame * scale -
                    scroll.current!.scrollLeft)
                : 0;
              drag.current = { id: event.pointerId, x: event.clientX, grabOffset, frame };
              event.currentTarget.setPointerCapture(event.pointerId);
              if (handle) (handle as HTMLElement).focus({ preventScroll: true });
              setDragging(true);
              previewAt(frameAt(event.clientX - grabOffset));
            }}
            onPointerMove={(event) => {
              const pointer = drag.current;
              if (!pointer || pointer.id !== event.pointerId) return;
              pointer.x = event.clientX;
              previewAt(frameAt(event.clientX - pointer.grabOffset));
            }}
            onPointerUp={(event) => finish(event, true)}
            onPointerCancel={(event) => finish(event, false)}
            onLostPointerCapture={(event) => finish(event, false)}
          >
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
                      onClick={(event) => {
                        // Keyboard activation has no pointer position; start at this clip.
                        if (event.detail === 0) playFrom(start);
                      }}
                    >
                      Clip{i + 1} · {formatTimecode(clipFrames(c))}
                    </button>
                    <Button
                      className={styles.clipDelete}
                      aria-label={`删除Clip${i + 1}`}
                      data-timeline-action
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
            <div
              role="slider"
              tabIndex={0}
              aria-label="时间轴播放位置"
              aria-valuemin={0}
              aria-valuemax={total - 1}
              aria-valuenow={Math.min(total - 1, scrubFrame ?? frame)}
              aria-valuetext={formatTimecode(Math.min(total - 1, scrubFrame ?? frame))}
              className={styles.playhead}
              style={{ left: Math.min(total - 1, scrubFrame ?? frame) * scale }}
              onKeyDown={(event) => {
                let next = frame;
                const step = event.shiftKey ? 30 : 1;
                if (event.key === 'ArrowLeft') next -= step;
                else if (event.key === 'ArrowRight') next += step;
                else if (event.key === 'Home') next = 0;
                else if (event.key === 'End') next = total - 1;
                else return;
                event.preventDefault();
                end.current = null;
                playerRef.current?.pause();
                playerRef.current?.seekTo(Math.max(0, Math.min(total - 1, next)));
              }}
            />
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
