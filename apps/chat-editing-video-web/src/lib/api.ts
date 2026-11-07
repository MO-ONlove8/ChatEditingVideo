import type { z } from 'zod';
import type { ApiErrorBody } from '@cev/shared';
import { apiBaseUrl } from './runtime';
import { useAuth } from '../stores/auth';
import { getDesktop } from './runtime';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiErrorBody | undefined,
  ) {
    super(body?.message ?? `HTTP ${status}`);
  }
}

/** Raw request; throws ApiError on non-2xx. */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const token = useAuth.getState().token;
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData) && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const res = await fetch(`${apiBaseUrl()}${path}`, { ...init, headers });
  if (!res.ok) {
    const body = (await res.json().catch(() => undefined)) as ApiErrorBody | undefined;
    if (res.status === 401 && token && useAuth.getState().token === token) {
      useAuth.setState({
        token: null,
        session: null,
        status: 'ready',
        notice: body?.message ?? '请重新登录',
      });
      if (getDesktop())
        void getDesktop()!
          .clearSession()
          .catch(() => {});
      else sessionStorage.removeItem('cev-session');
    }
    throw new ApiError(res.status, body);
  }
  return res;
}

/** JSON request whose response is validated with the shared zod schema. */
export async function api<T extends z.ZodType>(
  schema: T,
  path: string,
  init?: RequestInit,
): Promise<z.infer<T>> {
  const res = await apiFetch(path, init);
  if (res.status === 204) return schema.parse(undefined);
  return schema.parse(await res.json());
}
