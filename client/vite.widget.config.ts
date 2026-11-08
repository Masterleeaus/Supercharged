import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Builds the embeddable chat widget to one classic script: dist/widget/titan-chat.js.
// Run with: vite build --config client/vite.widget.config.ts
// The main app build (vite.config.ts) writes to dist/public and is not affected.
// Aliases match tsconfig.json paths: "@/*" -> client/src/*, "@shared/*" -> shared/*.
const clientDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(clientDir, '..');

export default defineConfig({
  root: clientDir,
  // Do not copy client/public into the widget output. The build ships only titan-chat.js.
  publicDir: false,
  resolve: {
    alias: {
      '@': path.resolve(clientDir, 'src'),
      '@shared': path.resolve(repoRoot, 'shared'),
    },
  },
  build: {
    outDir: path.resolve(repoRoot, 'dist/widget'),
    emptyOutDir: true,
    lib: {
      entry: path.resolve(clientDir, 'src/widget/index.ts'),
      name: 'TitanChat',
      formats: ['iife'],
      fileName: () => 'titan-chat.js',
    },
  },
});
