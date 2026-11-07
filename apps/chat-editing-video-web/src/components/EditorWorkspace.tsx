import { useCallback, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { PlayerRef } from '@remotion/player';
import { EditorStateSchema, emptyTimeline, type EditorState } from '@cev/shared';
import { useAuth } from '../stores/auth';
import { api } from '../lib/api';
import { editorPath, useEditor } from '../lib/editing';
import { Notice } from './ui';
import { TimelinePlayer } from './TimelinePlayer';
import { ClipTimeline } from './ClipTimeline';
import { ChatPanel } from './ChatPanel';
import { MediaLibrary } from './MediaLibrary';

export function EditorWorkspace({ projectId }: { projectId?: string }) {
  const editor = useEditor(projectId),
    qc = useQueryClient(),
    user = useAuth((s) => s.session?.user.id);
  const player = useRef<PlayerRef>(null),
    [frame, setFrame] = useState(0),
    [playing, setPlaying] = useState(false);
  const stopAt = useRef<number | null>(null);
  const onFrame = useCallback((n: number) => setFrame(n), []),
    onPlaying = useCallback((p: boolean) => setPlaying(p), []);
  const update = (state: EditorState) => {
    qc.setQueryData(['editor', user, projectId], state);
    void qc.invalidateQueries({ queryKey: ['tasks'] });
    void qc.invalidateQueries({ queryKey: ['task', user, projectId] });
  };
  const timeline = editor.data?.timeline ?? emptyTimeline();
  return (
    <div className="workspace-grid">
      <div className="workspace-left">
        {editor.error && <Notice kind="error">无法恢复剪辑：{editor.error.message}</Notice>}
        <section className="panel preview-panel">
          <h2>主视频预览</h2>
          <TimelinePlayer
            timeline={timeline}
            playerRef={player}
            onFrame={onFrame}
            onPlaying={onPlaying}
            stopAt={stopAt}
          />
        </section>
        <ClipTimeline
          timeline={timeline}
          frame={frame}
          playing={playing}
          playerRef={player}
          stopAt={stopAt}
          onDelete={async (id, requestId) => {
            player.current?.pause();
            update(
              await api(EditorStateSchema, `${editorPath(projectId!)}/clips/${id}`, {
                method: 'DELETE',
                body: JSON.stringify({ requestId, expectedRevision: timeline.revision }),
              }),
            );
          }}
        />
        <MediaLibrary projectId={projectId} />
        <p className="muted editor-note">
          完整上传即保存；统一转换为30帧/秒后可查看帧图并用于剪辑。
        </p>
      </div>
      <ChatPanel
        key={projectId ?? 'new'}
        projectId={projectId}
        state={editor.data}
        onState={update}
        onBeforeChange={() => player.current?.pause()}
      />
    </div>
  );
}
