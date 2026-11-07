import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Player, type PlayerRef } from '@remotion/player';
import { Video } from '@remotion/media';
import { AbsoluteFill, Internals, Sequence } from 'remotion';
import {
  clipFrames,
  formatTimecode,
  timelineFrames,
  type FrameClip,
  type Timeline,
} from '@cev/shared';
import { useAuth } from '../stores/auth';
import { apiBaseUrl } from '../lib/runtime';
import { Button, EmptyState, Notice } from './ui';

type CompositionProps = { clips: FrameClip[]; token: string };
function Composition({ clips, token }: CompositionProps) {
  // Remotion 4.0.541 otherwise uses its process-wide media cache. Scope decoded
  // frames, audio and authenticated fetches to this composition's lifetime.
  const [resources] = useState(() => Internals.makeRenderResourceManager());
  const attached = useRef(false);
  useEffect(() => {
    attached.current = true;
    return () => {
      attached.current = false;
      queueMicrotask(() => {
        if (!attached.current) resources.dispose();
      });
    };
  }, [resources]);
  let offset = 0;
  return (
    <Internals.RenderResourceManagerContext.Provider value={resources}>
      <Internals.MaxMediaCacheSizeContext.Provider value={256 * 1024 * 1024}>
        <AbsoluteFill style={{ backgroundColor: 'black' }}>
          {clips.map((c) => {
            const from = offset;
            offset += clipFrames(c);
            return (
              <Sequence key={c.id} from={from} durationInFrames={clipFrames(c)} premountFor={30}>
                <Video
                  src={`${apiBaseUrl()}/media/${c.source}/content?generation=${c.generation}`}
                  requestInit={{ headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' }}
                  trimBefore={c.startFrame}
                  durationInFrames={clipFrames(c)}
                  disallowFallbackToOffthreadVideo
                  objectFit="contain"
                  style={{ width: '100%', height: '100%' }}
                />
              </Sequence>
            );
          })}
        </AbsoluteFill>
      </Internals.MaxMediaCacheSizeContext.Provider>
    </Internals.RenderResourceManagerContext.Provider>
  );
}
export function TimelinePlayer({
  timeline,
  playerRef,
  onFrame,
  onPlaying,
  stopAt,
  standalone = false,
}: {
  timeline: Timeline;
  playerRef?: RefObject<PlayerRef | null>;
  onFrame?: (frame: number) => void;
  onPlaying?: (playing: boolean) => void;
  stopAt?: RefObject<number | null>;
  standalone?: boolean;
}) {
  const own = useRef<PlayerRef>(null),
    ref = playerRef ?? own;
  const token = useAuth((s) => s.token);
  const [frame, setFrame] = useState(0),
    [playing, setPlaying] = useState(false),
    [buffering, setBuffering] = useState(false),
    [volume, setVolume] = useState(1),
    [rate, setRate] = useState(1),
    [retry, setRetry] = useState(0);
  const total = timelineFrames(timeline),
    canvas = timeline.canvas ?? { width: 1920, height: 1080 };
  const inputs = useMemo(
    () => ({ clips: timeline.clips, token: token ?? '' }),
    [timeline.clips, token],
  );
  useEffect(() => {
    const player = ref.current;
    if (!player) return;
    setFrame(player.getCurrentFrame());
    setPlaying(player.isPlaying());
    onFrame?.(player.getCurrentFrame());
    onPlaying?.(player.isPlaying());
    if (stopAt) stopAt.current = null;
    const update = (e: { detail: { frame: number } }) => {
      setFrame(e.detail.frame);
      onFrame?.(e.detail.frame);
    };
    const play = () => {
      setPlaying(true);
      onPlaying?.(true);
    };
    const pause = () => {
      setPlaying(false);
      onPlaying?.(false);
    };
    const waiting = () => setBuffering(true),
      ready = () => setBuffering(false);
    player.addEventListener('frameupdate', update);
    player.addEventListener('play', play);
    player.addEventListener('pause', pause);
    player.addEventListener('ended', pause);
    player.addEventListener('waiting', waiting);
    player.addEventListener('resume', ready);
    return () => {
      player.removeEventListener('frameupdate', update);
      player.removeEventListener('play', play);
      player.removeEventListener('pause', pause);
      player.removeEventListener('ended', pause);
      player.removeEventListener('waiting', waiting);
      player.removeEventListener('resume', ready);
    };
  }, [ref, total, timeline.revision, retry, onFrame, onPlaying, token, stopAt]);
  if (!total || !token)
    return (
      <div className="preview-surface">
        <EmptyState title="添加片段后在此预览主视频" />
      </div>
    );
  return (
    <div className="timeline-player">
      <Player
        key={`${token}-${timeline.revision}-${retry}`}
        ref={ref}
        component={Composition}
        inputProps={inputs}
        durationInFrames={total}
        compositionWidth={canvas.width}
        compositionHeight={canvas.height}
        fps={30}
        style={{
          width: '100%',
          maxHeight: standalone ? '65vh' : '38vh',
          aspectRatio: `${canvas.width}/${canvas.height}`,
          background: 'black',
          margin: '0 auto',
        }}
        controls={false}
        playbackRate={rate}
        initialVolume={volume}
        acknowledgeRemotionLicense
        errorFallback={({ error }) => (
          <div className="playback-error">
            <Notice kind="error">预览加载失败：{error.message}</Notice>
            <Button onClick={() => setRetry((n) => n + 1)}>重试播放</Button>
          </div>
        )}
      />
      {buffering && <small role="status">正在缓冲…</small>}
      <input
        aria-label="播放进度"
        type="range"
        min={0}
        max={Math.max(0, total - 1)}
        value={Math.min(frame, total - 1)}
        onChange={(e) => {
          if (stopAt) stopAt.current = null;
          ref.current?.pause();
          ref.current?.seekTo(Number(e.target.value));
        }}
      />
      <div className="player-controls">
        <Button
          onClick={() => {
            if (stopAt) stopAt.current = null;
            if (playing) ref.current?.pause();
            else {
              if (frame >= total - 1) ref.current?.seekTo(0);
              void ref.current?.play();
            }
          }}
        >
          {playing ? '暂停' : '播放全部'}
        </Button>
        <span className="timecode">
          {formatTimecode(Math.min(frame, total - 1))} / {formatTimecode(total)}
        </span>
        <select
          aria-label="播放倍速"
          className="push-right"
          value={rate}
          onChange={(e) => setRate(Number(e.target.value))}
        >
          {[0.5, 0.75, 1, 1.25, 1.5, 2].map((n) => (
            <option key={n} value={n}>
              {n.toFixed(2).replace(/0$/, '')}×
            </option>
          ))}
        </select>
        <label>
          音量{' '}
          <input
            aria-label="播放音量"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={volume}
            onChange={(e) => {
              const v = Number(e.target.value);
              setVolume(v);
              ref.current?.setVolume(v);
            }}
          />
        </label>
        {standalone && <Button onClick={() => ref.current?.requestFullscreen()}>全屏</Button>}
      </div>
      <small className="muted">
        {canvas.width} × {canvas.height} · 30 帧/秒 · 原声 · 播放音量不改变导出音量
      </small>
    </div>
  );
}
