import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { PlayerRef } from '@remotion/player';
import {
  EditorStateSchema,
  emptyTimeline,
  type EditorState,
  type Timeline,
  type CompositionManifest,
  timelineFrames,
  emptyPackaging,
  effectiveRange,
} from '@cev/shared';
import { useAuth } from '../../../../stores/auth';
import { api, apiFetch } from '../../../../lib/api';
import { editorPath, useEditor } from '../../../../lib/editing';
import { Button } from '../../../../components/Button';
import { Notice } from '../../../../components/Notice';
import { TimelinePlayer } from '../../../../components/TimelinePlayer';
import { ClipTimeline } from './components/ClipTimeline';
import { ChatPanel } from './components/ChatPanel';
import { PackagingPanel } from './components/PackagingPanel';
import { AuxiliaryLibrary } from './components/AuxiliaryLibrary';
import { MediaLibrary } from './components/MediaLibrary';
import styles from './index.module.less';
import common from '../../../../styles/common.module.less';

export function EditorWorkspace({ projectId }: { projectId?: string }) {
  const editor = useEditor(projectId),
    qc = useQueryClient(),
    user = useAuth((s) => s.session?.user.id);
  const player = useRef<PlayerRef>(null),
    [frame, setFrame] = useState(0),
    [playing, setPlaying] = useState(false),
    [tab, setTab] = useState<'chat' | 'properties'>('chat'),
    [selectedId, setSelectedId] = useState<string>(),
    [dirtyRequest, setDirtyRequest] = useState<string>(),
    [previewMode, setPreviewMode] = useState<'candidate' | 'formal'>('candidate'),
    [loaded, setLoaded] = useState(''),
    [previous, setPrevious] = useState<{ timeline: Timeline; manifest: CompositionManifest }>();
  const stopAt = useRef<number | null>(null);
  const replayCandidate = useRef(false);
  const onFrame = useCallback((n: number) => setFrame(n), []),
    onPlaying = useCallback((p: boolean) => setPlaying(p), []);
  useEffect(() => {
    if (editor.data?.composition?.status === 'ready' && editor.data.composition.manifest)
      setPrevious({ timeline: editor.data.timeline, manifest: editor.data.composition.manifest });
  }, [editor.data]);
  const update = (state: EditorState) => {
    qc.setQueryData(['editor', user, projectId], state);
    void qc.invalidateQueries({ queryKey: ['tasks'] });
    void qc.invalidateQueries({ queryKey: ['task', user, projectId] });
  };
  const timeline = editor.data?.timeline ?? emptyTimeline();
  const ready =
    editor.data?.composition?.status === 'ready' && editor.data.composition.manifest
      ? { timeline, manifest: editor.data.composition.manifest }
      : timelineFrames(timeline) > 0
        ? previous
        : undefined;
  const pending = editor.data?.turns.find((t) => t.status === 'pending')?.proposal;
  const candidate =
    pending?.previewStatus === 'ready' && pending.candidate && pending.manifest
      ? { timeline: pending.candidate, manifest: pending.manifest }
      : undefined;
  const displayed = previewMode === 'candidate' && candidate ? candidate : ready;
  const signature = pending?.generation + ':' + pending?.contentHash;
  const select = (id: string) => {
    setSelectedId(id || undefined);
    setTab('properties');
    player.current?.pause();
    const p = timeline.packaging ?? emptyPackaging(),
      s = p.subtitles.find((s) => s.id === id),
      element = p.overlays.find((o) => o.id === id) ?? p.audio.find((a) => a.id === id);
    const range = s
      ? effectiveRange(
          { mode: 'fixed', startFrame: s.startFrame, endFrame: s.endFrame },
          timelineFrames(timeline),
        )
      : element
        ? effectiveRange(element.range, timelineFrames(timeline))
        : null;
    if (range) player.current?.seekTo(range.startFrame);
  };
  return (
    <div className={styles.workspaceGrid}>
      <div className={styles.workspaceLeft}>
        {editor.error && <Notice kind="error">无法恢复剪辑：{editor.error.message}</Notice>}
        <section aria-label="主视频预览" className={`${common.panel} ${styles.previewPanel}`}>
          <h2>
            主视频 · 完整合成{' '}
            {displayed === candidate
              ? '（未保存候选）'
              : displayed
                ? 'v' + displayed.timeline.revision
                : ''}
          </h2>
          {pending && (
            <div className={common.row}>
              <Button
                onClick={() => {
                  player.current?.pause();
                  setPreviewMode('candidate');
                }}
              >
                候选预览
              </Button>
              <Button
                onClick={() => {
                  player.current?.pause();
                  setPreviewMode('formal');
                }}
              >
                已确认版本
              </Button>
            </div>
          )}
          {editor.data?.composition?.status !== 'ready' && timelineFrames(timeline) > 0 && (
            <Notice kind={editor.data?.composition?.status === 'failed' ? 'error' : undefined}>
              {editor.data?.composition?.status === 'failed'
                ? '正式合成预览失败（已保存定义仍保留）：' + editor.data.composition.error
                : '正在准备正式合成预览…'}
              {ready ? ' · 当前显示旧预览 v' + ready.timeline.revision : ''}
              {projectId && editor.data?.composition?.status === 'failed' && (
                <button
                  onClick={() =>
                    void apiFetch(
                      editorPath(projectId) + '/composition/' + timeline.revision + '/retry',
                      { method: 'POST' },
                    ).then(() => editor.refetch())
                  }
                >
                  重试正式预览
                </button>
              )}
            </Notice>
          )}
          {(displayed || !timelineFrames(timeline)) && (
            <TimelinePlayer
              timeline={displayed?.timeline ?? timeline}
              manifest={displayed?.manifest}
              projectId={projectId}
              onReady={() => {
                if (displayed === candidate) {
                  setLoaded(signature);
                  if (replayCandidate.current) {
                    replayCandidate.current = false;
                    player.current?.seekTo(0);
                    void player.current?.play();
                  }
                }
              }}
              playerRef={player}
              onFrame={onFrame}
              onPlaying={onPlaying}
              stopAt={stopAt}
            />
          )}
        </section>
        <ClipTimeline
          timeline={timeline}
          frame={frame}
          playing={playing}
          playerRef={player}
          stopAt={stopAt}
          onSelect={select}
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
        {projectId && (
          <AuxiliaryLibrary
            projectId={projectId}
            onImport={async (assetId) => {
              try {
                update(
                  await api(EditorStateSchema, editorPath(projectId) + '/proposals', {
                    method: 'POST',
                    body: JSON.stringify({
                      kind: 'subtitle-replace',
                      assetId,
                      requestId: crypto.randomUUID(),
                      expectedRevision: timeline.revision,
                      playhead: frame,
                    }),
                  }),
                );
                setTab('chat');
              } catch (e) {
                window.alert((e as Error).message);
              }
            }}
          />
        )}
        <p className={`${common.muted} ${styles.editorNote}`}>
          选择视频即可预览；完整上传并校验后可剪辑，不兼容的格式会自动转换。
        </p>
      </div>
      <div className={styles.workspaceRight}>
        <div className={styles.tabs} role="tablist">
          <button role="tab" aria-selected={tab === 'chat'} onClick={() => setTab('chat')}>
            对话
          </button>
          <button
            role="tab"
            aria-selected={tab === 'properties'}
            onClick={() => setTab('properties')}
          >
            属性
          </button>
        </div>
        <div className={styles.tabBody} hidden={tab !== 'chat'}>
          <ChatPanel
            key={projectId ?? 'new'}
            projectId={projectId}
            state={editor.data}
            candidateLoaded={loaded}
            dirtyRequest={dirtyRequest}
            onCandidatePreview={() => {
              player.current?.pause();
              setPreviewMode('candidate');
              if (displayed === candidate) {
                player.current?.seekTo(0);
                void player.current?.play();
              } else replayCandidate.current = true;
            }}
            playhead={frame}
            selectedId={selectedId}
            onState={update}
            onBeforeChange={() => player.current?.pause()}
          />
        </div>
        <div className={styles.tabBody} hidden={tab !== 'properties'}>
          {projectId && editor.data ? (
            <PackagingPanel
              projectId={projectId}
              state={editor.data}
              onDirty={(id, dirty) => setDirtyRequest(dirty ? id : undefined)}
              frame={frame}
              selectedId={selectedId}
              onSelect={select}
              onState={(s) => {
                update(s);
                setTab('chat');
              }}
              onPreview={(start, end) => {
                stopAt.current = end;
                player.current?.pause();
                player.current?.seekTo(start);
                void player.current?.play();
              }}
            />
          ) : (
            <Notice>请先上传视频创建任务。</Notice>
          )}
        </div>
      </div>
    </div>
  );
}
