import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { formatTimecode, type MediaAsset, type MediaInfo } from '@cev/shared';
import { Button } from '../../../../../../../../../../components/Button';
import { ThumbnailPage } from '../ThumbnailPage';
import { SourcePreview } from '../SourcePreview';
import styles from './index.module.less';

const PIXELS_PER_SECOND = 160;

export function AssetScrubber({
  asset,
  onSelect,
  info,
  localId,
}: {
  asset: MediaAsset;
  onSelect?: (second: number) => void;
  info: MediaInfo;
  localId?: string;
}) {
  const strip = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const pointer = useRef<{
    id: number;
    startX: number;
    startOffset: number;
    dragging: boolean;
  } | null>(null);
  const syncedOffset = useRef(0);
  const suppressClick = useRef(false);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [open, setOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 360, height: 246 });
  const total = info.frameCount!;
  const pixels = (frame / 30) * PIXELS_PER_SECOND;
  useLayoutEffect(() => {
    if (frame >= total) {
      setFrame(total - 1);
      setPlaying(false);
    }
  }, [frame, total]);
  const close = useCallback(() => {
    pointer.current = null;
    setDragging(false);
    setOpen(false);
    setPlaying(false);
  }, []);
  const seek = useCallback(
    (offset: number) => {
      const bounded = Math.max(0, Math.min(((total - 1) / 30) * PIXELS_PER_SECOND, offset));
      if (strip.current) {
        strip.current.scrollLeft = bounded;
        syncedOffset.current = strip.current.scrollLeft;
      }
      setFrame(Math.round((bounded / PIXELS_PER_SECOND) * 30));
      setPlaying(false);
      setOpen(true);
    },
    [total],
  );
  const locate = useCallback(() => {
    const element = strip.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    let visibleTop = 0,
      visibleBottom = window.innerHeight;
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (!/(auto|scroll|hidden)/.test(getComputedStyle(parent).overflowY)) continue;
      const bounds = parent.getBoundingClientRect();
      visibleTop = Math.max(visibleTop, bounds.top);
      visibleBottom = Math.min(visibleBottom, bounds.bottom);
    }
    if (rect.bottom <= visibleTop || rect.top >= visibleBottom) {
      close();
      return;
    }
    const width = Math.min(360, window.innerWidth - 24);
    const height = (width * 9) / 16 + 44;
    const x = rect.left + element.clientWidth / 2;
    setPosition({
      left: Math.max(12, Math.min(window.innerWidth - width - 12, x - width / 2)),
      top: Math.max(12, rect.top - height - 12),
      width,
      height,
    });
  }, [close]);
  useLayoutEffect(() => {
    if (open) locate();
  }, [open, locate]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: globalThis.PointerEvent) => {
      const target = event.target as Node;
      if (!root.current?.contains(target) && !popup.current?.contains(target)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close();
        if (popup.current?.contains(document.activeElement))
          root.current?.querySelector<HTMLElement>('[role="slider"]')?.focus();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    window.addEventListener('resize', locate);
    window.addEventListener('scroll', locate, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
      window.removeEventListener('resize', locate);
      window.removeEventListener('scroll', locate, true);
    };
  }, [open, locate, close]);
  useLayoutEffect(() => {
    const element = strip.current;
    if (!element || pointer.current?.dragging) return;
    // Keep the chosen frame under the fixed center line, including during playback.
    element.scrollLeft = pixels;
    syncedOffset.current = element.scrollLeft;
  }, [pixels, dragging]);
  const finish = (event: PointerEvent<HTMLDivElement>) => {
    if (pointer.current?.id !== event.pointerId) return;
    if (pointer.current.dragging) suppressClick.current = true;
    pointer.current = null;
    setDragging(false);
  };
  return (
    <div ref={root} className={styles.scrubber}>
      <div className={styles.toolbar}>
        <small>左右拖动素材预览 · {formatTimecode(frame)}</small>
        <Button
          aria-label={`播放素材 V${asset.number}`}
          onClick={() => {
            strip.current?.scrollIntoView({
              block: 'nearest',
              inline: 'nearest',
              behavior: 'instant',
            });
            if (frame >= total - 1) setFrame(0);
            setOpen(true);
            setPlaying(true);
          }}
        >
          播放素材
        </Button>
      </div>
      <div
        className={`${styles.viewport} ${dragging ? styles.dragging : ''}`}
        onPointerDown={(event) => {
          if (event.button !== 0 || !event.isPrimary) return;
          suppressClick.current = false;
          pointer.current = {
            id: event.pointerId,
            startX: event.clientX,
            startOffset: strip.current?.scrollLeft ?? 0,
            dragging: false,
          };
        }}
        onPointerMove={(event) => {
          const drag = pointer.current;
          if (!drag || drag.id !== event.pointerId) return;
          if (!drag.dragging && Math.abs(event.clientX - drag.startX) < 4) return;
          drag.dragging = true;
          event.currentTarget.setPointerCapture(event.pointerId);
          event.preventDefault();
          setDragging(true);
          seek(drag.startOffset + drag.startX - event.clientX);
        }}
        onPointerUp={finish}
        onPointerCancel={finish}
        onLostPointerCapture={finish}
        onClickCapture={(event) => {
          if (!suppressClick.current) return;
          suppressClick.current = false;
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <div
          ref={strip}
          className={styles.strip}
          aria-label={`V${asset.number} 逐秒缩略图`}
          onScroll={() => {
            const offset = strip.current?.scrollLeft ?? 0;
            // Programmatic scrolling follows playback; wheel/trackpad scrolling seeks.
            if (Math.abs(offset - syncedOffset.current) > 1) seek(offset);
          }}
        >
          <div className={styles.spacer} aria-hidden="true" />
          <div
            className={styles.track}
            style={{ width: Math.ceil(total / 30) * PIXELS_PER_SECOND }}
          >
            {Array.from({ length: Math.ceil(total / 900) }, (_, page) => (
              <ThumbnailPage
                key={page}
                asset={asset}
                page={page}
                total={total}
                localId={localId}
                onSelect={(second) => {
                  setFrame(Math.min(total - 1, second * 30));
                  setPlaying(false);
                  if (onSelect) onSelect(second);
                  else setOpen(true);
                }}
              />
            ))}
          </div>
          <div className={styles.spacer} aria-hidden="true" />
        </div>
        <div
          role="slider"
          tabIndex={0}
          aria-label={`V${asset.number} 素材播放位置`}
          aria-valuemin={0}
          aria-valuemax={total - 1}
          aria-valuenow={frame}
          aria-valuetext={formatTimecode(frame)}
          className={styles.playhead}
          onKeyDown={(event) => {
            let next = frame;
            const step = event.shiftKey ? 30 : 1;
            if (event.key === 'ArrowLeft') next -= step;
            else if (event.key === 'ArrowRight') next += step;
            else if (event.key === 'Home') next = 0;
            else if (event.key === 'End') next = total - 1;
            else return;
            event.preventDefault();
            setFrame(Math.max(0, Math.min(total - 1, next)));
            setPlaying(false);
            setOpen(true);
          }}
        />
      </div>
      {open &&
        createPortal(
          <div ref={popup} className={styles.popup} style={position}>
            <SourcePreview
              asset={asset}
              localId={localId}
              info={info}
              frame={frame}
              playing={playing}
              onFrame={setFrame}
              onPlaying={setPlaying}
              onClose={close}
            />
          </div>,
          document.body,
        )}
    </div>
  );
}
