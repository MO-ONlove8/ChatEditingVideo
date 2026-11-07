import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiRoutes, ImageIndexSchema, formatTimecode, type MediaAsset } from '@cev/shared';
import { api } from '../../../../../../../../../../lib/api';
import { Button } from '../../../../../../../../../../components/Button';
import { useBlob } from '../../../../hooks/useBlob';
import styles from './index.module.less';

export function ThumbnailPage({
  asset,
  page,
  onSelect,
}: {
  asset: MediaAsset;
  page: number;
  onSelect: (second: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!ref.current) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry!.isIntersecting), {
      rootMargin: '500px',
    });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  const index = useQuery({
    queryKey: ['thumbnails', asset.id, asset.generation, page],
    queryFn: ({ signal }) =>
      api(ImageIndexSchema, ApiRoutes.thumbnails(asset.id, page), { signal }),
    enabled: visible,
  });
  const sprite = useBlob(index.data?.sprite?.path, visible);
  const count = Math.min(30, Math.ceil((asset.normalized!.frameCount! - page * 900) / 30));
  return (
    <div ref={ref} className={styles.thumbnailPage} style={{ width: count * 160 }}>
      {Array.from({ length: count }, (_, i) => (
        <button
          key={i}
          className={styles.secondThumbnail}
          aria-label={`V${asset.number} 第 ${page * 30 + i} 秒`}
          onClick={() => onSelect(page * 30 + i)}
        >
          <span
            data-testid="sprite-cell"
            className={styles.spriteCell}
            style={
              sprite?.url
                ? {
                    backgroundImage: `url(${sprite.url})`,
                    backgroundPosition: `${-(i % 10) * 160}px ${-Math.floor(i / 10) * 90}px`,
                  }
                : {}
            }
          />
          <small>{formatTimecode((page * 30 + i) * 30)}</small>
        </button>
      ))}
      {(index.error || sprite?.error) && (
        <span className={styles.thumbnailError}>
          缩略图加载失败{' '}
          <Button
            onClick={() => {
              sprite.retry();
              void index.refetch();
            }}
          >
            重试
          </Button>
        </span>
      )}
    </div>
  );
}
