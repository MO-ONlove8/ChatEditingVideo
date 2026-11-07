import { create } from 'zustand';
import { ApiRoutes, MediaPolicySchema, UploadSchema, type Upload } from '@cev/shared';
import { api, ApiError } from './api';
import { apiBaseUrl } from './runtime';
import { useAuth } from '../stores/auth';
import { registerUpload, useUploads } from '../stores/uploads';
import { endSession } from './session';

export interface Transfer {
  id: string;
  file: File;
  status: 'waiting' | 'uploading' | 'validating' | 'checking' | 'saved' | 'failed' | 'cancelled';
  progress: number;
  error?: string;
}
export const useTransfers = create<{
  contextId: string;
  projectId?: string;
  items: Transfer[];
  selecting: boolean;
  error?: string;
}>(() => ({ contextId: crypto.randomUUID(), items: [], selecting: false }));
const controllers = new Map<string, AbortController>();
let parallel = 0;
let selection: AbortController | undefined;
const update = (id: string, patch: Partial<Transfer>) =>
  useTransfers.setState((state) => ({
    items: state.items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
  }));
export function prepareUploads(projectId?: string) {
  const state = useTransfers.getState();
  if (
    state.items.some((item) =>
      ['waiting', 'uploading', 'validating', 'checking'].includes(item.status),
    )
  )
    return;
  if (state.projectId !== projectId)
    useTransfers.setState({
      contextId: crypto.randomUUID(),
      projectId,
      items: [],
      error: undefined,
    });
}
async function inspect(file: File) {
  const { Input, BlobSource, MP4, QTFF } = await import('mediabunny');
  const input = new Input({ formats: [MP4, QTFF], source: new BlobSource(file) });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('文件没有视频轨道');
    const duration = (await track.computeDuration()) - (await track.getFirstTimestamp());
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('无法读取视频时长');
  } finally {
    input.dispose();
  }
}
export async function selectVideos(files: File[], projectId?: string) {
  if (useTransfers.getState().selecting) return;
  prepareUploads(projectId);
  useTransfers.setState({ selecting: true, error: undefined });
  const inspecting = new AbortController();
  selection = inspecting;
  const token = useAuth.getState().token;
  const unregister = registerUpload('file-inspection', async () => {
    inspecting.abort();
    useTransfers.setState({ selecting: false });
  });
  try {
    const policy = await api(MediaPolicySchema, ApiRoutes.mediaPolicy);
    if (files.length > policy.maxBatch)
      throw new Error(`每批最多 ${policy.maxBatch} 个文件，请重新选择`);
    const valid: Transfer[] = [];
    const errors: string[] = [];
    for (const file of files) {
      try {
        if (!/\.(mp4|mov)$/i.test(file.name)) throw new Error('仅支持 MP4 / MOV');
        if (!file.size || file.size > policy.maxBytes)
          throw new Error(
            `单文件最大 ${policy.maxBytes >= 1024 ** 3 ? `${policy.maxBytes / 1024 ** 3} GB` : `${Math.round(policy.maxBytes / 1024 / 1024)} MB`}`,
          );
        await inspect(file);
        valid.push({ id: crypto.randomUUID(), file, status: 'waiting', progress: 0 });
      } catch (error) {
        errors.push(`${file.name}：${error instanceof Error ? error.message : '文件无法读取'}`);
      }
    }
    if (inspecting.signal.aborted || useAuth.getState().token !== token) return;
    if (valid.length) {
      const state = useTransfers.getState();
      await api(UploadSchema.array(), ApiRoutes.uploads, {
        method: 'POST',
        body: JSON.stringify({
          contextId: state.contextId,
          projectId: state.projectId,
          files: valid.map((item) => ({
            id: item.id,
            fileName: item.file.name,
            sizeBytes: item.file.size,
          })),
        }),
      });
      if (useAuth.getState().token !== token || inspecting.signal.aborted) {
        await Promise.all(
          valid.map((item) =>
            api(UploadSchema, ApiRoutes.upload(item.id), { method: 'DELETE' }).catch(() => {}),
          ),
        );
        return;
      }
      useTransfers.setState((s) => ({ items: [...s.items, ...valid] }));
      for (const item of valid) {
        const abort = new AbortController();
        controllers.set(item.id, abort);
        registerUpload(item.id, async () => {
          abort.abort();
          controllers.delete(item.id);
          update(item.id, { status: 'cancelled' });
          void api(UploadSchema, ApiRoutes.upload(item.id), {
            method: 'DELETE',
            signal: AbortSignal.timeout(5000),
          }).catch(() => {});
        });
      }
      pump();
    }
    useTransfers.setState({ error: errors.join('；') || undefined });
  } catch (error) {
    useTransfers.setState({
      error: error instanceof Error ? error.message : '上传准备失败，请重试',
    });
  } finally {
    if (selection === inspecting) {
      unregister();
      selection = undefined;
      useTransfers.setState({ selecting: false });
    }
  }
}
function send(item: Transfer, token: string, signal: AbortSignal): Promise<Upload> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `${apiBaseUrl()}${ApiRoutes.uploadContent(item.id)}`);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    const abort = () => xhr.abort();
    signal.addEventListener('abort', abort, { once: true });
    xhr.upload.onprogress = (event) => {
      const percent = event.lengthComputable ? Math.floor((event.loaded / event.total) * 100) : 0;
      update(item.id, { progress: percent, status: percent >= 100 ? 'validating' : 'uploading' });
    };
    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status < 200 || xhr.status >= 300) {
          if (xhr.status === 401) endSession(token, data.message ?? '请重新登录');
          throw new ApiError(xhr.status, data);
        }
        resolve(UploadSchema.parse(data));
      } catch (error) {
        reject(error);
      }
    };
    xhr.onerror = () => reject(new Error('网络中断，请查询上传结果或重新上传'));
    xhr.onabort = () => reject(new Error('上传已取消'));
    xhr.onloadend = () => signal.removeEventListener('abort', abort);
    if (signal.aborted) reject(new Error('上传已取消'));
    else xhr.send(item.file);
  });
}
function pump() {
  for (const item of useTransfers.getState().items.filter((i) => i.status === 'waiting')) {
    if (parallel >= 2) break;
    const token = useAuth.getState().token;
    const abort = controllers.get(item.id);
    if (!token || !abort || abort.signal.aborted) continue;
    parallel++;
    update(item.id, { status: 'uploading' });
    void (async () => {
      try {
        let result: Upload;
        try {
          result = await send(item, token, abort.signal);
        } catch (error) {
          if (abort.signal.aborted || useAuth.getState().token !== token) return;
          update(item.id, { status: 'checking', error: '连接中断，正在确认服务端保存结果…' });
          for (;;) {
            abort.signal.throwIfAborted();
            let current: Upload | undefined;
            try {
              current = await api(UploadSchema, ApiRoutes.upload(item.id), {
                signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
              });
            } catch (queryError) {
              if (queryError instanceof ApiError && [401, 404].includes(queryError.status))
                throw queryError;
            }
            if (current?.status === 'saved') {
              result = current;
              break;
            }
            if (current && !['uploading', 'validating'].includes(current.status)) {
              void api(UploadSchema, ApiRoutes.upload(item.id), { method: 'DELETE' }).catch(
                () => {},
              );
              throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }
        if (useAuth.getState().token !== token) return;
        useTransfers.setState({ projectId: result.projectId ?? undefined });
        update(item.id, { status: 'saved', progress: 100 });
      } catch (error) {
        if (useAuth.getState().token === token && !abort.signal.aborted)
          update(item.id, {
            status: 'failed',
            error: error instanceof Error ? error.message : '上传失败',
          });
      } finally {
        parallel--;
        controllers.delete(item.id);
        useUploads.setState((s) => ({
          entries: s.entries.filter((entry) => entry.id !== item.id),
        }));
        pump();
      }
    })();
  }
}
export async function retryTransfer(item: Transfer) {
  const result = await api(UploadSchema, ApiRoutes.upload(item.id));
  if (result.status === 'saved') {
    useTransfers.setState({ projectId: result.projectId ?? undefined });
    update(item.id, { status: 'saved', progress: 100 });
    return;
  }
  if (['uploading', 'validating'].includes(result.status))
    throw new Error('服务端仍在接收或校验，请稍后查询');
  await api(UploadSchema, ApiRoutes.upload(item.id), { method: 'DELETE' });
  update(item.id, { status: 'cancelled' });
  await selectVideos([item.file], useTransfers.getState().projectId);
}
useAuth.subscribe((current, previous) => {
  if (current.token !== previous.token) {
    selection?.abort();
    for (const controller of controllers.values()) controller.abort();
    controllers.clear();
    useTransfers.setState({
      contextId: crypto.randomUUID(),
      projectId: undefined,
      items: [],
      selecting: false,
      error: undefined,
    });
  }
});
