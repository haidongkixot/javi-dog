import { defineConfig } from 'vitest/config';

// The end-to-end tests boot PGlite and spawn real node processes.
export default defineConfig({
  test: { testTimeout: 30_000, hookTimeout: 30_000 },
});
