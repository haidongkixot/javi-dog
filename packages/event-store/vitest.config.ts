import { defineConfig } from 'vitest/config';

// PGlite boots a WASM Postgres; a cold start can exceed Vitest's 5 s default.
export default defineConfig({
  test: { testTimeout: 30_000, hookTimeout: 30_000 },
});
