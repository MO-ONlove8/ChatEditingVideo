import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiRoutes, ProjectSchema, formatTimecode, type Project } from '@cev/shared';
import { ExportControl } from '../components/ExportControl';
import { api, apiFetch } from '../lib/api';
import { useAuth } from '../stores/auth';
import { Button, ConfirmDialog, EmptyState, Notice } from '../components/ui';

export function useTasks() {
  const userId = useAuth((s) => s.session?.user.id);
  return useQuery({
    queryKey: ['tasks', userId],
    queryFn: ({ signal }) => api(ProjectSchema.array(), ApiRoutes.projects, { signal }),
    enabled: Boolean(userId),
    refetchInterval: (q) =>
      q.state.data?.some(
        (task) =>
          task.processingCount > 0 || ['queued', 'running'].includes(task.latestJob?.status ?? ''),
      )
        ? 2000
        : false,
  });
}

const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

export function TasksPage() {
  const tasks = useTasks();
  const qc = useQueryClient();
  const [deleting, setDeleting] = useState<Project | null>(null);
  return (
    <main className="tasks-page page-width">
      <div className="page-heading">
        <div>
          <h1>我的剪辑任务</h1>
          <p className="muted">按最近编辑时间排序</p>
        </div>
        <Link className="button primary" to="/tasks/new">
          ＋ 新建
        </Link>
      </div>
      {tasks.isPending && <Notice>正在加载任务…</Notice>}
      {tasks.error && (
        <Notice kind="error">
          无法加载任务：{tasks.error.message}{' '}
          <Button onClick={() => void tasks.refetch()}>重试</Button>
        </Notice>
      )}
      {tasks.data?.length === 0 && (
        <div className="panel">
          <EmptyState title="还没有剪辑任务">点击“新建”，上传第一个素材后开始剪辑。</EmptyState>
        </div>
      )}
      {Boolean(tasks.data?.length) && (
        <div className="table-wrap panel">
          <table className="tasks-table">
            <thead>
              <tr>
                <th>任务名称</th>
                <th>最近编辑</th>
                <th>主视频时长</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {tasks.data?.map((task) => (
                <tr key={task.id}>
                  <td>
                    <div className="task-name">
                      <span className="thumbnail-placeholder" aria-hidden="true">
                        ▷
                      </span>
                      <div>
                        <strong>{task.name}</strong>
                        <p className="muted">已自动保存</p>
                      </div>
                    </div>
                  </td>
                  <td>
                    <time dateTime={task.updatedAt}>
                      {dateFormatter.format(new Date(task.updatedAt))}
                    </time>
                  </td>
                  <td>{task.hasMainVideo ? formatTimecode(task.durationFrames) : '暂无主视频'}</td>
                  <td>
                    <span className="badge">
                      {task.deletionPending
                        ? '删除未完成'
                        : task.latestJob?.status === 'running' ||
                            task.latestJob?.status === 'queued'
                          ? `生成中 ${task.latestJob.progress}%`
                          : task.latestJob?.status === 'failed'
                            ? '生成失败'
                            : task.processingCount
                              ? `素材处理中 (${task.processingCount})`
                              : task.failedCount
                                ? `素材处理失败 (${task.failedCount})`
                                : task.mediaCount
                                  ? '素材已就绪'
                                  : '暂无素材'}
                    </span>
                  </td>
                  <td>
                    <div className="task-actions">
                      {task.hasMainVideo && !task.deletionPending ? (
                        <Link className="text-button" to={`/tasks/${task.id}/player`}>
                          查看
                        </Link>
                      ) : (
                        <Button disabled title="暂无主视频">
                          查看
                        </Button>
                      )}
                      {task.deletionPending ? (
                        <Button disabled>继续编辑</Button>
                      ) : (
                        <Link className="text-button" to={`/tasks/${task.id}/edit`}>
                          继续编辑
                        </Link>
                      )}
                      <ExportControl project={task} compact />
                      <Button onClick={() => setDeleting(task)}>
                        {task.deletionPending ? '重试删除' : '删除'}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted page-note">返回列表或关闭应用，已开始的服务端处理仍会继续。</p>
      <ConfirmDialog
        open={Boolean(deleting)}
        title="删除任务？"
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          try {
            await apiFetch(ApiRoutes.project(deleting!.id), { method: 'DELETE' });
          } finally {
            await qc.invalidateQueries({ queryKey: ['tasks'] });
          }
        }}
      >
        <p>将删除「{deleting?.name}」及其素材、聊天记录和全部剪辑结果。</p>
        <p className="muted">删除后不可恢复。</p>
      </ConfirmDialog>
    </main>
  );
}
