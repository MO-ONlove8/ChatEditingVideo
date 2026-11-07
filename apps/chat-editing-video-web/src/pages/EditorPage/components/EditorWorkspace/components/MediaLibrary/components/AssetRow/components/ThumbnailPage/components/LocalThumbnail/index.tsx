import { useEffect, useRef, useState } from 'react';
import { getLocalMedia } from '../../../../../../../../../../../../lib/local-media';
import styles from './index.module.less';

export function LocalThumbnail({ localId, second }: { localId: string; second: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState(false);
  useEffect(() => {
    const element = ref.current;
    const source = getLocalMedia(localId);
    if (!element || !source) return;
    let abort: AbortController | undefined;
    let currentUrl: string | undefined;
    const observer = new IntersectionObserver(
      ([entry]) => {
        abort?.abort();
        if (!entry?.isIntersecting) {
          if (currentUrl) URL.revokeObjectURL(currentUrl);
          currentUrl = undefined;
          setUrl(undefined);
          return;
        }
        const controller = new AbortController();
        abort = controller;
        void source
          .thumbnail(second, controller.signal)
          .then((blob) => {
            if (controller.signal.aborted) return;
            if (currentUrl) URL.revokeObjectURL(currentUrl);
            currentUrl = URL.createObjectURL(blob);
            setUrl(currentUrl);
            setError(false);
          })
          .catch(() => {
            if (!controller.signal.aborted) setError(true);
          });
      },
      { rootMargin: '0px 320px' },
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
      abort?.abort();
      if (currentUrl) URL.revokeObjectURL(currentUrl);
    };
  }, [localId, second]);
  return (
    <span
      ref={ref}
      className={styles.thumbnail}
      data-testid="local-thumbnail"
      data-loaded={Boolean(url)}
      style={url ? { backgroundImage: `url(${url})` } : undefined}
    >
      {error ? '画面暂不可用' : ''}
    </span>
  );
}
