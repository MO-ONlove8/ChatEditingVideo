import { Link, useParams } from 'react-router';
import { useEditor } from '../../lib/editing';
import { TimelinePlayer } from '../../components/TimelinePlayer';
import { ExportControl } from '../../components/ExportControl';
import { Notice } from '../../components/Notice';
import common from '../../styles/common.module.less';
import buttonStyles from '../../components/Button/index.module.less';
import styles from './index.module.less';

export function PlayerPage() {
  const { id } = useParams(),
    editor = useEditor(id);
  return (
    <main className={common.pageWidth}>
      <div className={common.pageHeading}>
        <div className={common.row}>
          <Link to="/tasks" className={common.muted}>
            ‹ 返回任务列表
          </Link>
          <h1>{editor.data?.project.name ?? '播放主视频'}</h1>
        </div>
        <div className={common.row}>
          <Link className={buttonStyles.button} to={`/tasks/${id}/edit`}>
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
          <section className={`${common.panel} ${styles.standalonePlayer}`}>
            <TimelinePlayer timeline={editor.data.timeline} standalone />
          </section>
        )
      )}
    </main>
  );
}
