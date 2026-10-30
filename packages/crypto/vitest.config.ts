import { defineConfig } from 'vitest/config';

// Node environment by default (Node's WebCrypto). test/browser-env.test.ts opts into jsdom.
export default defineConfig({ test: {} });
