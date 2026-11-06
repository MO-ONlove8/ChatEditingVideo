import type { AppInfo, DesktopApi } from '@cev/shared';

/** `window.desktop` exists only inside Electron (exposed by the preload script). */
export function getDesktop(): DesktopApi | undefined {
  return typeof window !== 'undefined' ? window.desktop : undefined;
}

export const isDesktop = () => getDesktop() !== undefined;

let appInfo: AppInfo | undefined;

/** Resolved once at startup (see main.tsx). */
export async function initRuntime(): Promise<void> {
  appInfo = await getDesktop()?.getAppInfo();
}

/**
 * Browser: same-origin `/api` (Vite proxy in dev, reverse proxy in prod).
 * Desktop: absolute URL supplied by the main process.
 */
export function apiBaseUrl(): string {
  return appInfo?.apiBaseUrl ?? import.meta.env.VITE_API_BASE_URL ?? '/api';
}

export const runtimeInfo = () => appInfo;
