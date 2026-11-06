import path from 'node:path';

export const APP_SCHEME = 'app';
export const APP_HOST = 'local';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

/**
 * Maps an app://local/... URL to a file inside `root`.
 * - Rejects other hosts and any path that escapes `root` (returns null → 404).
 * - Extension-less paths are SPA routes → index.html.
 */
export function resolveAppFile(root: string, requestUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${APP_SCHEME}:` || url.host !== APP_HOST) return null;

  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (pathname.includes('\0')) return null;

  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, '.' + path.posix.normalize('/' + pathname));
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) return null;

  if (target === resolvedRoot || path.extname(target) === '') {
    return path.join(resolvedRoot, 'index.html');
  }
  return target;
}
