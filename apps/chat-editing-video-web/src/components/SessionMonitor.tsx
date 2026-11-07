import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiRoutes, SessionEventSchema, SessionSchema } from '@cev/shared';
import { useAuth } from '../stores/auth';
import { api, apiFetch } from '../lib/api';
import { endSession } from '../lib/session';
import { readSseJson } from '../lib/sse';
import { cancelUploads, useUploads } from '../stores/uploads';

export function SessionMonitor() {
  const token = useAuth((s) => s.token);
  const qc = useQueryClient();
  useEffect(() => {
    qc.clear();
    if (!token) return;
    const abort = new AbortController();
    let checking = false;
    const check = async () => {
      if (checking || abort.signal.aborted) return;
      checking = true;
      try {
        await api(SessionSchema, ApiRoutes.authMe, { signal: abort.signal });
      } catch {
        /* HTTP 401 is handled centrally; network errors preserve the session. */
      } finally {
        checking = false;
      }
    };
    const follow = async () => {
      while (!abort.signal.aborted) {
        try {
          const response = await apiFetch(ApiRoutes.authEvents, { signal: abort.signal });
          for await (const raw of readSseJson(response)) {
            const event = SessionEventSchema.parse(raw);
            if (event.type === 'session-ended') {
              endSession(token, event.code === 'SESSION_LOGGED_OUT' ? null : event.message);
              return;
            }
          }
        } catch {
          /* Poll and reconnect cover interrupted event connections. */
        }
        if (abort.signal.aborted || useAuth.getState().token !== token) return;
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            abort.signal.removeEventListener('abort', done);
            resolve();
          };
          const timer = setTimeout(done, 3000);
          abort.signal.addEventListener('abort', done, { once: true });
        });
      }
    };
    void follow();
    const timer = setInterval(() => void check(), 15_000);
    const visible = () => {
      if (document.visibilityState === 'visible') void check();
    };
    window.addEventListener('focus', visible);
    document.addEventListener('visibilitychange', visible);
    return () => {
      abort.abort();
      clearInterval(timer);
      if (useAuth.getState().token !== token) {
        void cancelUploads().catch(() => {});
        useUploads.setState({ entries: [] });
      }
      window.removeEventListener('focus', visible);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [token, qc]);
  return null;
}
