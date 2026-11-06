import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ExecutorKind } from '@cev/shared';

interface SettingsState {
  /** Where edit plans render. Desktop-only option is ignored in the browser. */
  executor: ExecutorKind;
  setExecutor: (kind: ExecutorKind) => void;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      executor: 'server',
      setExecutor: (executor) => set({ executor }),
    }),
    { name: 'cev-settings' },
  ),
);
