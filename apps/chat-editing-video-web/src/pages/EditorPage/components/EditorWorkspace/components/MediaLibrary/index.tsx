import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiRoutes, MediaPolicySchema, type MediaAsset } from '@cev/shared';
import { api } from '../../../../../../lib/api';
import {
  prepareUploads,
  selectVideos,
  useTransfers,
  type Transfer,
} from '../../../../../../lib/media-upload';
import { Button } from '../../../../../../components/Button';
import { Notice } from '../../../../../../components/Notice';
import { useMedia } from './hooks/useMedia';
import { AssetRow } from './components/AssetRow';
import common from '../../../../../../styles/common.module.less';
import styles from './index.module.less';

export function MediaLibrary({ projectId }: { projectId?: string }) {
  const assets = useMedia(projectId);
  const transfers = useTransfers();
  const input = useRef<HTMLInputElement>(null);
  const policy = useQuery({
    queryKey: ['media-policy'],
    queryFn: ({ signal }) => api(MediaPolicySchema, ApiRoutes.mediaPolicy, { signal }),
  });
  useEffect(() => {
    prepareUploads(projectId);
  }, [projectId]);
  useEffect(() => {
    if (!assets.data) return;
    useTransfers.setState((s) => ({
      items: s.items.map((item) => {
        const asset = assets.data.find((a) => a.id === item.asset?.id);
        return asset ? { ...item, asset } : item;
      }),
    }));
  }, [assets.data]);
  const rows: Array<{ key: string; transfer?: Transfer; asset?: MediaAsset }> = transfers.items
    .filter((item) => item.status !== 'cancelled')
    .map((item) => ({
      key: item.id,
      transfer: item,
      asset: assets.data?.find((asset) => asset.id === item.asset?.id) ?? item.asset,
    }));
  for (const asset of assets.data ?? []) {
    if (!rows.some((row) => row.asset?.id === asset.id))
      rows.push({ key: `${asset.id}:${asset.generation}`, transfer: undefined, asset });
  }
  rows.sort(
    (left, right) =>
      (left.asset?.number ?? Number.MAX_SAFE_INTEGER) -
      (right.asset?.number ?? Number.MAX_SAFE_INTEGER),
  );
  return (
    <section
      className={`${common.panel} ${styles.assetsPanel}`}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        void selectVideos(Array.from(event.dataTransfer.files), projectId);
      }}
    >
      <div className={`${common.row} ${common.between}`}>
        <h2>
          素材{' '}
          <small className={common.muted}>
            {assets.data?.length ?? 0} / {policy.data?.maxAssets ?? 10}
          </small>
        </h2>
        <Button
          disabled={transfers.selecting || !policy.data}
          onClick={() => input.current?.click()}
        >
          ＋ 上传素材
        </Button>
        <input
          ref={input}
          className={common.srOnly}
          type="file"
          multiple
          accept=".mp4,.mov"
          aria-label="选择视频素材"
          onChange={(event) => {
            void selectVideos(Array.from(event.target.files ?? []), projectId);
            event.target.value = '';
          }}
        />
      </div>
      <p className={common.muted}>
        MP4 / MOV · 每批最多 3 个 · 单个不超过{' '}
        {(policy.data?.maxBytes ?? 1024 ** 3) >= 1024 ** 3
          ? `${(policy.data?.maxBytes ?? 1024 ** 3) / 1024 ** 3} GB`
          : `${Math.round(policy.data!.maxBytes / 1024 / 1024)} MB`}{' '}
        · 时长不限
      </p>
      {transfers.selecting && <Notice>正在检查视频格式与时长…</Notice>}
      {(transfers.error || policy.error) && (
        <Notice kind="error">
          {transfers.error ?? policy.error?.message}{' '}
          {policy.error && <Button onClick={() => void policy.refetch()}>重试连接</Button>}
        </Notice>
      )}
      {rows.map((row) => (
        <AssetRow key={row.key} transfer={row.transfer} asset={row.asset} />
      ))}
      {assets.error && (
        <Notice kind="error">
          素材加载失败 <Button onClick={() => void assets.refetch()}>重试</Button>
        </Notice>
      )}
      {!assets.data?.length && (
        <div className={styles.uploadPlaceholder}>
          <strong>拖入视频，或点击「上传素材」</strong>
          <p>至少 1 个素材完整上传后，才会创建并保存任务</p>
        </div>
      )}
    </section>
  );
}
