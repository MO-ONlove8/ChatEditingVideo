/** HTTP API contract. Paths are relative to the API base URL (which already includes /api). */
export const API_PREFIX = '/api';

export const ApiRoutes = {
  authCode: '/auth/code',
  authLogin: '/auth/login',
  authMe: '/auth/me',
  authLogout: '/auth/logout',
  authEvents: '/auth/events',
  health: '/health',
  projects: '/projects',
  project: (id: string) => `/projects/${encodeURIComponent(id)}`,
  projectMedia: (projectId: string) => `/projects/${encodeURIComponent(projectId)}/media`,
  mediaPolicy: '/media/policy',
  uploads: '/uploads',
  upload: (id: string) => `/uploads/${encodeURIComponent(id)}`,
  uploadContent: (id: string) => `/uploads/${encodeURIComponent(id)}/content`,
  media: (id: string) => `/media/${encodeURIComponent(id)}`,
  mediaRetry: (id: string) => `/media/${encodeURIComponent(id)}/retry`,
  mediaEvents: (id: string) => `/projects/${encodeURIComponent(id)}/media/events`,
  thumbnails: (id: string, page: number) =>
    `/media/${encodeURIComponent(id)}/thumbnails?page=${page}`,
  frames: (id: string, second: number) =>
    `/media/${encodeURIComponent(id)}/frames?second=${second}`,
  frameImage: (id: string, frame: number) =>
    `/media/${encodeURIComponent(id)}/frames/${frame}/image`,
  chatStream: '/chat/stream',
  jobs: '/jobs',
  job: (id: string) => `/jobs/${encodeURIComponent(id)}`,
  jobEvents: (id: string) => `/jobs/${encodeURIComponent(id)}/events`,
  editorState: (id: string) => `/projects/${encodeURIComponent(id)}/editor-state`,
  projectChat: (id: string) => `/projects/${encodeURIComponent(id)}/chat`,
  projectChatStream: (id: string) => `/projects/${encodeURIComponent(id)}/chat/stream`,
  proposalConfirm: (id: string, proposal: string) =>
    `/projects/${encodeURIComponent(id)}/proposals/${encodeURIComponent(proposal)}/confirm`,
  proposalCancel: (id: string, proposal: string) =>
    `/projects/${encodeURIComponent(id)}/proposals/${encodeURIComponent(proposal)}/cancel`,
  clip: (id: string, clip: string) =>
    `/projects/${encodeURIComponent(id)}/clips/${encodeURIComponent(clip)}`,
  jobRetry: (id: string) => `/jobs/${encodeURIComponent(id)}/retry`,
  jobContent: (id: string) => `/jobs/${encodeURIComponent(id)}/content`,
  jobDownloadTicket: (id: string) => `/jobs/${encodeURIComponent(id)}/download-ticket`,
  jobDownload: (id: string) => `/jobs/${encodeURIComponent(id)}/download`,
} as const;

/** Uniform error body returned by the server for 4xx/5xx. */
export interface ApiErrorBody {
  statusCode: number;
  message: string;
  code?: string;
  issues?: { path: string; message: string }[];
}
