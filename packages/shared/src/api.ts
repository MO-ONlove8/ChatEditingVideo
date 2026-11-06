/** HTTP API contract. Paths are relative to the API base URL (which already includes /api). */
export const API_PREFIX = '/api';

export const ApiRoutes = {
  health: '/health',
  projects: '/projects',
  project: (id: string) => `/projects/${encodeURIComponent(id)}`,
  projectMedia: (projectId: string) => `/projects/${encodeURIComponent(projectId)}/media`,
  chatStream: '/chat/stream',
  jobs: '/jobs',
  job: (id: string) => `/jobs/${encodeURIComponent(id)}`,
  jobEvents: (id: string) => `/jobs/${encodeURIComponent(id)}/events`,
} as const;

/** Uniform error body returned by the server for 4xx/5xx. */
export interface ApiErrorBody {
  statusCode: number;
  message: string;
  issues?: { path: string; message: string }[];
}
