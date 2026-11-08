import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Used by `vite build` (package.json "build"). index.html lives in client/.
// Aliases match tsconfig.json paths: "@/*" -> client/src/*, "@shared/*" -> shared/*.
// Output goes to dist/public, where server/index.ts and server/vite.ts serve static files from.
// The dev server (server/vite.ts) uses configFile: false and does not read this file.
const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.resolve(root, 'client'),
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(root, 'client/src'),
      '@shared': path.resolve(root, 'shared'),
    },
  },
  build: {
    outDir: path.resolve(root, 'dist/public'),
    emptyOutDir: true,
  },
});
