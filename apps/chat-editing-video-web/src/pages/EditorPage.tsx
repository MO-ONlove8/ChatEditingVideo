import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiRoutes, ProjectSchema } from '@cev/shared';
import { api } from '../lib/api';
import { useAuth } from '../stores/auth';
import { Button, ConfirmDialog, EmptyState, Notice } from '../components/ui';
import { MediaLibrary } from '../components/MediaLibrary';
import { prepareUploads, useTransfers } from '../lib/media-upload';
import { useUploads } from '../stores/uploads';

export function useTask(id?: string) {
  const userId = useAuth((s) => s.session?.user.id);
  return useQuery({
    queryKey: ['task', userId, id],
    queryFn: ({ signal }) => api(ProjectSchema, ApiRoutes.project(id!), { signal }),
    enabled: Boolean(id && userId),
  });
}

export function EditorPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const savedProjectId = useTransfers((s) => s.projectId);
  const task = useTask(id);
  const qc = useQueryClient();
  const [rename, setRename] = useState(false);
  const [name, setName] = useState('');
  const userId = useAuth((s) => s.session?.user.id);
  useEffect(() => {
    prepareUploads(id);
  }, [id]);
  useEffect(() => {
    const saved = useTransfers.getState().projectId;
    if (!id && saved) {
      const path = `/tasks/${saved}/edit`;
      useUploads.setState({ internalPath: path });
      void qc.invalidateQueries({ queryKey: ['tasks'] });
      void navigate(path, { replace: true });
    } else if (id) useUploads.setState({ internalPath: null });
  }, [id, savedProjectId, navigate, qc]);
  if (id && task.isPending)
    return (
      <main className="page-width">
        <Notice>正在加载任务…</Notice>
      </main>
    );
  if (id && task.error)
    return (
      <main className="page-width">
        <Link to="/tasks">‹ 返回任务列表</Link>
        <Notice kind="error">
          {task.error.message} <Button onClick={() => void task.refetch()}>重试</Button>
        </Notice>
      </main>
    );
  return (
    <main className="editor-page">
      <div className="editor-heading row">
        <Link to="/tasks" className="muted">
          ‹ 返回任务列表
        </Link>
        <h1>{task.data?.name ?? '新建剪辑'}</h1>
        {task.data && (
          <Button
            onClick={() => {
              setName(task.data!.name);
              setRename(true);
            }}
          >
            重命名
          </Button>
        )}
        <span className="badge">{id ? '所有更改已保存' : '上传完成后创建任务'}</span>
        <Button disabled className="push-right">
          下载成品
        </Button>
      </div>
      <div className="workspace-grid">
        <div className="workspace-left">
          <section className="panel preview-panel">
            <h2>主视频预览</h2>
            <div className="preview-surface">
              <EmptyState title="添加片段后在此预览主视频" />
            </div>
            <div className="player-controls">
              <Button disabled>播放全部</Button>
              <span>00:00:00 / --:--:--</span>
              <label className="push-right">
                音量 <input type="range" aria-label="播放音量" disabled />
              </label>
              <span>1.0x</span>
            </div>
          </section>
          <section className="panel timeline-panel">
            <div className="row between">
              <h2>时间轴</h2>
              <span className="muted">
                时间：分:秒:帧{' '}
                <span
                  className="help"
                  tabIndex={0}
                  aria-label="时间格式说明"
                  title="时间格式为 时:分:秒:帧；未满一小时可省略小时。每秒 30 帧，帧编号为 0～29。例如 00:05:12 表示 5 秒第 12 帧，01:00:05:12 表示 1 小时 0 分 5 秒第 12 帧。"
                >
                  ?
                </span>
              </span>
            </div>
            <div className="timeline-empty">暂无片段 · 在右侧发送指令并确认后添加</div>
          </section>
          <MediaLibrary projectId={id} />
          <p className="muted editor-note">
            完整上传即保存；统一转换为 30 帧 / 秒后可查看帧图并用于剪辑。
          </p>
        </div>
        <section className="panel chat-panel">
          <h2>对话剪辑</h2>
          <p className="muted">每条消息只处理一个操作</p>
          <div className="chat-empty">
            <strong>先上传素材，再告诉我怎么剪</strong>
            <p className="muted">可以这样说：</p>
            <p className="shaded">截取 V1 的 5 秒到 8 秒，追加到末尾</p>
            <p className="shaded">把 Clip2 移到 Clip1 前面</p>
            <p className="shaded">复制 Clip1，放到末尾</p>
            <p className="muted">确认操作后才会保存剪辑结果。</p>
          </div>
          <div className="chat-composer">
            <textarea aria-label="输入剪辑指令" placeholder="素材处理完成后可发送指令" disabled />
            <div className="row between">
              <small className="muted">时间示例：00:05:12</small>
              <Button disabled>发送</Button>
            </div>
          </div>
        </section>
      </div>
      <ConfirmDialog
        open={rename}
        title="重命名任务"
        confirmLabel="保存"
        onClose={() => setRename(false)}
        onConfirm={async () => {
          if (!name.trim()) throw new Error('请输入任务名称');
          await api(ProjectSchema, ApiRoutes.project(id!), {
            method: 'PATCH',
            body: JSON.stringify({ name: name.trim() }),
          });
          await Promise.all([
            qc.invalidateQueries({ queryKey: ['task', userId, id] }),
            qc.invalidateQueries({ queryKey: ['tasks'] }),
          ]);
        }}
      >
        <label htmlFor="task-name">任务名称</label>
        <input
          id="task-name"
          value={name}
          maxLength={120}
          onChange={(event) => setName(event.target.value)}
        />
      </ConfirmDialog>
    </main>
  );
}
