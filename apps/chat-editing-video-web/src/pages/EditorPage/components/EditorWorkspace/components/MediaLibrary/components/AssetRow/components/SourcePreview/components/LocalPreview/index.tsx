import { useEffect, useRef, useState } from 'react';
import { formatTimecode, type MediaAsset, type MediaInfo } from '@cev/shared';
import { Button } from '../../../../../../../../../../../../components/Button';
import styles from './index.module.less';

export function LocalPreview({
  asset,
  info,
  url,
  frame,
  playing,
  onFrame,
  onPlaying,
  onClose,
}: {
  asset: MediaAsset;
  info: MediaInfo;
  url: string;
  frame: number;
  playing: boolean;
  onFrame: (frame: number) => void;
  onPlaying: (playing: boolean) => void;
  onClose: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const target = useRef(frame);
  target.current = frame;
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    const element = video.current;
    if (!element || !ready) return;
    if (playing) {
      if (element.ended) {
        element.currentTime = 0;
        onFrame(0);
      }
      void element.play().catch(() => {
        onPlaying(false);
        setError(true);
      });
    } else element.pause();
  }, [playing, ready, onFrame, onPlaying]);
  useEffect(() => {
    const element = video.current;
    if (!element || !ready || playing) return;
    const request = requestAnimationFrame(() => {
      const time = target.current / 30;
      if (Math.abs(element.currentTime - time) > 1 / 120) element.currentTime = time;
    });
    return () => cancelAnimationFrame(request);
  }, [frame, playing, ready]);
  useEffect(() => {
    if (!playing || !ready) return;
    let request = 0;
    const tick = () => {
      const element = video.current;
      if (element && !element.paused)
        onFrame(Math.min(info.frameCount! - 1, Math.floor(element.currentTime * 30)));
      request = requestAnimationFrame(tick);
    };
    request = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(request);
  }, [playing, ready, onFrame, info.frameCount]);
  return (
    <section className={styles.preview} aria-label={`V${asset.number} 素材预览`}>
      <video
        ref={video}
        src={url}
        className={styles.video}
        preload="auto"
        playsInline
        onLoadedMetadata={() => {
          if (video.current) video.current.currentTime = target.current / 30;
          setReady(true);
        }}
        onEnded={() => {
          onFrame(info.frameCount! - 1);
          onPlaying(false);
        }}
        onError={() => {
          setError(true);
          onPlaying(false);
        }}
      />
      {error && (
        <div className={styles.error} role="alert">
          本地预览暂不可用，请等待上传处理完成后重试
        </div>
      )}
      <div className={styles.controls}>
        <Button
          disabled={!ready || error}
          aria-label={playing ? '暂停素材预览' : '播放素材预览'}
          onClick={() => {
            if (!playing && frame >= info.frameCount! - 1) {
              if (video.current) video.current.currentTime = 0;
              onFrame(0);
            }
            onPlaying(!playing);
          }}
        >
          {playing ? '暂停' : '播放'}
        </Button>
        <code>
          {formatTimecode(frame)} / {formatTimecode(info.frameCount!)}
        </code>
        <Button aria-label="关闭素材预览" onClick={onClose}>
          ×
        </Button>
      </div>
    </section>
  );
}
