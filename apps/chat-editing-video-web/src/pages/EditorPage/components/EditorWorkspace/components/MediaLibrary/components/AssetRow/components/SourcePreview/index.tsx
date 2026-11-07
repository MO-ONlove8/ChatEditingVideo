import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Player, type PlayerRef } from '@remotion/player';
import { formatTimecode, type MediaAsset } from '@cev/shared';
import { useAuth } from '../../../../../../../../../../stores/auth';
import { Composition } from '../../../../../../../../../../components/TimelinePlayer/components/Composition';
import { Button } from '../../../../../../../../../../components/Button';
import styles from './index.module.less';

export function SourcePreview({
  asset,
  frame,
  playing,
  onFrame,
  onPlaying,
  onClose,
}: {
  asset: MediaAsset;
  frame: number;
  playing: boolean;
  onFrame: (frame: number) => void;
  onPlaying: (playing: boolean) => void;
  onClose: () => void;
}) {
  const player = useRef<PlayerRef>(null);
  const token = useAuth((s) => s.token);
  const [retry, setRetry] = useState(0);
  const [buffering, setBuffering] = useState(false);
  const [error, setError] = useState<Error>();
  const reportError = useCallback(
    (error: Error) => {
      onPlaying(false);
      setBuffering(false);
      setError(error);
    },
    [onPlaying],
  );
  const media = asset.normalized!;
  const total = media.frameCount!;
  const inputs = useMemo(
    () => ({
      token: token ?? '',
      onError: reportError,
      clips: [
        {
          id: asset.id,
          source: asset.id,
          generation: asset.generation,
          startFrame: 0,
          endFrame: total - 1,
        },
      ],
    }),
    [asset.id, asset.generation, total, token, reportError],
  );
  useEffect(() => {
    const instance = player.current;
    if (!instance) return;
    const update = (event: { detail: { frame: number } }) => {
      // Paused seek events can arrive after a newer pointer position has been selected.
      if (playing && instance.isPlaying()) onFrame(event.detail.frame);
    };
    const pause = () => onPlaying(false);
    const ended = () => {
      // Remotion also emits ended before seeking to the last frame while paused.
      if (playing) {
        onFrame(total - 1);
        onPlaying(false);
      }
    };
    const waiting = () => setBuffering(true);
    const ready = () => setBuffering(false);
    instance.addEventListener('frameupdate', update);
    instance.addEventListener('ended', ended);
    instance.addEventListener('error', pause);
    instance.addEventListener('waiting', waiting);
    instance.addEventListener('resume', ready);
    return () => {
      instance.removeEventListener('frameupdate', update);
      instance.removeEventListener('ended', ended);
      instance.removeEventListener('error', pause);
      instance.removeEventListener('waiting', waiting);
      instance.removeEventListener('resume', ready);
    };
  }, [onFrame, onPlaying, playing, retry, token, error, total]);
  useEffect(() => {
    const instance = player.current;
    if (!instance) return;
    if (playing) instance.play();
    else instance.pause();
  }, [playing, retry, onPlaying]);
  useEffect(() => {
    if (playing || player.current?.getCurrentFrame() === frame) return;
    // Coalesce pointer movement to one seek per browser frame.
    const request = requestAnimationFrame(() => player.current?.seekTo(frame));
    return () => cancelAnimationFrame(request);
  }, [frame, playing, retry]);
  const failure = (
    <div className={styles.error} role="alert">
      <span>素材预览加载失败</span>
      <Button
        onClick={() => {
          onPlaying(false);
          setBuffering(false);
          setError(undefined);
          setRetry((n) => n + 1);
        }}
      >
        重试预览
      </Button>
    </div>
  );
  return (
    <section className={styles.preview} aria-label={`V${asset.number} 素材预览`}>
      {error
        ? failure
        : token && (
            <Player
              key={`${token}-${retry}`}
              ref={player}
              component={Composition}
              inputProps={inputs}
              durationInFrames={total}
              compositionWidth={media.width}
              compositionHeight={media.height}
              fps={30}
              initialFrame={frame}
              className={styles.player}
              style={{ width: '100%', height: '100%' }}
              controls={false}
              acknowledgeRemotionLicense
              errorFallback={() => failure}
            />
          )}
      {buffering && (
        <span className={styles.buffering} role="status">
          正在缓冲…
        </span>
      )}
      <div className={styles.controls}>
        <Button
          aria-label={playing ? '暂停素材预览' : '播放素材预览'}
          disabled={Boolean(error)}
          onClick={() => {
            if (!playing && frame >= total - 1) {
              player.current?.seekTo(0);
              onFrame(0);
            }
            onPlaying(!playing);
          }}
        >
          {playing ? '暂停' : '播放'}
        </Button>
        <code>
          {formatTimecode(frame)} / {formatTimecode(total)}
        </code>
        <Button aria-label="关闭素材预览" onClick={onClose}>
          ×
        </Button>
      </div>
    </section>
  );
}
