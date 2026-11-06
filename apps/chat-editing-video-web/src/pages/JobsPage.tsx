import { useState } from 'react';
import type { EditPlan, ExecutorKind } from '@cev/shared';
import { createExecutor } from '../lib/executor';
import { isDesktop } from '../lib/runtime';
import { useSettings } from '../stores/settings';
import { useProjects } from './ProjectsPage';

/** Placeholder plan until the chat → EditPlan flow is designed from the requirements doc. */
const SAMPLE_PLAN: EditPlan = {
  version: 1,
  clips: [{ source: 'sample.mp4', startSec: 0, endSec: 5 }],
  output: { container: 'mp4' },
};

export function JobsPage() {
  const projects = useProjects();
  const { executor, setExecutor } = useSettings();
  const desktop = isDesktop();
  const kind: ExecutorKind = desktop ? executor : 'server';
  const [projectId, setProjectId] = useState('');
  const [progress, setProgress] = useState<number>();
  const [result, setResult] = useState<string>();
  const [error, setError] = useState<string>();
  const [running, setRunning] = useState(false);

  const selectedProject = projectId || projects.data?.[0]?.id || '';

  const run = async () => {
    setRunning(true);
    setProgress(0);
    setResult(undefined);
    setError(undefined);
    try {
      const { output } = await createExecutor(kind, selectedProject).execute({
        jobId: crypto.randomUUID(),
        plan: SAMPLE_PLAN,
        onEvent: (e) => e.type === 'progress' && setProgress(e.progress),
      });
      setProgress(100);
      setResult(output);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  return (
    <section className="space-y-4">
      <h1 className="text-xl font-semibold">渲染任务</h1>

      <fieldset className="space-y-2">
        <legend className="font-medium">执行位置</legend>
        {(['server', 'desktop'] as const).map((k) => (
          <label key={k} className="mr-4 inline-flex items-center gap-1">
            <input
              type="radio"
              name="executor"
              value={k}
              checked={kind === k}
              disabled={k === 'desktop' && !desktop}
              onChange={() => setExecutor(k)}
            />
            {k === 'server' ? '服务端（BullMQ + SSE）' : '桌面端本地（IPC）'}
          </label>
        ))}
        {!desktop && <p className="text-sm text-neutral-500">浏览器版只能使用服务端执行。</p>}
      </fieldset>

      {kind === 'server' && (
        <div>
          <label htmlFor="job-project" className="mr-2">
            项目
          </label>
          <select
            id="job-project"
            value={selectedProject}
            onChange={(e) => setProjectId(e.target.value)}
            className="rounded border px-2 py-1 dark:bg-neutral-900"
          >
            {projects.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <button
        type="button"
        onClick={() => void run()}
        disabled={running || (kind === 'server' && !selectedProject)}
        className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50"
      >
        运行示例剪辑方案
      </button>

      {progress !== undefined && (
        <div>
          <label htmlFor="job-progress">进度 {progress}%</label>
          <progress id="job-progress" max={100} value={progress} className="ml-2 align-middle" />
        </div>
      )}
      {result && <p role="status">完成：{result}</p>}
      {error && (
        <p role="alert" className="text-red-600">
          {error}
        </p>
      )}
    </section>
  );
}
