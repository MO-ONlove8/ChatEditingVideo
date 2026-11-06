import { createSseParser } from '@cev/shared';

/**
 * Reads an SSE response from fetch (works for POST, unlike EventSource) and
 * yields each `data:` payload parsed as JSON.
 */
export async function* readSseJson(response: Response): AsyncGenerator<unknown> {
  if (!response.body) throw new Error('Response has no body');
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  const queue: unknown[] = [];
  const parser = createSseParser((m) => queue.push(JSON.parse(m.data)));
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      parser.push(value);
      while (queue.length) yield queue.shift();
    }
  } finally {
    reader.releaseLock();
  }
}
