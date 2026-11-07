import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApiRoutes,
  ImageIndexSchema,
  MediaAssetSchema,
  MediaPolicySchema,
  formatTimecode,
  type MediaAsset,
} from '@cev/shared';
import { api, apiFetch } from '../lib/api';
import { readSseJson } from '../lib/sse';
import {
  prepareUploads,
  retryTransfer,
  selectVideos,
  useTransfers,
  type Transfer,
} from '../lib/media-upload';
import { useAuth } from '../stores/auth';
import { Button, ConfirmDialog, Notice } from './ui';
import { FramePreview, MediaProcessingState } from './KeyStates';

export function useMedia(projectId?: string) {
  const userId = useAuth((s) => s.session?.user.id);
  const qc = useQueryClient();
  const key = ['media', userId, projectId];
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      api(MediaAssetSchema.array(), ApiRoutes.projectMedia(projectId!), { signal }),
    enabled: Boolean(projectId && userId),
    refetchInterval: 5000,
  });
  useEffect(() => {
    if (!projectId || !userId) return;
    const abort = new AbortController();
    void (async () => {
      try {
        const response = await apiFetch(ApiRoutes.mediaEvents(projectId), { signal: abort.signal });
        for await (const raw of readSseJson(response)) {
          const event = raw as { type: string; assets: unknown };
          if (event.type === 'media')
            qc.setQueryData(
              ['media', userId, projectId],
              MediaAssetSchema.array().parse(event.assets),
            );
        }
      } catch {
        /* Polling keeps the library current if the event stream is interrupted. */
      }
    })();
    return () => abort.abort();
  }, [projectId, userId, qc]);
  return query;
}
function useBlob(path?: string, enabled = true) {
  const [result, setResult] = useState<{ path: string; url?: string; error?: string }>();
  const [attempt, setAttempt] = useState(0);
  const token = useAuth((s) => s.token);
  useEffect(() => {
    if (!path || !enabled) return;
    setResult(undefined);
    const abort = new AbortController();
    let url: string | undefined;
    void apiFetch(path, { signal: abort.signal })
      .then((response) => response.blob())
      .then((blob) => {
        if (abort.signal.aborted) return;
        url = URL.createObjectURL(blob);
        setResult({ path, url });
      })
      .catch((error) => {
        if (!abort.signal.aborted)
          setResult({ path, error: error instanceof Error ? error.message : '图片加载失败' });
      });
    return () => {
      abort.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [path, enabled, token, attempt]);
  return {
    ...(enabled && result?.path === path ? result : {}),
    retry: () => setAttempt((n) => n + 1),
  };
}
function ThumbnailPage({
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
    <div ref={ref} className="thumbnail-page" style={{ width: count * 160 }}>
      {Array.from({ length: count }, (_, i) => (
        <button
          key={i}
          className="second-thumbnail"
          aria-label={`V${asset.number} 第 ${page * 30 + i} 秒`}
          onClick={() => onSelect(page * 30 + i)}
        >
          <span
            className="sprite-cell"
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
        <span className="thumbnail-error">
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
function FrameImage({
  path,
  frame,
  onSelect,
}: {
  path: string;
  frame: number;
  onSelect: () => void;
}) {
  const image = useBlob(path);
  return (
    <button
      className="frame-thumbnail"
      onClick={image.error ? image.retry : onSelect}
      aria-label={image.error ? `重试第 ${frame % 30} 帧图片` : `放大第 ${frame % 30} 帧`}
    >
      {image?.url ? (
        <img src={image.url} alt={`第 ${frame % 30} 帧`} />
      ) : (
        <span>{image?.error ? '加载失败，点击重试' : '加载中…'}</span>
      )}
      <small>{frame % 30}</small>
    </button>
  );
}
function AssetRow({ asset }: { asset: MediaAsset }) {
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
      className="asset-row"
      onBlur={(event) => {
        if (
          !event.currentTarget.contains(event.relatedTarget as Node | null) &&
          frame === undefined
        )
          setSecond(undefined);
      }}
    >
      <div className="row between">
        <strong>
          V{asset.number} <span className="muted">{asset.fileName}</span>
        </strong>
        <div className="row">
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
          <div className="seconds-strip" aria-label={`V${asset.number} 逐秒缩略图`}>
            {Array.from({ length: Math.ceil(asset.normalized!.frameCount! / 900) }, (_, page) => (
              <ThumbnailPage key={page} asset={asset} page={page} onSelect={setSecond} />
            ))}
          </div>
          {second !== undefined && (
            <div className="expanded-frames">
              <div className="row between">
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
                <div className="frames-strip">
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
function TransferRow({ item }: { item: Transfer }) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  if (item.status === 'saved' || item.status === 'cancelled') return null;
  return (
    <div className="media-state">
      <div className="row between">
        <strong>{item.file.name}</strong>
        <span>
          {item.status === 'failed'
            ? '上传失败'
            : item.status === 'validating'
              ? '正在校验并保存…'
              : item.status === 'checking'
                ? '正在查询保存结果…'
                : item.status === 'waiting'
                  ? '等待上传'
                  : `上传中 ${item.progress}%`}
        </span>
      </div>
      <progress value={item.progress} max={100} />
      {item.status === 'checking' && <p>{item.error}</p>}
      {item.status === 'failed' && (
        <>
          <p>{item.error}</p>
          <Button
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError(undefined);
              void retryTransfer(item)
                .catch((error) => setError(String(error.message)))
                .finally(() => setBusy(false));
            }}
          >
            查询结果 / 重新上传
          </Button>
        </>
      )}
      {error && <Notice kind="error">{error}</Notice>}
    </div>
  );
}
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
  return (
    <section
      className="panel assets-panel"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        void selectVideos(Array.from(event.dataTransfer.files), projectId);
      }}
    >
      <div className="row between">
        <h2>
          素材{' '}
          <small className="muted">
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
          className="sr-only"
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
      <p className="muted">
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
      {transfers.items.map((item) => (
        <TransferRow key={item.id} item={item} />
      ))}
      {assets.error && (
        <Notice kind="error">
          素材加载失败 <Button onClick={() => void assets.refetch()}>重试</Button>
        </Notice>
      )}
      {!assets.data?.length && (
        <div className="upload-placeholder">
          <strong>拖入视频，或点击「上传素材」</strong>
          <p>至少 1 个素材完整上传后，才会创建并保存任务</p>
        </div>
      )}
      {assets.data?.map((asset) => (
        <AssetRow key={`${asset.id}:${asset.generation}`} asset={asset} />
      ))}
    </section>
  );
}
