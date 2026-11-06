import { useRef, useState, type FormEvent } from 'react';
import { ApiRoutes, ChatStreamEventSchema, type ChatMessage } from '@cev/shared';
import { apiFetch } from '../lib/api';
import { readSseJson } from '../lib/sse';

export function ChatPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string>();
  const abortRef = useRef<AbortController | null>(null);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || streaming) return;
    const history: ChatMessage[] = [...messages, { role: 'user', content: text }];
    setMessages([...history, { role: 'assistant', content: '' }]);
    setInput('');
    setError(undefined);
    setStreaming(true);
    const abort = new AbortController();
    abortRef.current = abort;

    const append = (chunk: string) =>
      setMessages((prev) => {
        const next = [...prev];
        const last = next[next.length - 1]!;
        next[next.length - 1] = { ...last, content: last.content + chunk };
        return next;
      });

    try {
      const res = await apiFetch(ApiRoutes.chatStream, {
        method: 'POST',
        body: JSON.stringify({ messages: history }),
        signal: abort.signal,
      });
      for await (const raw of readSseJson(res)) {
        const event = ChatStreamEventSchema.parse(raw);
        if (event.type === 'delta') append(event.content);
        else if (event.type === 'error') setError(event.message);
      }
    } catch (err) {
      if (!abort.signal.aborted) setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  };

  return (
    <section className="flex h-full flex-col gap-4">
      <h1 className="text-xl font-semibold">对话剪辑</h1>
      <ol aria-live="polite" className="flex-1 space-y-3 overflow-y-auto">
        {messages.map((m, i) => (
          <li
            key={i}
            className={
              m.role === 'user'
                ? 'ml-auto max-w-[80%] rounded bg-blue-600 px-3 py-2 whitespace-pre-wrap text-white'
                : 'max-w-[80%] rounded bg-neutral-100 px-3 py-2 whitespace-pre-wrap dark:bg-neutral-800'
            }
          >
            <span className="sr-only">{m.role === 'user' ? '我：' : '助手：'}</span>
            {m.content || (streaming && i === messages.length - 1 ? '…' : '')}
          </li>
        ))}
      </ol>
      {error && (
        <p role="alert" className="text-red-600">
          {error}
        </p>
      )}
      <form onSubmit={send} className="flex gap-2">
        <label htmlFor="chat-input" className="sr-only">
          输入剪辑需求
        </label>
        <input
          id="chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="例如：把视频前 10 秒剪掉，加一段字幕"
          className="flex-1 rounded border border-neutral-300 px-3 py-2 dark:border-neutral-700 dark:bg-neutral-900"
        />
        {streaming ? (
          <button
            type="button"
            onClick={() => abortRef.current?.abort()}
            className="rounded border px-4 py-2"
          >
            停止
          </button>
        ) : (
          <button
            type="submit"
            disabled={!input.trim()}
            className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50"
          >
            发送
          </button>
        )}
      </form>
    </section>
  );
}
