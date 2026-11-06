import type { z } from 'zod';
import type { ApiErrorBody } from '@cev/shared';
import { apiBaseUrl } from './runtime';

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
  if (init.body && !(init.body instanceof FormData) && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const res = await fetch(`${apiBaseUrl()}${path}`, { ...init, headers });
  if (!res.ok) {
    const body = (await res.json().catch(() => undefined)) as ApiErrorBody | undefined;
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
  return schema.parse(await res.json());
}
