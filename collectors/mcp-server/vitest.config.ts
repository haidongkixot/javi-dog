import { defineConfig } from 'vitest/config';

// The interop test spawns a real node process and connects the official SDK client to it.
export default defineConfig({
  test: { testTimeout: 30_000, hookTimeout: 30_000 },
});
