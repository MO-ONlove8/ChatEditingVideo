import { Input, BlobSource, MP4, QTFF, CanvasSink } from 'mediabunny';

type Request =
  | { id: number; type: 'open'; file: File }
  | { id: number; type: 'thumbnail'; second: number }
  | { id: number; type: 'cancel' };
let input: Input | undefined;
let sink: CanvasSink | undefined;
let running = false;
let origin = 0;
const pending = new Map<number, number>();
const cancelled = new Set<number>();

async function pump() {
  if (running || !sink) return;
  running = true;
  try {
    while (pending.size) {
      const [id, second] = pending.entries().next().value!;
      pending.delete(id);
      try {
        const result = await sink.getCanvas(second + origin);
        if (!result) throw new Error('无法读取该时间的画面');
        const blob = await (result.canvas as OffscreenCanvas).convertToBlob({
          type: 'image/jpeg',
          quality: 0.75,
        });
        if (!cancelled.has(id)) postMessage({ id, blob });
      } catch (error) {
        if (!cancelled.has(id))
          postMessage({ id, error: error instanceof Error ? error.message : '缩略图读取失败' });
      } finally {
        cancelled.delete(id);
      }
    }
  } finally {
    running = false;
  }
}

self.onmessage = async ({ data }: MessageEvent<Request>) => {
  if (data.type === 'cancel') {
    if (!pending.delete(data.id)) cancelled.add(data.id);
    return;
  }
  if (data.type === 'thumbnail') {
    pending.set(data.id, data.second);
    void pump();
    return;
  }
  try {
    input?.dispose();
    input = new Input({ formats: [MP4, QTFF], source: new BlobSource(data.file) });
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('文件没有视频轨道');
    const first = await track.getFirstTimestamp();
    origin = first;
    const duration = (await track.computeDuration()) - first;
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('无法读取视频时长');
    const canDecode = await track.canDecode();
    if (canDecode)
      sink = new CanvasSink(track, { width: 160, height: 90, fit: 'contain', poolSize: 2 });
    postMessage({
      id: data.id,
      info: {
        duration,
        width: track.displayWidth,
        height: track.displayHeight,
        rotation: track.rotation,
        hdr: false,
        hasAudio: Boolean(await input.getPrimaryAudioTrack()),
        frameCount: Math.max(1, Math.ceil(duration * 30)),
      },
      canDecode,
    });
  } catch (error) {
    input?.dispose();
    input = undefined;
    postMessage({ id: data.id, error: error instanceof Error ? error.message : '无法读取视频' });
  }
};
