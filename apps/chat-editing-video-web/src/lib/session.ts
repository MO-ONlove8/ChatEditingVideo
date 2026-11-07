import { ApiRoutes, LoginResultSchema, SessionSchema, type LoginInput } from '@cev/shared';
import { useAuth } from '../stores/auth';
import { api, ApiError } from './api';
import { getDesktop } from './runtime';

const KEY = 'cev-session';
export async function persistToken(token: string | null) {
  const desktop = getDesktop();
  if (desktop) {
    if (token) await desktop.saveSession(token);
    else await desktop.clearSession();
  } else {
    if (token) sessionStorage.setItem(KEY, token);
    else sessionStorage.removeItem(KEY);
  }
}

export function endSession(token: string, message: string | null) {
  if (useAuth.getState().token !== token) return;
  useAuth.setState({ token: null, session: null, status: 'ready', notice: message });
  void persistToken(null).catch(() => {
    /* A revoked token is rejected on the next launch. */
  });
}

export async function restoreSession() {
  let token: string | null = null;
  try {
    token = getDesktop() ? await getDesktop()!.readSession() : sessionStorage.getItem(KEY);
    if (!token) {
      useAuth.setState({ status: 'ready', token: null, session: null });
      return;
    }
    useAuth.setState({ token, status: 'loading' });
    const session = await api(SessionSchema, ApiRoutes.authMe);
    if (useAuth.getState().token === token) useAuth.setState({ session, status: 'ready' });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return;
    useAuth.setState({ status: token ? 'offline' : 'ready' });
  }
}

export async function login(input: LoginInput) {
  const result = await api(LoginResultSchema, ApiRoutes.authLogin, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  try {
    await persistToken(result.token);
  } catch (error) {
    // Keep the valid session usable in memory even when OS persistence is unavailable.
    useAuth.setState({ notice: error instanceof Error ? '登录状态暂时无法保存在此设备' : null });
  }
  useAuth.setState({
    token: result.token,
    session: { user: result.user, expiresAt: result.expiresAt },
    status: 'ready',
    notice: null,
  });
}

export async function logout() {
  const token = useAuth.getState().token;
  if (!token) return;
  try {
    await api(SessionSchema.optional(), ApiRoutes.authLogout, { method: 'POST' });
  } finally {
    endSession(token, null);
  }
}
