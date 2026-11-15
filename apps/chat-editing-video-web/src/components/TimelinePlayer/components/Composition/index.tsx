import styles from './index.module.less';
import { useEffect, useRef, useState } from 'react';
import { Video, Audio } from '@remotion/media';
import { Input, UrlSource, MP4, AudioSampleSink } from 'mediabunny';
import { AbsoluteFill, Internals, Sequence, useCurrentFrame } from 'remotion';
import { clipFrames, type FrameClip, type CompositionManifest } from '@cev/shared';
import { apiBaseUrl } from '../../../../lib/runtime';
import { useTransfers } from '../../../../lib/media-upload';
import { getLocalMedia } from '../../../../lib/local-media';

type CompositionProps = {
  clips: FrameClip[];
  token: string;
  projectId?: string;
  manifest?: CompositionManifest;
  onReady?: () => void;
  onError?: (error: Error) => void;
};

function Layer({ source, token, onReady }: { source: string; token: string; onReady: () => void }) {
  const [url, setUrl] = useState<string>(),
    [error, setError] = useState<Error>();
  useEffect(() => {
    const abort = new AbortController();
    let blobUrl: string | undefined;
    void fetch(source, { headers: { Authorization: `Bearer ${token}` }, signal: abort.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error('图文资源读取失败');
        return r.blob();
      })
      .then((blob) => {
        if (abort.signal.aborted) return;
        blobUrl = URL.createObjectURL(blob);
        setUrl(blobUrl);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e as Error);
      });
    return () => {
      abort.abort();
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [source, token]);
  if (error) throw error;
  return url ? (
    <img
      src={url}
      onLoad={onReady}
      alt=""
      style={{ width: '100%', height: '100%' }}
      onError={() => setError(new Error('图文图片解码失败，请重试'))}
    />
  ) : null;
}

export function Composition({
  clips,
  token,
  onError,
  manifest,
  projectId,
  onReady,
}: CompositionProps) {
  const frame = useCurrentFrame(),
    [resourceError, setResourceError] = useState<Error>(),
    [videoReady, setVideoReady] = useState(false),
    [audioReady, setAudioReady] = useState(!manifest),
    [images, setImages] = useState<Set<string>>(() => new Set());
  const resource = (key: string) =>
    `${apiBaseUrl()}/projects/${projectId}/composition-resource?key=${encodeURIComponent(key)}`;
  useEffect(() => {
    if (!manifest || !projectId) return;
    let disposed = false;
    const input = new Input({
      formats: [MP4],
      source: new UrlSource(resource(manifest.audioKey), {
        requestInit: { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' },
        maxCacheSize: 2 * 1024 * 1024,
        getRetryDelay: () => null,
      }),
    });
    void (async () => {
      const track = await input.getPrimaryAudioTrack();
      if (!track || !(await track.canDecode())) throw new Error('完整混音无法解码，请重试');
      const sample = await new AudioSampleSink(track).getSample(0);
      if (!sample) throw new Error('完整混音没有可播放样本');
      sample.close();
      if (!disposed) setAudioReady(true);
    })().catch((e) => {
      if (!disposed) setResourceError(e as Error);
    });
    return () => {
      disposed = true;
      input.dispose();
    };
  }, [manifest?.hash, projectId, token]);
  useEffect(() => {
    if (
      videoReady &&
      audioReady &&
      (manifest?.overlays
        .filter((o) => o.startFrame <= frame && o.endFrame >= frame)
        .every((o) => images.has(o.key)) ??
        true)
    )
      onReady?.();
  }, [videoReady, audioReady, images, manifest?.hash, frame, onReady]);
  const transfers = useTransfers((s) => s.items);
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
  if (resourceError) throw resourceError;
  let offset = 0;
  return (
    <Internals.RenderResourceManagerContext.Provider value={resources}>
      <Internals.MaxMediaCacheSizeContext.Provider value={256 * 1024 * 1024}>
        <AbsoluteFill className={styles.composition}>
          {clips.map((c) => {
            const transfer = transfers.find(
              (t) =>
                t.asset?.id === c.source &&
                t.asset.generation === c.generation &&
                t.asset.editing?.kind === 'original',
            );
            const localUrl = transfer && getLocalMedia(transfer.id)?.url;
            const from = offset;
            offset += clipFrames(c);
            return (
              <Sequence key={c.id} from={from} durationInFrames={clipFrames(c)} premountFor={30}>
                <Video
                  src={
                    localUrl ??
                    `${apiBaseUrl()}/media/${c.source}/content?generation=${c.generation}`
                  }
                  requestInit={
                    localUrl
                      ? undefined
                      : { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' }
                  }
                  trimBefore={c.startFrame}
                  muted={Boolean(manifest)}
                  onVideoFrame={() => setVideoReady(true)}
                  durationInFrames={clipFrames(c)}
                  disallowFallbackToOffthreadVideo
                  onError={
                    onError
                      ? (error) => {
                          onError(error);
                          // Let the host unmount a failed player instead of throwing from
                          // an async decoder callback. Native fallback stays disabled.
                          return 'fallback';
                        }
                      : undefined
                  }
                  objectFit="contain"
                  className={styles.video}
                />
              </Sequence>
            );
          })}
          {manifest && projectId && (
            <>
              <Audio
                src={resource(manifest.audioKey)}
                requestInit={{ headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' }}
                disallowFallbackToHtml5Audio
                onError={
                  onError
                    ? (error) => {
                        onError(error);
                        return 'fallback';
                      }
                    : undefined
                }
              />
              {manifest.overlays
                .filter((o) => o.startFrame <= frame + 30 && o.endFrame >= frame - 30)
                .map((o) => (
                  <Sequence
                    key={o.key}
                    from={o.startFrame}
                    durationInFrames={o.endFrame - o.startFrame + 1}
                  >
                    <div
                      style={{
                        position: 'absolute',
                        left: Math.round(o.x),
                        top: Math.round(o.y),
                        width: o.width,
                        height: o.height,
                      }}
                    >
                      <Layer
                        source={resource(o.key)}
                        token={token}
                        onReady={() =>
                          setImages((old) => (old.has(o.key) ? old : new Set([...old, o.key])))
                        }
                      />
                    </div>
                  </Sequence>
                ))}
            </>
          )}
        </AbsoluteFill>
      </Internals.MaxMediaCacheSizeContext.Provider>
    </Internals.RenderResourceManagerContext.Provider>
  );
}
