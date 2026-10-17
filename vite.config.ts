import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// The host page and Plugin live in src/web; the built assets are served by the
// Express API_Server from dist/web so `npm start` runs as a single process.
const webRoot = fileURLToPath(new URL('./src/web', import.meta.url));
const outDir = fileURLToPath(new URL('./dist/web', import.meta.url));

export default defineConfig({
  root: webRoot,
  plugins: [react()],
  build: {
    outDir,
    emptyOutDir: true,
  },
});
