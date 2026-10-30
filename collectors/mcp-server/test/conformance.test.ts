import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { describe, expect, it } from 'vitest';
import { matchPattern, type Json } from './conformance-pattern.ts';
import { openSession } from './conformance-session.ts';

// T5 (S5d): runner for the QA lane's agent self-report vectors, group M (JD-C03), in
// docs/jgr/conformance/self-report. Written from that README's "Runner rules" → "MCP steps";
// every expectation comes from the vector files, never from the implementation.
//
// - Layer: INSTANCE (README "MCP steps" → Layers). One fresh `serveStdio` per vector over
//   in-memory streams (test/conformance-session.ts); `hooksInstalled` = `server.hooksInstalled`.
//   The process layer (built `javi.mjs mcp` after `javi init`) is NOT RUN here (JD-C01 lane).
// - Each file is validated against schema.json first with Ajv (draft-07) through the
//   `@modelcontextprotocol/sdk` dev dependency's public `validation/ajv` export; no new
//   dependency. The R files are validated here too, because JD-M07 has no JSON-schema validator.
// - "No response" uses the ping barrier `{"jsonrpc":"2.0","id":"__barrier_<step index>",...}`
//   (step index 0-based), stdout/stderr rules, absent strings (global `SENTINEL` plus the
//   vector's list), text labels and the 20-line stderr cap across the whole run.

const DIR = fileURLToPath(new URL('../../../docs/jgr/conformance/self-report/', import.meta.url));
const RESPONSE_TIMEOUT_MS = 5_000;
const EXIT_TIMEOUT_MS = 2_000;
const MAX_STDERR_LINE = 200;
const MAX_DISTINCT_STDERR_LINES = 20;
const GLOBAL_ABSENT = 'SENTINEL';

interface McpStep {
  note: string;
  send: Json;
  rawLine: string | null;
  expect: Json;
}
interface McpVector {
  id: string;
  kind: 'mcp';
  description: string;
  ambiguities: string[];
  server: { hooksInstalled: boolean };
  steps: McpStep[];
  stderrForbidden: string[];
  absentStrings: string[];
}

const schema = JSON.parse(readFileSync(`${DIR}schema.json`, 'utf8')) as Record<string, unknown>;
const validate = new AjvJsonSchemaValidator().getValidator<unknown>(schema);
const read = (file: string) => JSON.parse(readFileSync(`${DIR}${file}`, 'utf8')) as unknown;
const vectorFiles = (prefix: 'M' | 'R') =>
  readdirSync(DIR)
    .filter((f) => new RegExp(`^${prefix}\\d{2}-[a-z0-9-]+\\.json$`).test(f))
    .sort();

const mFiles = vectorFiles('M');
const rFiles = vectorFiles('R');

/** Suite-wide state (README "Text labels", stderr "fixed strings" check). */
const labels = new Map<string, { text: string; where: string }>();
const stderrLines = new Map<string, string>();

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const short = (s: string) => (s.length > 200 ? `${s.slice(0, 197)}...` : s);

/** README "stdout": every line is a JSON-RPC 2.0 response. */
const responseProblem = (line: string): string | null => {
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    return 'not JSON';
  }
  if (!isObj(msg)) return 'not a JSON object';
  if (msg.jsonrpc !== '2.0') return 'jsonrpc is not "2.0"';
  if (!('id' in msg)) return 'no id';
  if (!(typeof msg.id === 'string' || typeof msg.id === 'number' || msg.id === null)) {
    return 'id is not a string, number or null';
  }
  if ('result' in msg === 'error' in msg) return 'not exactly one of result / error';
  return null;
};

const scan = (stream: string, text: string, needles: string[], why: string, out: string[]) => {
  for (const needle of needles) {
    if (text.includes(needle)) out.push(`${stream} contains ${JSON.stringify(needle)} (${why})`);
  }
};

const runVector = async (file: string, vector: McpVector): Promise<string[]> => {
  const failures: string[] = [];
  const session = openSession(vector.server.hooksInstalled);
  steps: for (const [i, step] of vector.steps.entries()) {
    const at = `step ${i} (${step.note})`;
    session.write(step.rawLine ?? JSON.stringify(step.send));

    if (step.expect === null) {
      // README "No response": the barrier ping answer must be the very next line.
      const id = `__barrier_${i}`;
      session.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'ping' }));
      const want = { jsonrpc: '2.0', id, result: {} };
      for (;;) {
        const line = await session.nextLine(RESPONSE_TIMEOUT_MS);
        if (line === null) {
          failures.push(`${at}: no barrier answer within ${RESPONSE_TIMEOUT_MS} ms`);
          break steps;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          parsed = undefined;
        }
        if (isDeepStrictEqual(parsed, want)) break;
        failures.push(`${at}: expected no response, got ${short(line)}`);
      }
      continue;
    }

    const line = await session.nextLine(RESPONSE_TIMEOUT_MS);
    if (line === null) {
      failures.push(`${at}: no response within ${RESPONSE_TIMEOUT_MS} ms`);
      break;
    }
    let parsed: Json;
    try {
      parsed = JSON.parse(line) as Json;
    } catch {
      failures.push(`${at}: response is not JSON: ${short(line)}`);
      continue;
    }
    if (!isObj(parsed) || parsed.jsonrpc !== '2.0') {
      failures.push(`${at}: response is not a JSON-RPC 2.0 object: ${short(line)}`);
      continue;
    }
    const result = matchPattern(step.expect, parsed);
    for (const e of result.errors) failures.push(`${at}: ${e} — line ${short(line)}`);
    if (result.errors.length === 0) {
      for (const seen of result.labels) {
        const first = labels.get(seen.label);
        const where = `${vector.id} ${at} ${seen.path}`;
        if (!first) labels.set(seen.label, { text: seen.text, where });
        else if (first.text !== seen.text) {
          failures.push(
            `${at}: label ${seen.label} text ${JSON.stringify(seen.text)} differs from ` +
              `${JSON.stringify(first.text)} first seen at ${first.where}`,
          );
        }
      }
    }
  }

  const end = await session.close(EXIT_TIMEOUT_MS);
  for (const line of end.trailing) failures.push(`stdout line after the last step: ${short(line)}`);
  if (end.partial !== '') {
    failures.push(`stdout bytes without a terminating newline: ${short(end.partial)}`);
  }
  for (const line of end.stdoutLines) {
    const problem = responseProblem(line);
    if (problem)
      failures.push(`stdout line is not a JSON-RPC 2.0 response (${problem}): ${short(line)}`);
  }
  const stdoutText = end.stdoutLines.join('\n');
  scan('stdout', stdoutText, [GLOBAL_ABSENT], 'global absent string', failures);
  scan('stdout', stdoutText, vector.absentStrings, 'absentStrings', failures);

  scan('stderr', end.stderr, [GLOBAL_ABSENT], 'global absent string', failures);
  scan('stderr', end.stderr, vector.absentStrings, 'absentStrings', failures);
  scan('stderr', end.stderr, vector.stderrForbidden, 'stderrForbidden', failures);
  for (const line of end.stderr.split('\n')) {
    if (line.length > MAX_STDERR_LINE) {
      failures.push(`stderr line longer than ${MAX_STDERR_LINE}: ${short(line)}`);
    }
    if (line !== '' && !stderrLines.has(line)) stderrLines.set(line, `${vector.id} (${file})`);
  }
  return failures;
};

describe('self-report conformance vectors: schema (README "Format")', () => {
  it('the validator rejects a broken vector (sanity: the check is not vacuous)', () => {
    const broken = read(mFiles[0] ?? '') as Record<string, unknown>;
    expect(validate(broken).valid).toBe(true);
    expect(validate({ ...broken, server: undefined, extra: 1 }).valid).toBe(false);
    expect(validate({ ...broken, steps: [] }).valid).toBe(false);
  });

  it('the suite has 22 M vectors and 18 R vectors (README "Vectors" totals)', () => {
    expect(mFiles).toHaveLength(22);
    expect(rFiles).toHaveLength(18);
  });

  it.each(rFiles)('%s validates against schema.json (JD-M07 has no validator)', (file) => {
    const v = validate(read(file));
    expect(v.errorMessage ?? null).toBeNull();
    expect(v.valid).toBe(true);
  });
});

describe('pattern language self-check (README "Pattern language")', () => {
  const ok = (p: Json, v: Json) => matchPattern(p, v).errors;
  it('compares primitives by JSON type and value', () => {
    expect(ok(42, 42)).toEqual([]);
    expect(ok(42, '42')).not.toEqual([]);
    expect(ok(null, false)).not.toEqual([]);
  });
  it('closed objects reject unlisted keys; $open allows them; optional matchers may be absent', () => {
    expect(ok({ a: 1 }, { a: 1, b: 2 })).not.toEqual([]);
    expect(ok({ $open: true, a: 1 }, { a: 1, b: 2 })).toEqual([]);
    expect(ok({ a: 1, b: { $match: 'any', optional: true } }, { a: 1 })).toEqual([]);
    expect(ok({ a: 1, b: { $match: 'any' } }, { a: 1 })).not.toEqual([]);
  });
  it('setEquals, unorderedArray, oneOf and string options', () => {
    const set: Json = { $match: 'setEquals', values: ['x', 'y'] };
    expect(ok(set, ['y', 'x'])).toEqual([]);
    expect(ok(set, ['x', 'x', 'y'])).not.toEqual([]);
    expect(ok(set, ['x'])).not.toEqual([]);
    const un: Json = { $match: 'unorderedArray', items: [{ n: 1 }, { n: 2 }] };
    expect(ok(un, [{ n: 2 }, { n: 1 }])).toEqual([]);
    expect(ok(un, [{ n: 2 }, { n: 2 }])).not.toEqual([]);
    const isErr: Json = { $match: 'oneOf', values: [false], optional: true };
    expect(ok({ isError: isErr }, {})).toEqual([]);
    expect(ok({ isError: isErr }, { isError: true })).not.toEqual([]);
    const text: Json = { $match: 'string', minLength: 1, noDeliveryClaim: true };
    expect(ok(text, "noted: javi's hooks record it")).toEqual([]);
    expect(ok(text, 'Status sent')).not.toEqual([]);
    expect(ok(text, 'not recorded: x')).not.toEqual([]);
    expect(ok({ $match: 'string', containsAll: ['a', 'b'] }, 'a only')).not.toEqual([]);
  });
});

describe('self-report conformance vectors: M group (JD-C03, instance layer)', () => {
  for (const file of mFiles) {
    it(file.replace(/\.json$/, ''), async () => {
      const raw = read(file);
      const checked = validate(raw);
      expect(checked.errorMessage ?? null, `${file} against schema.json`).toBeNull();
      expect(checked.valid).toBe(true);
      const vector = raw as McpVector;
      expect(file.startsWith(`${vector.id}-`)).toBe(true);
      expect(vector.kind).toBe('mcp');

      const failures = await runVector(file, vector);
      const gaps = vector.ambiguities.length
        ? ` [ambiguities: ${vector.ambiguities.join(', ')}]`
        : '';
      expect(failures, `${vector.id} FAIL${gaps}:\n${failures.join('\n')}`).toEqual([]);
    });
  }

  it('suite: at most 20 distinct non-empty stderr lines across the run (fixed strings)', () => {
    const lines = [...stderrLines.keys()];
    expect(lines.length, lines.join('\n')).toBeLessThanOrEqual(MAX_DISTINCT_STDERR_LINES);
  });

  it('suite: every text label was observed (report_status.invalid, report_task.invalid, not-recorded)', () => {
    expect([...labels.keys()].sort()).toEqual([
      'not-recorded',
      'report_status.invalid',
      'report_task.invalid',
    ]);
  });
});
