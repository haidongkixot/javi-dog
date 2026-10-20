// Dependency-free runner for shared protocol conformance vectors.
//
// Usage: node run-vectors.mjs <vectors-dir> <validator-module> [export-name]
//
// Each vector is a JSON file named valid-*.json or invalid-*.json:
//   { "description": "...", "receivedAt": "<RFC 3339>", "event": { ... },
//     "expect": { "ok": true } | { "codes": ["code_a", "code_b"] } }
//
// The validator module must export a function (default name: validateEvent) with the shape
//   (event, now: Date) => { ok: true } | { ok: false, issues: Array<{ code: string }> }
// Any language can reuse the same vectors; this file is only the JavaScript runner.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [dirArg, moduleArg, exportName = 'validateEvent'] = process.argv.slice(2);
if (!dirArg || !moduleArg) {
  console.error('Usage: node run-vectors.mjs <vectors-dir> <validator-module> [export-name]');
  process.exit(2);
}

const mod = await import(pathToFileURL(resolve(moduleArg)).href);
const validate = mod[exportName];
if (typeof validate !== 'function') {
  console.error(`Export "${exportName}" is not a function in ${moduleArg}`);
  process.exit(2);
}

const dir = resolve(dirArg);
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .sort();
const failures = [];

// Structure check: a vector set without both kinds proves only half the contract.
if (!files.some((f) => f.startsWith('valid-')) || !files.some((f) => f.startsWith('invalid-'))) {
  failures.push('vector set needs at least one valid-* and one invalid-* file');
}

const sameSet = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

for (const file of files) {
  const vector = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  const result = validate(vector.event, new Date(vector.receivedAt));
  const wantOk = vector.expect?.ok === true;

  if (wantOk !== file.startsWith('valid-')) {
    failures.push(`${file}: file prefix does not match expect`);
    continue;
  }
  if (wantOk) {
    if (!result.ok) failures.push(`${file}: expected ok, got ${JSON.stringify(result.issues)}`);
    continue;
  }
  if (result.ok) {
    failures.push(`${file}: expected rejection, got ok`);
    continue;
  }
  const got = [...new Set(result.issues.map((i) => i.code))].sort();
  const want = [...new Set(vector.expect.codes)].sort();
  if (!sameSet(got, want)) {
    failures.push(`${file}: expected codes ${want.join(',')}, got ${got.join(',')}`);
  }
}

for (const f of failures) console.error(`FAIL ${f}`);
console.log(`${files.length} vectors, ${failures.length} failures`);
process.exit(failures.length ? 1 : 0);
