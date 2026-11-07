import { Link, useParams } from 'react-router';
import { Button, EmptyState, Notice } from '../components/ui';
import { useTask } from './EditorPage';

export function PlayerPage() {
  const { id } = useParams();
  const task = useTask(id);
  return (
    <main className="player-page page-width">
      <div className="page-heading">
        <div className="row">
          <Link to="/tasks" className="muted">
            ‹ 返回任务列表
          </Link>
          <h1>{task.data?.name ?? '播放成品'}</h1>
        </div>
        <div className="row">
          <Link className="button" to={`/tasks/${id}/edit`}>
            继续编辑
          </Link>
          <Button disabled>下载成品</Button>
        </div>
      </div>
      {task.isPending ? (
        <Notice>正在加载任务…</Notice>
      ) : task.error ? (
        <Notice kind="error">{task.error.message}</Notice>
      ) : (
        <section className="panel standalone-player">
          <div className="preview-surface">
            <EmptyState title="暂无主视频">确认剪辑结果后，可在此播放成品。</EmptyState>
          </div>
          <input type="range" aria-label="播放进度" disabled />
          <div className="player-controls">
            <Button disabled aria-label="播放">
              ▶
            </Button>
            <span>00:00 / --:--</span>
            <select aria-label="播放倍速" className="push-right" disabled>
              <option>1.0x</option>
            </select>
            <label>
              音量 <input type="range" aria-label="播放音量" disabled />
            </label>
            <Button disabled>全屏</Button>
          </div>
        </section>
      )}
      <p className="muted page-note">播放音量不改变导出音量</p>
    </main>
  );
}
