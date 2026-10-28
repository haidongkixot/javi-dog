// Bounded ingest load test (S5a R6, ADR-0015 §6). Run once, by the orchestrator, against the
// ephemeral load-test project. Not part of `pnpm test`; the logic lives in load-test-lib.ts.
//   INGEST_URL=<…/api/v1/events> LOAD_TOKEN_FILE=<file> LOAD_OUT=<summary.json> \
//     [LOAD_PROJECT_REF=<project slug>] pnpm --filter @javis-dog/ingest load:test
// Caps (CAPS in load-test-lib.ts) are fixed in code: no flag or env var changes them.
// The token is read from LOAD_TOKEN_FILE and only ever sent as a bearer header: it is never
// printed, logged or written to the summary. Exit 0 only if every request got 202 and every
// event was accepted; 1 otherwise; 2 for a usage error (nothing sent).
import { readFile, writeFile } from 'node:fs/promises';
import {
  DEFAULT_PROJECT_REF,
  exitCodeFor,
  runLoadTest,
  type LoadSummary,
} from './load-test-lib.ts';

const TOKEN = /^jd_it_[A-Za-z0-9_-]{43}$/;
const REF = /^[A-Za-z0-9_:-]{1,128}$/;

const fail = (message: string): never => {
  console.error(message);
  process.exit(2);
};

const endpoint = (value: string | undefined) => {
  if (!value) return fail('INGEST_URL is not set (no default: name the endpoint explicitly).');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail('INGEST_URL is not a valid URL.');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!(url.protocol === 'https:' || (local && url.protocol === 'http:'))) {
    return fail('INGEST_URL must be https:// (http:// only for localhost).');
  }
  if (url.username || url.password) return fail('INGEST_URL must not contain credentials.');
  return url.href;
};

const readToken = async (path: string | undefined) => {
  if (!path) return fail('LOAD_TOKEN_FILE is not set.');
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    // The error code only: never the file contents.
    return fail(`Cannot read LOAD_TOKEN_FILE (${(e as NodeJS.ErrnoException).code ?? 'error'}).`);
  }
  const token = text.trim();
  if (!TOKEN.test(token)) return fail('LOAD_TOKEN_FILE does not hold one ingest token (jd_it_…).');
  return token;
};

const url = endpoint(process.env.INGEST_URL);
const token = await readToken(process.env.LOAD_TOKEN_FILE);
const projectRef = process.env.LOAD_PROJECT_REF?.trim() || DEFAULT_PROJECT_REF;
if (!REF.test(projectRef))
  fail('LOAD_PROJECT_REF must be a project slug (letters, digits, _ : -).');
const out = process.env.LOAD_OUT?.trim();

let summary: LoadSummary;
try {
  summary = await runLoadTest({ url, token, projectRef });
} catch (e) {
  // Generator or validation failure before any request; the class only.
  console.error(`Load test did not run: ${e instanceof Error ? e.message : typeof e}`);
  process.exit(1);
}

if (out) await writeFile(out, `${JSON.stringify(summary, null, 2)}\n`);
const ms = (v: number | null) => (v === null ? 'n/a' : `${Math.round(v)} ms`);
const line = (
  name: string,
  s: { count: number; p50: number | null; p95: number | null; max: number | null },
) => console.log(`${name}: n=${s.count} p50 ${ms(s.p50)} · p95 ${ms(s.p95)} · max ${ms(s.max)}`);
console.log(`${summary.pass ? 'PASS' : 'FAIL'} load test → ${summary.endpoint}`);
console.log(
  `Requests ${summary.requests.sent}/${summary.requests.planned} ${JSON.stringify(summary.requests.byStatus)} in ${(summary.wallMs / 1000).toFixed(1)} s`,
);
console.log(
  `Events sent ${summary.events.sent}, accepted ${summary.events.accepted}, duplicates ${summary.events.duplicates}, rejected ${summary.events.rejected}`,
);
line('Latency (all)', summary.latencyMs);
line('Latency (typical)', summary.phases.typical.latencyMs);
line('Latency (near-limit)', summary.phases.near_limit.latencyMs);
if (summary.nearLimit) {
  console.log(
    `Near-limit payload: ${summary.nearLimit.maxRawBytes} B raw, ${summary.nearLimit.maxGzipBytes} B gzip`,
  );
}
if (summary.stoppedEarly) console.log(`Stopped early: ${summary.stoppedEarly}`);
console.log(`Caps hit: ${JSON.stringify(summary.capsHit)}`);
if (out) console.log(`Summary written to ${out}`);
process.exit(exitCodeFor(summary));
