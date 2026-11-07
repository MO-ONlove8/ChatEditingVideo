export const EDIT_QUEUE = 'edit-render';

export interface EditJobData {
  jobId: string;
  generation?: number;
}

/** Redis pub/sub channel carrying JobEvents for one job (worker → SSE subscribers). */
export const jobEventsChannel = (jobId: string) => `cev:job-events:${jobId}`;
