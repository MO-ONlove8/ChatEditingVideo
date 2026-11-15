import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Player } from '@remotion/player';
import { Audio } from '@remotion/media';
import { AuxiliaryPolicy, UploadSchema, type AssetKind } from '@cev/shared';
import { api, apiFetch } from '../../../../../../lib/api';
import { apiBaseUrl } from '../../../../../../lib/runtime';
import { registerUpload } from '../../../../../../stores/uploads';
import { useAuth } from '../../../../../../stores/auth';
import { Button } from '../../../../../../components/Button';
import { Notice } from '../../../../../../components/Notice';
import { ConfirmDialog } from '../../../../../../components/ConfirmDialog';
import { useMedia } from '../MediaLibrary/hooks/useMedia';
import { useBlob } from '../MediaLibrary/hooks/useBlob';
import common from '../../../../../../styles/common.module.less';
import styles from './index.module.less';

function Audition({ id, token }: { id: string; token: string }) {
  return (
    <Audio
      src={apiBaseUrl() + '/media/' + id + '/content'}
      requestInit={{ headers: { Authorization: 'Bearer ' + token } }}
      disallowFallbackToHtml5Audio
    />
  );
}
function AssetContent({ id, kind, frames }: { id: string; kind: string; frames?: number }) {
  const blob = useBlob(kind === 'image' ? '/media/' + id + '/content' : undefined),
    token = useAuth((s) => s.token);
  if (kind === 'audio' && frames && token)
    return (
      <Player
        component={Audition}
        inputProps={{ id, token }}
        durationInFrames={frames}
        fps={30}
        compositionWidth={600}
        compositionHeight={80}
        controls
        style={{ width: '100%' }}
        acknowledgeRemotionLicense
      />
    );
  return blob.url ? (
    <img src={blob.url} alt="图像素材" className={styles.thumb} />
  ) : blob.error ? (
    <Notice kind="error">
      {blob.error}
      <Button onClick={blob.retry}>重试图片</Button>
    </Notice>
  ) : null;
}
export function AuxiliaryLibrary({
  projectId,
  onImport,
}: {
  projectId: string;
  onImport: (id: string) => void;
}) {
  const assets = useMedia(projectId),
    qc = useQueryClient(),
    input = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<Exclude<AssetKind, 'video'>>('image'),
    [status, setStatus] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [removing, setRemoving] = useState<string>(),
    [opened, setOpened] = useState<string>();
  const lock = useRef(false),
    cancel = useRef<(() => Promise<void>) | undefined>(undefined);
  const upload = async (file: File) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    const id = crypto.randomUUID(),
      controller = new AbortController();
    let xhr: XMLHttpRequest | undefined;
    const stop = async () => {
      controller.abort();
      xhr?.abort();
      await apiFetch('/uploads/' + id, { method: 'DELETE' }).catch(() => {});
    };
    cancel.current = stop;
    const unregister = registerUpload(id, stop);
    try {
      if (!file.size || file.size > AuxiliaryPolicy[kind].maxBytes)
        throw new Error('文件为空或超过 ' + AuxiliaryPolicy[kind].maxBytes / 1024 ** 2 + ' MB');
      setStatus('准备上传…');
      await api(UploadSchema.array(), '/uploads', {
        method: 'POST',
        body: JSON.stringify({
          contextId: crypto.randomUUID(),
          projectId,
          files: [{ id, fileName: file.name, sizeBytes: file.size, kind }],
        }),
        signal: controller.signal,
      });
      await new Promise<void>((resolve, reject) => {
        xhr = new XMLHttpRequest();
        xhr.open('PUT', apiBaseUrl() + '/uploads/' + id + '/content');
        xhr.setRequestHeader('Authorization', 'Bearer ' + useAuth.getState().token);
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.upload.onprogress = (e) =>
          setStatus(
            e.loaded === e.total
              ? '校验与处理…'
              : '上传 ' + Math.round((e.loaded / e.total) * 100) + '%',
          );
        xhr.onload = () => {
          if (xhr!.status >= 200 && xhr!.status < 300) resolve();
          else {
            let message = '上传失败';
            try {
              const body = JSON.parse(xhr!.responseText);
              message = body.message ?? message;
            } catch {
              /* Empty transport response. */
            }
            reject(new Error(String(message)));
          }
        };
        xhr.onerror = () => reject(new Error('网络中断，请查询上传结果后重试'));
        xhr.onabort = () => reject(new Error('已取消上传'));
        if (controller.signal.aborted) {
          reject(new Error('已取消上传'));
          return;
        }
        xhr.send(file);
      });
      setStatus('已上传，尚未加入成片');
      await qc.invalidateQueries({ queryKey: ['media'] });
    } catch (e) {
      const saved = await api(UploadSchema, '/uploads/' + id).catch(() => null);
      if (saved?.status === 'saved') {
        setStatus('上传已保存');
        await qc.invalidateQueries({ queryKey: ['media'] });
      } else setError((e as Error).message);
    } finally {
      unregister();
      cancel.current = undefined;
      lock.current = false;
      setBusy(false);
    }
  };
  return (
    <section className={common.panel}>
      <h2>图音与字幕文件</h2>
      <div className={common.row}>
        <select
          aria-label="上传素材类型"
          value={kind}
          disabled={busy}
          onChange={(e) => setKind(e.target.value as typeof kind)}
        >
          <option value="image">图像 / Logo</option>
          <option value="audio">旁白 / BGM 文件</option>
          <option value="srt">SRT 字幕</option>
        </select>
        <Button disabled={busy} onClick={() => input.current?.click()}>
          上传文件
        </Button>
        {busy && <Button onClick={() => void cancel.current?.()}>取消上传</Button>}
        <input
          ref={input}
          type="file"
          aria-label="选择图音或SRT文件"
          className={common.srOnly}
          accept={
            kind === 'image'
              ? '.png,.jpg,.jpeg,.webp'
              : kind === 'audio'
                ? '.mp3,.wav,.m4a'
                : '.srt'
          }
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
            e.target.value = '';
          }}
        />
      </div>
      <p className={common.muted}>
        {kind === 'image'
          ? 'PNG / JPEG / 静态 WebP · 20 MB · 长边≤8192 · 每任务20张'
          : kind === 'audio'
            ? 'MP3 / WAV / M4A · 200 MB · 30分钟 · 每任务10个'
            : 'UTF-8 SRT · 1 MB · 最多1000条 · 仅整轨替换'}
      </p>
      {status && <p role="status">{status}</p>}
      {error && <Notice kind="error">{error}</Notice>}
      {(assets.data ?? [])
        .filter((a) => a.kind !== 'video')
        .map((a) => (
          <details
            key={a.id}
            className={styles.file}
            open={opened === a.id}
            onToggle={(e) => {
              if (e.currentTarget.open) setOpened(a.id);
              else setOpened((old) => (old === a.id ? undefined : old));
            }}
          >
            <summary>
              {a.kind === 'image' ? 'IMG' : a.kind === 'audio' ? 'AUD' : 'SRT'}
              {a.number} · {a.fileName} · {a.status === 'ready' ? '已就绪' : a.stage}
            </summary>
            {opened === a.id && (
              <AssetContent id={a.id} kind={a.kind} frames={a.auxiliary?.frames} />
            )}
            <div className={common.row}>
              {a.kind === 'srt' && <Button onClick={() => onImport(a.id)}>整轨替换字幕…</Button>}
              <Button onClick={() => setRemoving(a.id)}>删除文件</Button>
            </div>
          </details>
        ))}
      <ConfirmDialog
        open={Boolean(removing)}
        title="删除源文件？"
        onClose={() => setRemoving(undefined)}
        onConfirm={async () => {
          await apiFetch('/media/' + removing, { method: 'DELETE' });
          await qc.invalidateQueries({ queryKey: ['media'] });
        }}
      >
        有效、暂不生效或待确认元素引用的文件无法删除。删除SRT源文件保留已保存的字幕。
      </ConfirmDialog>
    </section>
  );
}
