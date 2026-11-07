import { Link, useParams } from 'react-router';
import { useEditor } from '../lib/editing';
import { TimelinePlayer } from '../components/TimelinePlayer';
import { ExportControl } from '../components/ExportControl';
import { Notice } from '../components/ui';

export function PlayerPage() {
  const { id } = useParams(),
    editor = useEditor(id);
  return (
    <main className="player-page page-width">
      <div className="page-heading">
        <div className="row">
          <Link to="/tasks" className="muted">
            ‹ 返回任务列表
          </Link>
          <h1>{editor.data?.project.name ?? '播放主视频'}</h1>
        </div>
        <div className="row">
          <Link className="button" to={`/tasks/${id}/edit`}>
            继续编辑
          </Link>
          {editor.data && <ExportControl project={editor.data.project} />}
        </div>
      </div>
      {editor.isPending ? (
        <Notice>正在加载任务…</Notice>
      ) : editor.error ? (
        <Notice kind="error">{editor.error.message}</Notice>
      ) : (
        editor.data && (
          <section className="panel standalone-player">
            <TimelinePlayer timeline={editor.data.timeline} standalone />
          </section>
        )
      )}
    </main>
  );
}
