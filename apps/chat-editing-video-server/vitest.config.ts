import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC is required so Nest's decorators + emitDecoratorMetadata work under Vitest.
const swcPlugin = swc.vite({ module: { type: 'es6' } });

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [swcPlugin],
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/**/*.spec.ts', 'test/unit/**/*.spec.ts'],
        },
      },
      {
        plugins: [swcPlugin],
        test: {
          name: 'integration',
          environment: 'node',
          include: ['test/integration/**/*.spec.ts'],
          // Needs PostgreSQL + Redis running (pnpm db:up && pnpm db:migrate).
          testTimeout: 30_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
