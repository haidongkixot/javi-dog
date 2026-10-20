// Root ESLint flat config. Module boundaries (ADR-0001): a module may only be
// imported through its package name and public exports, never by path.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/dist/**',
      '**/.turbo/**',
      '**/next-env.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@javis-dog/*/src/*', '@javis-dog/*/src'],
              message: 'Import modules through their public entry point (ADR-0001).',
            },
            {
              group: ['**/packages/*/src/**', '**/collectors/*/src/**', '**/apps/*/src/**'],
              message: 'Cross-module relative imports are forbidden (ADR-0001).',
            },
          ],
        },
      ],
    },
  },
);
