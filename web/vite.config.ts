import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const webRoot = fileURLToPath(new URL('.', import.meta.url));
const sharedEntry = fileURLToPath(new URL('../shared/src/index.ts', import.meta.url));

export default defineConfig({
  // Fijado de forma explicita: `vite build --config web/vite.config.ts` desde la raiz
  // produce exactamente lo mismo que `pnpm --filter @payblink/web build` desde `web/`.
  root: webRoot,
  plugins: [react()],
  resolve: {
    alias: {
      '@payblink/shared': sharedEntry,
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
