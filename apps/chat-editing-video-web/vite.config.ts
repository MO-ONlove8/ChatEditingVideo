import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const apiTarget = process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Absolute base works for both web deploy (/) and Electron's app://local/ protocol.
  base: '/',
  server: {
    port: 5173,
    strictPort: true,
    // Browser dev: same-origin /api → NestJS, so no CORS needed in the browser.
    proxy: { '/api': { target: apiTarget, changeOrigin: true } },
  },
  preview: {
    port: 4173,
    strictPort: true,
    proxy: { '/api': { target: apiTarget, changeOrigin: true } },
  },
  build: { outDir: 'dist', sourcemap: true },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
