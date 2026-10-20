// Generates src/styles/tokens.css from src/tokens.ts. `--check` fails if the file is stale (CI).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderTokensCss } from '../src/css.ts';

const target = fileURLToPath(new URL('../src/styles/tokens.css', import.meta.url));
const expected = renderTokensCss();

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(target, 'utf8');
  } catch {
    // missing file is reported as stale below
  }
  if (current !== expected) {
    console.error('tokens.css is stale. Run: pnpm --filter @javis-dog/ui tokens:build');
    process.exit(1);
  }
  console.log('tokens.css is up to date.');
} else {
  writeFileSync(target, expected);
  console.log(`Wrote ${target}`);
}
