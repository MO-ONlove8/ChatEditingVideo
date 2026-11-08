import { useEffect, useState } from 'react';
import { apiFetch } from '../../../../../../../lib/api';
import { useAuth } from '../../../../../../../stores/auth';

export function useBlob(path?: string, enabled = true) {
  const [result, setResult] = useState<{ path: string; url?: string; error?: string }>();
  const [attempt, setAttempt] = useState(0);
  const token = useAuth((s) => s.token);
  useEffect(() => {
    if (!path || !enabled) return;
    setResult(undefined);
    const abort = new AbortController();
    let url: string | undefined;
    void apiFetch(path, { signal: abort.signal })
      .then((response) => response.blob())
      .then((blob) => {
        if (abort.signal.aborted) return;
        url = URL.createObjectURL(blob);
        setResult({ path, url });
      })
      .catch((error) => {
        if (!abort.signal.aborted)
          setResult({ path, error: error instanceof Error ? error.message : '图片加载失败' });
      });
    return () => {
      abort.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [path, enabled, token, attempt]);
  return {
    ...(enabled && result?.path === path ? result : {}),
    retry: () => setAttempt((n) => n + 1),
  };
}
