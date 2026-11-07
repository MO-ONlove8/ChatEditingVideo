import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { EditJobSchema, ApiRoutes, type Project } from '@cev/shared';
import { api, apiFetch } from '../lib/api';
import { apiBaseUrl, getDesktop } from '../lib/runtime';
import { useAuth } from '../stores/auth';
import { Button, Notice } from './ui';

export function ExportControl({
  project,
  compact = false,
}: {
  project: Project;
  compact?: boolean;
}) {
  const [jobId, setJobId] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const lock = useRef(false),
    qc = useQueryClient(),
    user = useAuth((s) => s.session?.user.id);
  const [saving, setSaving] = useState<string | null>(null);
  const job = useQuery({
    queryKey: ['render', user, jobId ?? project.latestJob?.id],
    enabled: Boolean(user && (jobId ?? project.latestJob?.id)),
    queryFn: ({ signal }) =>
      api(EditJobSchema, ApiRoutes.job(jobId ?? project.latestJob!.id), { signal }),
    refetchInterval: (q) =>
      q.state.data && ['queued', 'running'].includes(q.state.data.status) ? 1000 : false,
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['tasks'] });
    void qc.invalidateQueries({ queryKey: ['editor'] });
  };
  const download = async () => {
    if (lock.current || !project.hasMainVideo) return;
    lock.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const current = await api(EditJobSchema, ApiRoutes.jobs, {
        method: 'POST',
        body: JSON.stringify({
          projectId: project.id,
          expectedRevision: project.timelineRevision,
          requestId: crypto.randomUUID(),
        }),
      });
      setJobId(current.id);
      qc.setQueryData(['render', user, current.id], current);
      refresh();
      if (current.status === 'succeeded') await save(current.id);
      else
        setNotice(
          current.status === 'failed'
            ? '该版本生成失败，可重试。'
            : '已加入后台生成；完成后点击保存到本地。',
        );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      lock.current = false;
    }
  };
  const save = async (id: string) => {
    const desktop = getDesktop();
    if (desktop) {
      setSaving(id);
      try {
        const result = await desktop.downloadRender(id);
        setNotice(result.cancelled ? '已取消保存' : '成品已保存到本地');
      } finally {
        setSaving(null);
      }
    } else {
      await apiFetch(`/jobs/${id}/download-ticket`, { method: 'POST' });
      const link = document.createElement('a');
      link.href = `${apiBaseUrl()}/jobs/${id}/download`;
      link.download = `video-v${job.data?.revision ?? project.timelineRevision}.mp4`;
      document.body.append(link);
      link.click();
      link.remove();
      setNotice('已开始下载');
    }
  };
  return (
    <div className={`export-control ${compact ? 'compact' : ''}`}>
      <Button
        disabled={busy || !project.hasMainVideo || project.deletionPending}
        onClick={() => void download()}
      >
        {busy ? '处理中…' : compact ? '下载' : '下载成品'}
      </Button>
      {saving && (
        <Button onClick={() => void getDesktop()?.cancelRenderDownload(saving)}>取消保存</Button>
      )}
      {job.data && (
        <div className="export-status">
          {['queued', 'running'].includes(job.data.status) && (
            <>
              <span>
                v{job.data.revision} · {job.data.status === 'queued' ? '等待生成' : '生成中'}{' '}
                {job.data.progress}%
              </span>
              <progress max={100} value={job.data.progress} />
            </>
          )}
          {job.data.status === 'failed' && (
            <>
              <span>生成失败：{job.data.error}</span>
              <Button
                disabled={busy}
                onClick={() => {
                  if (lock.current) return;
                  lock.current = true;
                  setBusy(true);
                  void api(EditJobSchema, `/jobs/${job.data!.id}/retry`, { method: 'POST' })
                    .then((value) => {
                      qc.setQueryData(['render', user, value.id], value);
                      setJobId(value.id);
                      refresh();
                    })
                    .catch((e) => setError(e.message))
                    .finally(() => {
                      setBusy(false);
                      lock.current = false;
                    });
                }}
              >
                重试生成
              </Button>
            </>
          )}
          {job.data.status === 'succeeded' && project.hasMainVideo && (
            <Button
              disabled={busy}
              onClick={() => {
                if (lock.current) return;
                lock.current = true;
                setBusy(true);
                void save(job.data!.id)
                  .catch((e) => setError(e.message))
                  .finally(() => {
                    setBusy(false);
                    lock.current = false;
                  });
              }}
            >
              保存v{job.data.revision}到本地
            </Button>
          )}
          {job.data.revision !== project.timelineRevision && (
            <small>存在更新后的剪辑版本；点击下载生成最新版本</small>
          )}
        </div>
      )}
      {error && <Notice kind="error">{error}</Notice>}
      {notice && <small role="status">{notice}</small>}
    </div>
  );
}
