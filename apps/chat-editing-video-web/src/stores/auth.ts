import { create } from 'zustand';
import type { Session } from '@cev/shared';

interface AuthState {
  status: 'loading' | 'ready' | 'offline';
  token: string | null;
  session: Session | null;
  notice: string | null;
}

export const useAuth = create<AuthState>(() => ({
  status: 'loading',
  token: null,
  session: null,
  notice: null,
}));
