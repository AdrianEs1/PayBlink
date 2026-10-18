import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const sharedEntry = fileURLToPath(new URL('./shared/src/index.ts', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@blinka/shared': sharedEntry,
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
    reporters: 'default',
    // Los tests de seguridad comparten el mismo archivo SQLite: sin paralelismo.
    fileParallelism: false,
    // Base de datos propia y temporal: `pnpm test` funciona con `pnpm dev` en marcha,
    // sin pelear por el archivo que el servidor mantiene abierto.
    // RNF-4 / CA-10: los tests nunca llaman a la API real.
    env: {
      BLINKA_DB_PATH: resolve(tmpdir(), 'blinka-test.sqlite'),
      LLM_MODE: 'fixture',
      GEMINI_API_KEY: '',
      // Los tests nunca tocan la réplica de Turso.
      TURSO_SYNC: '0',
    },
    sequence: { concurrent: false },
    testTimeout: 30_000,
  },
});
