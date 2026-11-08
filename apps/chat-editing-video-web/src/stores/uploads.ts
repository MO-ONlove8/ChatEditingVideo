import { create } from 'zustand';

interface UploadEntry {
  id: string;
  cancel: () => Promise<void>;
}
export const useUploads = create<{ entries: UploadEntry[]; internalPath: string | null }>(() => ({
  entries: [],
  internalPath: null,
}));
export function registerUpload(id: string, cancel: () => Promise<void>) {
  useUploads.setState((s) => ({
    entries: [...s.entries.filter((entry) => entry.id !== id), { id, cancel }],
  }));
  return () =>
    useUploads.setState((s) => ({ entries: s.entries.filter((entry) => entry.id !== id) }));
}
export async function cancelUploads() {
  const snapshot = useUploads.getState().entries;
  await Promise.all(
    snapshot.map(async (entry) => {
      await entry.cancel();
      useUploads.setState((s) => ({ entries: s.entries.filter((item) => item !== entry) }));
    }),
  );
}
