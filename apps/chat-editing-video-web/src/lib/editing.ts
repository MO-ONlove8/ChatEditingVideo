import { useQuery } from '@tanstack/react-query';
import {
  ApiRoutes,
  EditorStateSchema,
  EditingStreamEventSchema,
  createSseParser,
  type EditorState,
} from '@cev/shared';
import { api, apiFetch } from './api';
import { useAuth } from '../stores/auth';

export const editorPath = (id: string) => `/projects/${encodeURIComponent(id)}`;
export function useEditor(id?: string) {
  const user = useAuth((s) => s.session?.user.id);
  return useQuery({
    queryKey: ['editor', user, id],
    enabled: Boolean(user && id),
    queryFn: ({ signal }) => api(EditorStateSchema, ApiRoutes.editorState(id!), { signal }),
    refetchInterval: (q) =>
      q.state.data?.turns.some((t) => t.status === 'understanding' || t.status === 'pending')
        ? 2000
        : false,
  });
}
export async function sendInstruction(
  id: string,
  text: string,
  revision: number,
  requestId: string,
  onState: (s: EditorState) => void,
  signal?: AbortSignal,
) {
  const response = await apiFetch(ApiRoutes.projectChatStream(id), {
    method: 'POST',
    body: JSON.stringify({ text, expectedRevision: revision, requestId }),
    signal,
  });
  if (!response.body) throw new Error('无法接收理解结果，请重试');
  let complete = false,
    problem: string | undefined;
  const parser = createSseParser((message) => {
    const event = EditingStreamEventSchema.parse(JSON.parse(message.data));
    if (event.type === 'state') {
      onState(event.state);
      complete = true;
    } else if (event.type === 'error') problem = event.message;
  });
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode());
  } finally {
    reader.releaseLock();
  }
  if (problem) throw new Error(problem);
  if (!complete) throw new Error('连接已中断，请刷新查看已保存结果后重试');
}
