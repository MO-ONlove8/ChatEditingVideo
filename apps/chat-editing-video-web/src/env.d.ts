/// <reference types="vite/client" />
import type { DesktopApi } from '@cev/shared';

declare global {
  interface ImportMetaEnv {
    /** Override the API base URL for browser builds (default: same-origin /api). */
    readonly VITE_API_BASE_URL?: string;
  }

  interface Window {
    /** Present only when running inside the Electron desktop shell. */
    desktop?: DesktopApi;
  }
}

export {};
