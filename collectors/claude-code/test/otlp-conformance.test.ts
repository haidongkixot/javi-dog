import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { validateEvent, type JgrEvent } from '@javis-dog/jgr-spec';
import { afterAll, describe, expect, it } from 'vitest';
import { createState, createUsageReceiver, opaqueRef, runHook } from '../src/index.ts';

// Runner for the QA lane's black-box vectors in docs/jgr/conformance/otlp (S3e Q1), written from
// that README's runner rules. Fresh JAVI_HOME and receiver per vector, one salt per run,
// `sess-known` → `web-app` registered through a real hook. Flushing is disabled, so every
// produced event is read from the spool; the receiver writes it before answering 200.

const DIR = fileURLToPath(new URL('../../../docs/jgr/conformance/otlp/', import.meta.url));
const SECRET = 'conformanceSecret_0123456789';
const WRONG_SECRET = `${SECRET.slice(0, -1)}8`;
const SALT = 'conformance-salt-fixed-for-the-whole-run';
const TOKEN = `jd_it_${'C'.repeat(43)}`;
const PROJECT = 'web-app';
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type Matcher =
  | string
  | {
      equals?: unknown;
      pattern?: string;
      integerMin?: number;
      integerMax?: number;
      present?: boolean;
      absent?: boolean;
    };
interface Step {
  request: {
    method: string;
    path: string;
    headers: Record<string, string>;
    gzip: boolean;
    body: unknown;
    rawBody: string | null;
    bodyPadBytes: number | null;
  };
  expect: {
    status: number;
    headers: Record<string, Matcher>;
    body: unknown;
    events: Array<{
      idLabel: string;
      session: string;
      occurred_at: string;
      usage_delta: Record<string, unknown>;
    }>;
    droppedUnattributed: Matcher | null;
  };
}
interface Vector {
  description: string;
  ambiguities: string[];
  steps: Step[];
  forbiddenStrings: string[];
  identityGroup: string | null;
}

const files = (await readdir(DIR)).filter((f) => /^\d{2}-.*\.json$/.test(f)).sort();
const vectors = await Promise.all(
  files.map(async (f) => [f, JSON.parse(await readFile(join(DIR, f), 'utf8')) as Vector] as const),
);

const sub = (value: string, port: number) =>
  value
    .replaceAll('$WRONG_SECRET', WRONG_SECRET)
    .replaceAll('$SECRET', SECRET)
    .replaceAll('$PORT', String(port));

const matches = (value: unknown, m: Matcher): boolean => {
  if (typeof m === 'string') return typeof value === 'string' && value.trim() === m;
  if (m.absent) return value === undefined;
  if (m.present && value === undefined) return false;
  if ('equals' in m && JSON.stringify(value) !== JSON.stringify(m.equals)) return false;
  if (m.pattern !== undefined && !new RegExp(m.pattern).test(String(value).trim())) return false;
  if (m.integerMin !== undefined || m.integerMax !== undefined) {
    const n =
      typeof value === 'number' ? value : /^[0-9]+$/.test(String(value)) ? Number(value) : NaN;
    if (!Number.isInteger(n)) return false;
    if (m.integerMin !== undefined && n < m.integerMin) return false;
    if (m.integerMax !== undefined && n > m.integerMax) return false;
  }
  return true;
};

const send = (port: number, step: Step['request']) =>
  new Promise<{ status: number; headers: Record<string, unknown>; body: string }>(
    (resolve, reject) => {
      let bytes = Buffer.from(step.rawBody ?? JSON.stringify(step.body), 'utf8');
      if (step.bodyPadBytes && bytes.length < step.bodyPadBytes) {
        bytes = Buffer.concat([bytes, Buffer.alloc(step.bodyPadBytes - bytes.length, 0x20)]);
      }
      if (step.gzip) bytes = gzipSync(bytes);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(step.headers)) headers[k] = sub(v, port);
      if (step.gzip && !headers['content-encoding']) headers['content-encoding'] = 'gzip';
      headers['content-length'] = String(bytes.length);
      const req = request(
        { host: '127.0.0.1', port, path: step.path, method: step.method, headers },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (d: string) => (text += d));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }),
          );
        },
      );
      req.on('error', reject);
      req.end(bytes);
    },
  );

const listFiles = async (dir: string): Promise<string[]> => {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(path)));
    else out.push(path);
  }
  return out;
};

const spooledUsage = async (home: string) => {
  const events: JgrEvent[] = [];
  for (const file of await listFiles(join(home, 'spool'))) {
    if (!file.endsWith('.json')) continue;
    const event = JSON.parse(await readFile(file, 'utf8')) as JgrEvent;
    if (event.type === 'usage.reported') events.push(event);
  }
  return events;
};

const near = (a: unknown, b: unknown) => Math.abs(Number(a ?? 0) - Number(b ?? 0)) <= 1e-9;
const COUNTERS = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'];

/** Expected event ↔ produced event, per the README's "Event comparison" table. */
const sameEvent = (
  produced: JgrEvent,
  expected: Step['expect']['events'][number],
  registeredSeq: number,
) => {
  const u = (produced.usage_delta ?? {}) as Record<string, unknown>;
  const e = expected.usage_delta;
  const keys = new Set([...COUNTERS, 'cost_usd', 'model', 'estimated', 'reasoning_tokens']);
  return (
    produced.thread_ref === opaqueRef('cc', expected.session, SALT) &&
    Date.parse(produced.occurred_at) === Date.parse(expected.occurred_at) &&
    COUNTERS.every((c) => Number(u[c] ?? 0) === Number(e[c] ?? 0)) &&
    near(u.cost_usd, e.cost_usd) &&
    u.model === e.model &&
    u.estimated === false &&
    Number(u.reasoning_tokens ?? 0) === 0 &&
    Object.keys(u).every((k) => keys.has(k)) &&
    produced.sequence > registeredSeq
  );
};

const groupIds = new Map<string, Map<string, string>>();
const homes: string[] = [];
afterAll(async () => {
  await Promise.all(homes.map((h) => rm(h, { recursive: true, force: true })));
});

describe('OTLP receiver conformance vectors (docs/jgr/conformance/otlp)', () => {
  it('has the vectors the README lists', () => {
    expect(vectors.length).toBe(40);
  });

  it.each(vectors)('%s', async (_file, vector) => {
    const home = await mkdtemp(join(tmpdir(), 'javi-otlp-conf-'));
    homes.push(home);
    await mkdir(home, { recursive: true, mode: 0o700 });
    await writeFile(
      join(home, 'installation.json'),
      JSON.stringify({ producer_id: 'prod_claude-code_c0ffee', salt: SALT }),
      { mode: 0o600 },
    );
    const state = createState(home);
    await state.saveCredentials(PROJECT, {
      endpoint: 'http://127.0.0.1:9/api/v1/events',
      token: TOKEN,
    });
    const hook = await runHook({
      state,
      projectRef: PROJECT,
      stdin: JSON.stringify({ session_id: 'sess-known', hook_event_name: 'SessionStart' }),
      spawnFlush: () => {},
    });
    expect(hook).toBe('recorded');
    const registeredSeq = 0; // the hook's event is the thread's first

    const receiver = createUsageReceiver({
      state,
      port: 0,
      secret: SECRET,
      salt: SALT,
      flush: async () => {},
    });
    const port = await receiver.listen();
    const labels = new Map<string, string>();
    const seen = new Map<string, JgrEvent>();
    try {
      for (const [i, step] of vector.steps.entries()) {
        const where = `${_file} step ${i + 1}`;
        const droppedBefore = (await state.receiverInfo())?.dropped ?? 0;
        const reply = await send(port, step.request);
        expect(reply.status, where).toBe(step.expect.status);
        for (const [name, m] of Object.entries(step.expect.headers)) {
          expect(matches(reply.headers[name.toLowerCase()], m), `${where} header ${name}`).toBe(
            true,
          );
        }
        if (step.expect.body !== null)
          expect(JSON.parse(reply.body), where).toEqual(step.expect.body);

        const fresh: JgrEvent[] = [];
        for (const event of await spooledUsage(home)) {
          const earlier = seen.get(event.event_id);
          if (earlier) {
            // Collapse rule: copies with one id must be identical in every compared field.
            expect(event.usage_delta, `${where} collapsed copy`).toEqual(earlier.usage_delta);
            continue;
          }
          seen.set(event.event_id, event);
          fresh.push(event);
        }
        expect(fresh.length, `${where} event count`).toBe(step.expect.events.length);
        const unmatched = [...fresh];
        for (const expected of step.expect.events) {
          const at = unmatched.findIndex((p) => sameEvent(p, expected, registeredSeq));
          expect(at, `${where} expected event ${expected.idLabel}`).toBeGreaterThanOrEqual(0);
          const [produced] = unmatched.splice(at, 1);
          expect(produced!.event_id, where).toMatch(ID);
          expect(validateEvent(produced, new Date()).ok, `${where} envelope`).toBe(true);
          expect(produced).toMatchObject({
            jgr: '0.1',
            type: 'usage.reported',
            project_ref: PROJECT,
          });
          const scope = vector.identityGroup
            ? (groupIds.get(vector.identityGroup) ??
              groupIds.set(vector.identityGroup, new Map()).get(vector.identityGroup)!)
            : labels;
          const known = scope.get(expected.idLabel);
          if (known) expect(produced!.event_id, `${where} same label`).toBe(known);
          else {
            expect([...scope.values()], `${where} different label`).not.toContain(
              produced!.event_id,
            );
            scope.set(expected.idLabel, produced!.event_id);
          }
        }

        if (step.expect.droppedUnattributed !== null) {
          // receiver.json is written right after the reply: poll for the asserted state.
          const until = Date.now() + 2_000;
          let delta = 0;
          for (;;) {
            delta = ((await state.receiverInfo())?.dropped ?? 0) - droppedBefore;
            if (matches(delta, step.expect.droppedUnattributed) || Date.now() > until) break;
            await new Promise((r) => setTimeout(r, 25));
          }
          expect(matches(delta, step.expect.droppedUnattributed), `${where} dropped ${delta}`).toBe(
            true,
          );
        }
      }

      // Sequences of one thread's usage events are pairwise distinct.
      const seqs = [...seen.values()].map((e) => `${e.thread_ref}:${e.sequence}`);
      expect(new Set(seqs).size).toBe(seqs.length);

      // Forbidden strings: every spool byte (the receiver forwards nothing else here).
      const forbidden = ['sess-known', 'sess-unknown', SECRET, ...vector.forbiddenStrings];
      for (const file of await listFiles(join(home, 'spool'))) {
        const text = await readFile(file, 'utf8');
        for (const s of forbidden) expect(text.includes(s), `${file} contains ${s}`).toBe(false);
      }
      for (const file of await listFiles(join(home, 'sessions'))) {
        const text = await readFile(file, 'utf8');
        expect(text.includes('sess-known') || file.includes('sess-known')).toBe(false);
      }
    } finally {
      await receiver.close();
    }
  });
});
