import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApiRoutes,
  ImageIndexSchema,
  MediaAssetSchema,
  formatTimecode,
  type MediaAsset,
} from '@cev/shared';
import { api, apiFetch } from '../../../../../../../../lib/api';
import { Button } from '../../../../../../../../components/Button';
import { ConfirmDialog } from '../../../../../../../../components/ConfirmDialog';
import { Notice } from '../../../../../../../../components/Notice';
import { FramePreview } from '../../../../../../../../components/FramePreview';
import { MediaProcessingState } from '../../../../../../../../components/MediaProcessingState';
import { useBlob } from '../../hooks/useBlob';
import { AssetScrubber } from './components/AssetScrubber';
import { FrameImage } from './components/FrameImage';
import styles from './index.module.less';
import common from '../../../../../../../../styles/common.module.less';

export function AssetRow({ asset }: { asset: MediaAsset }) {
  const [second, setSecond] = useState<number>();
  const [frame, setFrame] = useState<number>();
  const [deleting, setDeleting] = useState(false);
  const qc = useQueryClient();
  const frames = useQuery({
    queryKey: ['frames', asset.id, asset.generation, second],
    queryFn: ({ signal }) => api(ImageIndexSchema, ApiRoutes.frames(asset.id, second!), { signal }),
    enabled: second !== undefined && asset.status === 'ready',
    refetchInterval: (q) => (q.state.data?.status === 'processing' ? 500 : false),
  });
  const large = useBlob(frame === undefined ? undefined : ApiRoutes.frameImage(asset.id, frame));
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['media'] });
    await qc.invalidateQueries({ queryKey: ['tasks'] });
    await qc.invalidateQueries({ queryKey: ['editor'] });
  };
  return (
    <div
      className={styles.assetRow}
      onBlur={(event) => {
        if (
          !event.currentTarget.contains(event.relatedTarget as Node | null) &&
          frame === undefined
        )
          setSecond(undefined);
      }}
    >
      <div className={`${common.row} ${common.between}`}>
        <strong>
          V{asset.number} <span className={common.muted}>{asset.fileName}</span>
        </strong>
        <div className={common.row}>
          <small>
            {asset.normalized
              ? formatTimecode(asset.normalized.frameCount!)
              : `${Math.round(asset.sizeBytes / 1024 / 1024)} MB`}
          </small>
          <Button onClick={() => setDeleting(true)}>
            {asset.deleting ? '重试删除' : `删除素材 V${asset.number}`}
          </Button>
        </div>
      </div>
      {asset.deleting ? (
        <Notice kind="error">{asset.error ?? '删除未完成，请重试删除'}</Notice>
      ) : asset.status !== 'ready' ? (
        <>
          <MediaProcessingState
            source={`V${asset.number}`}
            status={asset.status === 'failed' ? 'failed' : 'processing'}
            reason={asset.error ?? undefined}
            onRetry={async () => {
              await api(MediaAssetSchema, ApiRoutes.mediaRetry(asset.id), { method: 'POST' });
              await refresh();
            }}
            onDelete={async () => setDeleting(true)}
          />
          {asset.status !== 'failed' && (
            <p role="status">
              {asset.stage} · {asset.progress}% <progress max={100} value={asset.progress} />
            </p>
          )}
        </>
      ) : (
        <>
          <AssetScrubber asset={asset} onSelect={setSecond} />
          {second !== undefined && (
            <div className={styles.expandedFrames}>
              <div className={`${common.row} ${common.between}`}>
                <strong>
                  第 {second} 秒 · 帧编号 0～
                  {Math.min(29, asset.normalized!.frameCount! - second * 30 - 1)}
                </strong>
                <Button onClick={() => setSecond(undefined)}>收起帧图</Button>
              </div>
              {frames.error ? (
                <Notice kind="error">
                  {frames.error.message}{' '}
                  <Button onClick={() => void frames.refetch()}>重试帧图</Button>
                </Notice>
              ) : frames.data?.status !== 'ready' ? (
                <p role="status">正在生成帧图…</p>
              ) : (
                <div className={styles.framesStrip}>
                  {frames.data.images.map((image) => (
                    <FrameImage
                      key={image.frame}
                      path={image.path}
                      frame={image.frame}
                      onSelect={() => setFrame(image.frame)}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
      {frame !== undefined && (
        <FramePreview
          open
          onClose={() => setFrame(undefined)}
          source={`V${asset.number}`}
          frame={frame}
          imageUrl={large?.url ?? ''}
          loading={!large?.url && !large?.error}
          error={large?.error}
          onRetry={large.retry}
        />
      )}
      <ConfirmDialog
        open={deleting}
        title={`删除素材 V${asset.number}？`}
        onClose={() => setDeleting(false)}
        onConfirm={async () => {
          try {
            await apiFetch(ApiRoutes.media(asset.id), { method: 'DELETE' });
          } finally {
            await refresh();
          }
        }}
      >
        <p>将删除「{asset.fileName}」及其处理结果，删除后不可恢复。</p>
      </ConfirmDialog>
    </div>
  );
}
