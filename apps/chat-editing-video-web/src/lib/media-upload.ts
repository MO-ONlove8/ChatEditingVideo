import { create } from 'zustand';
import {
  ApiRoutes,
  MediaPolicySchema,
  UploadSchema,
  type Upload,
  type MediaAsset,
  type MediaInfo,
} from '@cev/shared';
import { api, ApiError } from './api';
import { apiBaseUrl } from './runtime';
import { useAuth } from '../stores/auth';
import { registerUpload, useUploads } from '../stores/uploads';
import { endSession } from './session';
import { openLocalMedia, releaseAllLocalMedia, releaseLocalMedia } from './local-media';

export interface Transfer {
  id: string;
  file: File;
  status: 'waiting' | 'uploading' | 'validating' | 'checking' | 'saved' | 'failed' | 'cancelled';
  progress: number;
  error?: string;
  preview?: MediaInfo;
  canPreview?: boolean;
  asset?: MediaAsset;
  registered?: boolean;
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
  if (state.projectId !== projectId) {
    releaseAllLocalMedia();
    useTransfers.setState({
      contextId: crypto.randomUUID(),
      projectId,
      items: [],
      error: undefined,
    });
  }
}
export async function selectVideos(files: File[], projectId?: string) {
  if (useTransfers.getState().selecting) return;
  prepareUploads(projectId);
  useTransfers.setState({ selecting: true, error: undefined });
  const inspecting = new AbortController();
  selection = inspecting;
  const token = useAuth.getState().token;
  const valid: Transfer[] = [];
  let inspectingId: string | undefined;
  const unregister = registerUpload('file-inspection', async () => {
    inspecting.abort();
    if (inspectingId) releaseLocalMedia(inspectingId);
    for (const item of valid) {
      releaseLocalMedia(item.id);
      update(item.id, { status: 'cancelled' });
    }
    useTransfers.setState({ selecting: false });
  });
  try {
    const policy = await api(MediaPolicySchema, ApiRoutes.mediaPolicy);
    if (files.length > policy.maxBatch)
      throw new Error(`每批最多 ${policy.maxBatch} 个文件，请重新选择`);
    const errors: string[] = [];
    for (const file of files) {
      if (inspecting.signal.aborted || useAuth.getState().token !== token) return;
      try {
        if (!/\.(mp4|mov)$/i.test(file.name)) throw new Error('仅支持 MP4 / MOV');
        if (!file.size || file.size > policy.maxBytes)
          throw new Error(
            `单文件最大 ${policy.maxBytes >= 1024 ** 3 ? `${policy.maxBytes / 1024 ** 3} GB` : `${Math.round(policy.maxBytes / 1024 / 1024)} MB`}`,
          );
        const id = crypto.randomUUID();
        inspectingId = id;
        let metadata;
        try {
          metadata = await openLocalMedia(id, file).metadata;
        } catch (error) {
          releaseLocalMedia(id);
          throw error;
        } finally {
          inspectingId = undefined;
        }
        if (inspecting.signal.aborted || useAuth.getState().token !== token) {
          releaseLocalMedia(id);
          return;
        }
        const item: Transfer = {
          id,
          file,
          status: 'waiting',
          progress: 0,
          preview: metadata.info,
          canPreview: metadata.canDecode,
        };
        valid.push(item);
        useTransfers.setState((s) => ({ items: [...s.items, item] }));
      } catch (error) {
        errors.push(`${file.name}：${error instanceof Error ? error.message : '文件无法读取'}`);
      }
    }
    if (inspecting.signal.aborted || useAuth.getState().token !== token) {
      for (const item of valid) releaseLocalMedia(item.id);
      return;
    }
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
      for (const item of valid) {
        update(item.id, { registered: true });
        const abort = new AbortController();
        controllers.set(item.id, abort);
        registerUpload(item.id, async () => {
          abort.abort();
          controllers.delete(item.id);
          update(item.id, { status: 'cancelled' });
          releaseLocalMedia(item.id);
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
    if (inspecting.signal.aborted || useAuth.getState().token !== token) return;
    for (const item of valid)
      update(item.id, {
        status: 'failed',
        error: error instanceof Error ? error.message : '上传准备失败',
      });
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
        useTransfers.setState((s) => ({
          projectId: result.projectId ?? undefined,
          items: s.items.map((i) =>
            i.id === item.id
              ? { ...i, status: 'saved', progress: 100, asset: result.asset ?? undefined }
              : i,
          ),
        }));
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
  if (!item.registered) {
    update(item.id, { status: 'cancelled' });
    releaseLocalMedia(item.id);
    await selectVideos([item.file], useTransfers.getState().projectId);
    return;
  }
  const result = await api(UploadSchema, ApiRoutes.upload(item.id));
  if (result.status === 'saved') {
    useTransfers.setState((s) => ({
      projectId: result.projectId ?? undefined,
      items: s.items.map((i) =>
        i.id === item.id
          ? { ...i, status: 'saved', progress: 100, asset: result.asset ?? undefined }
          : i,
      ),
    }));
    return;
  }
  if (['uploading', 'validating'].includes(result.status))
    throw new Error('服务端仍在接收或校验，请稍后查询');
  await api(UploadSchema, ApiRoutes.upload(item.id), { method: 'DELETE' });
  update(item.id, { status: 'cancelled' });
  releaseLocalMedia(item.id);
  await selectVideos([item.file], useTransfers.getState().projectId);
}
export function forgetTransfer(id: string) {
  releaseLocalMedia(id);
  useTransfers.setState((s) => ({ items: s.items.filter((item) => item.id !== id) }));
}
export async function cancelTransfer(id: string) {
  controllers.get(id)?.abort();
  update(id, { status: 'cancelled' });
  releaseLocalMedia(id);
  useUploads.setState((s) => ({ entries: s.entries.filter((entry) => entry.id !== id) }));
  await api(UploadSchema, ApiRoutes.upload(id), { method: 'DELETE' });
}
useAuth.subscribe((current, previous) => {
  if (current.token !== previous.token) {
    releaseAllLocalMedia();
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
