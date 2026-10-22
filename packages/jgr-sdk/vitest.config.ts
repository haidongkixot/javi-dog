import { defineConfig } from 'vitest/config';

// The end-to-end test boots PGlite (WASM Postgres); a cold start can exceed 5 s.
export default defineConfig({
  test: { testTimeout: 30_000, hookTimeout: 30_000 },
});
