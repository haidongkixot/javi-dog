// JD-M11 runs unchanged in Node 22 and in browsers (ADR-0018 "Consequences"): `src` may use
// WebCrypto (`globalThis.crypto.subtle`, `crypto.getRandomValues`) and other web-platform
// globals only. Node built-ins and Node-only globals are errors in `src`; tests may use them.
import root from '../../eslint.config.mjs';

const BOUNDARY_PATTERNS = [
  {
    group: ['@javis-dog/*/src/*', '@javis-dog/*/src'],
    message: 'Import modules through their public entry point (ADR-0001).',
  },
  {
    group: ['**/packages/*/src/**', '**/collectors/*/src/**', '**/apps/*/src/**'],
    message: 'Cross-module relative imports are forbidden (ADR-0001).',
  },
];

const NODE_ONLY = 'JD-M11 src must run in browsers: use WebCrypto and web-platform APIs only.';

export default [
  ...root,
  {
    files: ['src/**/*.ts'],
    rules: {
      // Repeats the root boundary patterns: a later rule entry replaces the earlier options.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...BOUNDARY_PATTERNS,
            { group: ['node:*'], message: NODE_ONLY },
            {
              group: ['crypto', 'buffer', 'fs', 'os', 'path', 'process', 'util', 'stream'],
              message: NODE_ONLY,
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'Buffer', message: NODE_ONLY },
        { name: 'process', message: NODE_ONLY },
        { name: 'require', message: NODE_ONLY },
        { name: '__dirname', message: NODE_ONLY },
        { name: 'global', message: NODE_ONLY },
      ],
    },
  },
];
