import { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorStateSchema, type EditorState } from '@cev/shared';
import { ChatPanel } from './ChatPanel';
const id = '00000000-0000-4000-8000-000000000001',
  turn = '00000000-0000-4000-8000-000000000002',
  card = '00000000-0000-4000-8000-000000000003',
  source = '00000000-0000-4000-8000-000000000004';
const initial = (): EditorState =>
  EditorStateSchema.parse({
    project: {
      id,
      name: 'task',
      description: null,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    },
    timeline: { revision: 0, fps: 30, canvas: null, clips: [] },
    turns: [
      {
        id: turn,
        requestId: turn,
        text: 'V1第5秒到第8秒追加',
        reply: '请确认',
        status: 'pending',
        createdAt: new Date(0).toISOString(),
        proposal: {
          id: card,
          turnId: turn,
          baseRevision: 0,
          status: 'pending',
          operation: {
            kind: 'add',
            clip: { id: card, source, generation: 1, startFrame: 150, endFrame: 240 },
            destination: { kind: 'end', clipId: null },
            canvas: { width: 1920, height: 1080 },
          },
          sourceLabel: 'V1',
          destinationLabel: '主视频末尾',
          previewClip: { source, generation: 1, startFrame: 150, endFrame: 240 },
          appliedRevision: null,
        },
      },
    ],
    nextCursor: null,
  });
function Harness() {
  const [state, setState] = useState(initial);
  return <ChatPanel projectId={id} state={state} onState={setState} onBeforeChange={() => {}} />;
}
afterEach(() => vi.unstubAllGlobals());
describe('persisted confirmation card', () => {
  it('keeps the card and last saved timeline when confirmation fails, then retries once', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++;
        if (calls === 1) return Response.json({ message: '连接中断' }, { status: 503 });
        const saved = initial();
        saved.turns[0]!.proposal!.status = 'confirmed';
        saved.turns[0]!.status = 'done';
        return Response.json(saved);
      }),
    );
    render(<Harness />);
    expect(screen.getByLabelText('输入剪辑指令')).toBeDisabled();
    expect(screen.getByLabelText('剪辑确认卡')).toHaveTextContent('91 帧');
    await userEvent.click(screen.getByRole('button', { name: '确认并保存' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('保存失败，请重试');
    expect(screen.getByLabelText('剪辑确认卡')).toHaveTextContent('待确认');
    await userEvent.dblClick(screen.getByRole('button', { name: '重试确认保存' }));
    await waitFor(() => expect(screen.getByLabelText('剪辑确认卡')).toHaveTextContent('已保存'));
    expect(calls).toBe(2);
    expect(screen.getByLabelText('输入剪辑指令')).toBeEnabled();
  });
  it('cancel changes card state without changing the timeline', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const state = initial();
        state.turns[0]!.proposal!.status = 'cancelled';
        state.turns[0]!.status = 'done';
        return Response.json(state);
      }),
    );
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: /^取消$/ }));
    await waitFor(() => expect(screen.getByLabelText('剪辑确认卡')).toHaveTextContent('已取消'));
    expect(screen.queryByRole('button', { name: '确认并保存' })).not.toBeInTheDocument();
  });
});
