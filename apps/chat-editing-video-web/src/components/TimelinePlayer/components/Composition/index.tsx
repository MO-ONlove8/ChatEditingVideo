import styles from './index.module.less';
import { useEffect, useRef, useState } from 'react';
import { Video } from '@remotion/media';
import { AbsoluteFill, Internals, Sequence } from 'remotion';
import { clipFrames, type FrameClip } from '@cev/shared';
import { apiBaseUrl } from '../../../../lib/runtime';

type CompositionProps = { clips: FrameClip[]; token: string; onError?: (error: Error) => void };

export function Composition({ clips, token, onError }: CompositionProps) {
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
        <AbsoluteFill className={styles.composition}>
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
        </AbsoluteFill>
      </Internals.MaxMediaCacheSizeContext.Provider>
    </Internals.RenderResourceManagerContext.Provider>
  );
}
