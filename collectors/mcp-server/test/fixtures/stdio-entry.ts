// Test fixture: the smallest real stdio entry, as `javi mcp` (JD-C01) will wire it.
// Usage: node --no-warnings stdio-entry.ts <installed|missing>
import { serveStdio } from '../../src/index.ts';

const installed = process.argv[2] === 'installed';
await serveStdio(process.stdin, process.stdout, process.stderr, {
  version: '0.0.0-test',
  hooksInstalled: () => Promise.resolve(installed),
});
