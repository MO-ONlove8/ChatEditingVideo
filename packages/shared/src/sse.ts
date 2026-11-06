/** Minimal Server-Sent Events helpers shared by server (encode) and clients (parse). */

export interface SseMessage {
  event?: string;
  data: string;
  id?: string;
}

export function encodeSse(data: unknown, event?: string): string {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  const lines = payload.split(/\r?\n/).map((l) => `data: ${l}`);
  return `${event ? `event: ${event}\n` : ''}${lines.join('\n')}\n\n`;
}

/**
 * Incremental SSE parser. Feed it text chunks as they arrive (e.g. from a fetch
 * ReadableStream); it calls `onMessage` for every complete event.
 * Works with POST streams, which EventSource cannot do.
 */
export function createSseParser(onMessage: (msg: SseMessage) => void) {
  let buffer = '';
  return {
    push(chunk: string) {
      buffer += chunk.replace(/\r\n/g, '\n');
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const msg: SseMessage = { data: '' };
        const data: string[] = [];
        for (const line of block.split('\n')) {
          if (!line || line.startsWith(':')) continue;
          const idx = line.indexOf(':');
          const field = idx === -1 ? line : line.slice(0, idx);
          const value = idx === -1 ? '' : line.slice(idx + 1).replace(/^ /, '');
          if (field === 'data') data.push(value);
          else if (field === 'event') msg.event = value;
          else if (field === 'id') msg.id = value;
        }
        if (data.length === 0) continue;
        msg.data = data.join('\n');
        onMessage(msg);
      }
    },
  };
}
