import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Plugin (React) tests under test/web run in jsdom; everything else runs in node.
export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    passWithNoTests: true,
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
          exclude: ['test/web/**', 'node_modules/**'],
        },
      },
      {
        extends: true,
        test: {
          name: 'web',
          environment: 'jsdom',
          include: ['test/web/**/*.test.ts', 'test/web/**/*.test.tsx'],
        },
      },
    ],
  },
});
