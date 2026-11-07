import type { MediaInfo } from '@cev/shared';

type Response = { id: number; info?: MediaInfo; canDecode?: boolean; blob?: Blob; error?: string };
class LocalMedia {
  private worker = new Worker(new URL('./local-media.worker.ts', import.meta.url), {
    type: 'module',
  });
  private sequence = 0;
  private requests = new Map<
    number,
    { resolve: (data: Response) => void; reject: (error: Error) => void }
  >();
  private thumbnails = new Map<number, Blob>();
  private disposed = false;
  readonly url: string;
  readonly metadata: Promise<{ info: MediaInfo; canDecode: boolean }>;
  constructor(readonly file: File) {
    this.url = URL.createObjectURL(file);
    this.worker.onmessage = ({ data }: MessageEvent<Response>) => {
      const request = this.requests.get(data.id);
      this.requests.delete(data.id);
      if (data.error) request?.reject(new Error(data.error));
      else request?.resolve(data);
    };
    this.worker.onerror = () => this.dispose();
    this.metadata = this.request({ type: 'open', file }).then((data) => ({
      info: data.info!,
      canDecode: Boolean(data.canDecode),
    }));
  }
  private request(payload: object, signal?: AbortSignal): Promise<Response> {
    return new Promise((resolve, reject) => {
      if (this.disposed) {
        reject(new DOMException('预览已释放', 'AbortError'));
        return;
      }
      const id = ++this.sequence;
      const abort = () => {
        this.requests.delete(id);
        this.worker.postMessage({ type: 'cancel', id });
        reject(new DOMException('预览已取消', 'AbortError'));
      };
      if (signal?.aborted) {
        reject(new DOMException('预览已取消', 'AbortError'));
        return;
      }
      signal?.addEventListener('abort', abort, { once: true });
      this.requests.set(id, {
        resolve: (data) => {
          signal?.removeEventListener('abort', abort);
          resolve(data);
        },
        reject: (error) => {
          signal?.removeEventListener('abort', abort);
          reject(error);
        },
      });
      this.worker.postMessage({ ...payload, id });
    });
  }
  async thumbnail(second: number, signal: AbortSignal) {
    const cached = this.thumbnails.get(second);
    if (cached) {
      this.thumbnails.delete(second);
      this.thumbnails.set(second, cached);
      return cached;
    }
    const meta = await this.metadata;
    signal.throwIfAborted();
    if (!meta.canDecode) throw new Error('当前设备需等待视频转换后预览');
    const result = await this.request({ type: 'thumbnail', second }, signal);
    this.thumbnails.set(second, result.blob!);
    while (this.thumbnails.size > 64) this.thumbnails.delete(this.thumbnails.keys().next().value!);
    return result.blob!;
  }
  dispose() {
    this.disposed = true;
    this.worker.terminate();
    URL.revokeObjectURL(this.url);
    this.thumbnails.clear();
    for (const request of this.requests.values())
      request.reject(new DOMException('预览已释放', 'AbortError'));
    this.requests.clear();
  }
}
const sources = new Map<string, LocalMedia>();
export function openLocalMedia(id: string, file: File) {
  let source = sources.get(id);
  if (!source) {
    source = new LocalMedia(file);
    sources.set(id, source);
  }
  return source;
}
export const getLocalMedia = (id?: string) => (id ? sources.get(id) : undefined);
export function releaseLocalMedia(id: string) {
  sources.get(id)?.dispose();
  sources.delete(id);
}
export function releaseAllLocalMedia() {
  for (const id of sources.keys()) releaseLocalMedia(id);
}
