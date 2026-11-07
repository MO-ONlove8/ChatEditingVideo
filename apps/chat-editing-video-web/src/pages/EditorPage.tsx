import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiRoutes, ProjectSchema } from '@cev/shared';
import { api } from '../lib/api';
import { useAuth } from '../stores/auth';
import { Button, ConfirmDialog, Notice } from '../components/ui';
import { EditorWorkspace } from '../components/EditorWorkspace';
import { ExportControl } from '../components/ExportControl';
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
        <div className="push-right">{task.data && <ExportControl project={task.data} />}</div>
      </div>
      <EditorWorkspace projectId={id} />
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
