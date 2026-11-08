import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiRoutes, MediaAssetSchema } from '@cev/shared';
import { api, apiFetch } from '../../../../../../../lib/api';
import { readSseJson } from '../../../../../../../lib/sse';
import { useAuth } from '../../../../../../../stores/auth';

export function useMedia(projectId?: string) {
  const userId = useAuth((s) => s.session?.user.id);
  const qc = useQueryClient();
  const key = ['media', userId, projectId];
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      api(MediaAssetSchema.array(), ApiRoutes.projectMedia(projectId!), { signal }),
    enabled: Boolean(projectId && userId),
    refetchInterval: 5000,
  });
  useEffect(() => {
    if (!projectId || !userId) return;
    const abort = new AbortController();
    void (async () => {
      try {
        const response = await apiFetch(ApiRoutes.mediaEvents(projectId), { signal: abort.signal });
        for await (const raw of readSseJson(response)) {
          const event = raw as { type: string; assets: unknown };
          if (event.type === 'media')
            qc.setQueryData(
              ['media', userId, projectId],
              MediaAssetSchema.array().parse(event.assets),
            );
        }
      } catch {
        /* Polling keeps the library current if the event stream is interrupted. */
      }
    })();
    return () => abort.abort();
  }, [projectId, userId, qc]);
  return query;
}
