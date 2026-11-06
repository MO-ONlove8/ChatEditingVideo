import { defineConfig } from 'electron-vite';

/**
 * Only main + preload are built here. The renderer IS the web app
 * (apps/chat-editing-video-web): loaded from its Vite dev server in dev,
 * and from its built dist via the app:// protocol in production.
 *
 * Dependencies are bundled (externalizeDeps: false) so the packaged app needs no
 * node_modules — this avoids pnpm-symlink packaging issues entirely.
 */
export default defineConfig({
  main: {
    build: {
      externalizeDeps: false,
      outDir: 'out/main',
      rollupOptions: { external: ['electron'] },
    },
  },
  preload: {
    build: {
      externalizeDeps: false,
      outDir: 'out/preload',
      rollupOptions: {
        external: ['electron'],
        // Sandboxed preloads must be CommonJS.
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
});
