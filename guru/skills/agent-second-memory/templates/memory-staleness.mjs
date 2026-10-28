#!/usr/bin/env node
// Memory staleness check (dependency-free, Node >= 18). Read-only.
//
// Flags the drift that a "walk every section" rule alone did not prevent in the origin:
//   1. A memory/readiness file whose "Last updated: YYYY-MM-DD" is older than the newest
//      session-log entry ("## YYYY-MM-DD ..." headings).
//   2. Iteration records older than the newest K that are still not closed, or whose Retro
//      section is empty.
//
// Usage:
//   node memory-staleness.mjs --log docs/memory/SESSION_LOG.md \
//     --dated docs/memory/PROJECT_MEMORY.md --dated docs/agent-ops/READINESS_MATRIX.md \
//     --iterations docs/sprints --keep-open 2 [--warn-only]
//   node memory-staleness.mjs --self-test
//
// Exit 1 on findings (0 with --warn-only), 2 on usage errors.
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DATE = /(\d{4}-\d{2}-\d{2})/;

export const newestLogDate = (text) => {
  let newest = null;
  for (const m of text.matchAll(/^##\s+(\d{4}-\d{2}-\d{2})/gm))
    if (!newest || m[1] > newest) newest = m[1];
  return newest;
};

export const lastUpdated = (text) => {
  const line = text.split('\n').find((l) => /last updated/i.test(l));
  return line?.match(DATE)?.[1] ?? null;
};

const section = (text, name) => {
  const re = new RegExp(`^##\\s+${name}\\b[^\\n]*\\n([\\s\\S]*?)(?=^##\\s|$(?![\\s\\S]))`, 'm');
  const m = text.match(re);
  return m ? m[1].trim() : null;
};

export const iterationFindings = (files, keepOpen) => {
  // files: [{ name, text }] sorted oldest → newest by name
  const findings = [];
  const older = files.slice(0, Math.max(0, files.length - keepOpen));
  for (const { name, text } of older) {
    const status = text.match(/Status:\s*\**([A-Z][A-Z -]+[A-Z])\**/)?.[1] ?? 'UNKNOWN';
    if (!/CLOSED|DONE/.test(status))
      findings.push(`${name}: status "${status}" but newer iterations exist`);
    const retro = section(text, 'Retro');
    if (retro !== null && retro.length === 0) findings.push(`${name}: Retro section is empty`);
  }
  return findings;
};

export const check = ({ logText, dated, iterations, keepOpen }) => {
  const findings = [];
  const newest = newestLogDate(logText);
  if (!newest) findings.push('session log: no "## YYYY-MM-DD" entry found');
  for (const { name, text } of dated) {
    const d = lastUpdated(text);
    if (!d) findings.push(`${name}: no "Last updated: YYYY-MM-DD" line`);
    else if (newest && d < newest)
      findings.push(`${name}: last updated ${d}, newest session-log entry ${newest}`);
  }
  findings.push(...iterationFindings(iterations, keepOpen));
  return findings;
};

const selfTest = () => {
  const dir = mkdtempSync(join(tmpdir(), 'memstale-'));
  try {
    const it = join(dir, 'it');
    mkdirSync(it);
    writeFileSync(join(it, 'IT-01.md'), '# 1\n- Status: **CLOSED**\n\n## Retro\n\n- ok\n');
    writeFileSync(join(it, 'IT-02.md'), '# 2\n- Status: **IN PROGRESS**\n\n## Retro\n\n## Guru\n');
    writeFileSync(join(it, 'IT-03.md'), '# 3\n- Status: **ACTIVE**\n\n## Retro\n');
    const iterations = readIterations(it);
    const bad = check({
      logText: '## 2026-01-05 · s\n## 2026-01-03 · s\n',
      dated: [{ name: 'memory', text: '> Last updated: 2026-01-03' }],
      iterations,
      keepOpen: 1,
    });
    const good = check({
      logText: '## 2026-01-05 · s\n',
      dated: [{ name: 'memory', text: '> Last updated: 2026-01-05' }],
      iterations: iterations.slice(0, 1),
      keepOpen: 1,
    });
    const expect = [
      'memory: last updated 2026-01-03, newest session-log entry 2026-01-05',
      'IT-02.md: status "IN PROGRESS" but newer iterations exist',
      'IT-02.md: Retro section is empty',
    ];
    const ok = expect.every((e) => bad.includes(e)) && bad.length === 3 && good.length === 0;
    console.log(
      ok ? 'self-test PASS' : `self-test FAIL\n${JSON.stringify({ bad, good }, null, 2)}`,
    );
    return ok ? 0 : 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

function readIterations(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md') && !f.startsWith('_'))
    .sort()
    .map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') }));
}

const main = (argv) => {
  if (argv.includes('--self-test')) return selfTest();
  const get = (flag) => argv.flatMap((a, i) => (a === flag ? [argv[i + 1]] : []));
  const [log] = get('--log');
  const [iterDir] = get('--iterations');
  if (!log) {
    console.error(
      'usage: memory-staleness.mjs --log <file> [--dated <file>]... [--iterations <dir>] [--keep-open N] [--warn-only]',
    );
    return 2;
  }
  const keepOpen = Number(get('--keep-open')[0] ?? 2);
  const findings = check({
    logText: readFileSync(log, 'utf8'),
    dated: get('--dated').map((name) => ({ name, text: readFileSync(name, 'utf8') })),
    iterations: iterDir ? readIterations(iterDir) : [],
    keepOpen,
  });
  for (const f of findings) console.log(`STALE ${f}`);
  console.log(findings.length ? `${findings.length} finding(s)` : 'memory staleness: 0 findings');
  return findings.length && !argv.includes('--warn-only') ? 1 : 0;
};

process.exitCode = main(process.argv.slice(2));
