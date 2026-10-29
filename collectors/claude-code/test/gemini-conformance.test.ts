import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { canonicalEventId, L0_ATTRIBUTES, validateEvent, type JgrEvent } from '@javis-dog/jgr-spec';
import { afterAll, beforeAll, describe, expect, it, vi, type TestContext } from 'vitest';
import {
  createState,
  createUsageReceiver,
  main,
  opaqueRef,
  runFlush,
  type Io,
  type UsageReceiver,
} from '../src/index.ts';
import {
  freePort,
  listFiles,
  rawPost,
  readIfPresent,
  runProcess,
  startIngestStub,
  waitForQuiescence,
} from './gemini-conformance-harness.ts';

// R1 (S5b): runner for the QA lane's black-box vectors in docs/jgr/conformance/gemini, written
// from that README's runner rules only. Expectations come from the vector files; product code
// is driven, never consulted for expected values.
//
// Layers (README "Hook steps", "Receiver"):
// - Hook steps (and session registration) run at the COLLECTOR layer as real processes: the
//   exact command of the `javi-collector` entry that `javi init` wrote into
//   <project>/.gemini/settings.json (run with `bash -c`, as Gemini does) or the exec-form entry
//   of <project>/.claude/settings.local.json. Process checks (exit 0, 0 bytes of stdout) RUN.
// - The pinned clock reaches those processes (and the detached `javi flush` they spawn) through
//   NODE_OPTIONS=--import test/gemini-conformance-clock.ts; argv stays exactly as written.
// - `javi init` and `javi usage on` run in-process through the CLI entry `main()` with a
//   vector-local HOME, JAVI_HOME, GEMINI_CLI_HOME and JAVI_CLAUDE_HOME (never the real ones).
// - The receiver is an in-process instance of the same code `javi receive` runs
//   (createUsageReceiver), fresh per vector, on the port `usage on` wrote; Date is pinned in
//   this process with vi.useFakeTimers({ toFake: ['Date'] }).
// - The optional mapper layer (JD-C02 mapGeminiHook) is NOT RUN.

const DIR = fileURLToPath(new URL('../../../docs/jgr/conformance/gemini/', import.meta.url));
const CLOCK_PRELOAD = pathToFileURL(
  fileURLToPath(new URL('./gemini-conformance-clock.ts', import.meta.url)),
).href;
const SALT = 'gemini-conformance-salt-fixed-for-the-whole-run';
const PRODUCER = 'prod_gemini-conformance_c0ffee';
const PROJECT = 'web-app';
const RUN = randomBytes(6).toString('hex');
const UUID_V8 = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PREFIX = { 'gemini-cli': 'gm', 'claude-code': 'cc' } as const;
/** README "Record comparison": the L0 allowlist minus the free keys. */
const FREE_KEYS = new Set(['platform_version', 'collector_version', 'duration_ms']);
const CONTROLLED = [...L0_ATTRIBUTES].filter((k) => !FREE_KEYS.has(k));
/** README "Event comparison" → Other keys: the eight JGR usage_delta counters and fields. */
const USAGE_KEYS = new Set([
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'reasoning_tokens',
  'cost_usd',
  'model',
  'estimated',
]);
const COUNTERS = [
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'reasoning_tokens',
] as const;
const COST_TOLERANCE_USD = 1e-9;

type Platform = keyof typeof PREFIX;
type AttrMatcher = string | { prefixOf: string; maxLength: number; optional: boolean };
interface ExpectedRecord {
  type: string;
  session: string;
  status?: string;
  attributes: Record<string, AttrMatcher> | null;
}
interface HookStep {
  platform: Platform;
  stdin: unknown;
  rawStdin: string | null;
  expect: { record: ExpectedRecord | null };
}
interface IntMatcher {
  integerMin?: number;
  integerMax?: number;
}
interface ExpectedEvent {
  idLabel: string;
  platform: Platform;
  session: string;
  occurred_at: string;
  usage_delta: Record<(typeof COUNTERS)[number], number> & {
    cache_write_tokens?: number;
    cost_usd: number | null;
    model: string;
    estimated: boolean;
  };
}
interface UsageStep {
  request: { path: string; auth: boolean; body: unknown; rawBody: string | null };
  expect: { status: number; events: ExpectedEvent[]; droppedUnattributed: IntMatcher | null };
}
interface VectorBase {
  id: string;
  ambiguities: string[];
  clock: string;
  absentStrings: string[];
}
interface HookVector extends VectorBase {
  kind: 'hook';
  steps: HookStep[];
}
interface UsageVector extends VectorBase {
  kind: 'usage';
  registerSessions: Array<{ platform: Platform; session: string }>;
  steps: UsageStep[];
  droppedUnattributedTotal: IntMatcher | null;
  identityGroup: string | null;
}
type Vector = HookVector | UsageVector;

const files = (await readdir(DIR)).filter((f) => /^[HU]\d{2}-.*\.json$/.test(f)).sort();
const vectors = await Promise.all(
  files.map(async (f) => [f, JSON.parse(await readFile(join(DIR, f), 'utf8')) as Vector] as const),
);

const intMatches = (n: number, m: IntMatcher) =>
  Number.isInteger(n) &&
  (m.integerMin === undefined || n >= m.integerMin) &&
  (m.integerMax === undefined || n <= m.integerMax);

/**
 * README "Absent strings" → Global: every raw session id that appears in the vector as a
 * non-empty string (`session`, string `session_id` / `session.id` values in payloads, and
 * string values nested inside a non-string `session_id`). Numbers are excluded.
 */
const rawSessionIds = (vector: Vector) => {
  const ids = new Set<string>();
  const strings = (value: unknown) => {
    if (typeof value === 'string') {
      if (value) ids.add(value);
    } else if (value && typeof value === 'object') {
      for (const v of Object.values(value)) strings(v);
    }
  };
  const walk = (node: unknown) => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') {
      const o = node as Record<string, unknown>;
      // OTLP attribute: { key: 'session.id', value: { stringValue: '…' } }
      if (o.key === 'session.id' || o.key === 'session_id') strings(o.value);
      for (const [k, v] of Object.entries(o)) {
        if (k === 'session_id' || k === 'session.id') strings(v);
        walk(v);
      }
    }
  };
  const fromRaw = (raw: string | null) => {
    if (raw === null) return;
    for (const m of raw.matchAll(/"session_id"\s*:\s*"([^"]+)"/g)) ids.add(m[1]!);
    for (const m of raw.matchAll(/"session\.id"[^}]*?"stringValue"\s*:\s*"([^"]+)"/g)) {
      ids.add(m[1]!);
    }
  };
  if (vector.kind === 'hook') {
    for (const step of vector.steps) {
      walk(step.stdin);
      fromRaw(step.rawStdin);
      if (step.expect.record) ids.add(step.expect.record.session);
    }
  } else {
    for (const r of vector.registerSessions) ids.add(r.session);
    for (const step of vector.steps) {
      walk(step.request.body);
      fromRaw(step.request.rawBody);
      for (const e of step.expect.events) ids.add(e.session);
    }
  }
  return [...ids];
};

/** Run-wide: README "Thread identity" holds across vectors (one salt per run). */
const threadRefs = new Map<string, string>();
const pairOfRef = new Map<string, string>();
/** Run-wide `idLabel` scopes for vectors that share an `identityGroup` (U01 / U21). */
const groupIds = new Map<string, Map<string, string>>();

let stub: Awaited<ReturnType<typeof startIngestStub>>;
let root: string;
beforeAll(async () => {
  stub = await startIngestStub();
  root = await mkdtemp(join(tmpdir(), 'javi-gemini-conf-'));
});
afterAll(async () => {
  await stub?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

/** Child environment: no JAVI_*, GEMINI_*, CLAUDE_* or OTEL_* from the developer's shell. */
const baseEnv = () => {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(JAVI_|GEMINI_|CLAUDE_|OTEL_)/.test(k)) continue;
    env[k] = v;
  }
  return env;
};

const pairKey = (platform: Platform, session: string) => `${platform}\u0000${session}`;

const checkThread = (platform: Platform, session: string, ref: string, where: string) => {
  const prefix = PREFIX[platform];
  expect(ref, `${where}: ${prefix}_ ref`).toMatch(new RegExp(`^${prefix}_[A-Za-z0-9_:-]+$`));
  expect(ref.length, `${where}: ref ≤ 128 chars`).toBeLessThanOrEqual(128);
  const key = pairKey(platform, session);
  const known = threadRefs.get(key);
  if (known) expect(ref, `${where}: same (platform, session) → same thread_ref`).toBe(known);
  else threadRefs.set(key, ref);
  const owner = pairOfRef.get(ref);
  if (owner) {
    expect(owner, `${where}: different (platform, session) → different thread_ref`).toBe(key);
  } else pairOfRef.set(ref, key);
  // SHOULD (README "Thread identity"): the collector's ref helper, ADR-0016 §2.
  expect(ref, `${where}: thread_ref = opaqueRef('${prefix}', session, salt)`).toBe(
    opaqueRef(prefix, session, SALT),
  );
};

describe('Gemini CLI collector conformance vectors (docs/jgr/conformance/gemini)', () => {
  it('has the vectors the README lists (18 hook, 22 usage)', () => {
    expect(vectors.length).toBe(40);
    expect(vectors.filter(([, v]) => v.kind === 'hook').length).toBe(18);
    expect(vectors.filter(([, v]) => v.kind === 'usage').length).toBe(22);
  });

  it.for(vectors)('%s', { timeout: 180_000 }, async ([file, vector], ctx: TestContext) => {
    const blocked = (why: string): never => ctx.skip(`BLOCKED (${vector.id}): ${why}`);
    const clock = new Date(vector.clock);
    const home = await mkdtemp(join(root, `${vector.id}-`));
    expect(home.includes('/home/dev'), 'temp dirs must not live under /home/dev').toBe(false);
    const javi = join(home, '.javi');
    const project = join(home, PROJECT);
    await mkdir(javi, { recursive: true, mode: 0o700 });
    await mkdir(project, { recursive: true });
    // One installation salt for the whole run (README "Fixed environment" → Salt).
    await writeFile(
      join(javi, 'installation.json'),
      JSON.stringify({ producer_id: PRODUCER, salt: SALT }),
      { mode: 0o600 },
    );
    const token = `jd_it_${vector.id}${'g'.repeat(43 - vector.id.length)}`;
    const markerKey = 'JAVI_CONFORMANCE_RUN';
    const markerValue = `${RUN}-${vector.id}`;
    const marker = `${markerKey}=${markerValue}`;
    const childEnv: NodeJS.ProcessEnv = {
      ...baseEnv(),
      HOME: home,
      GEMINI_PROJECT_DIR: project,
      GEMINI_CWD: project,
      CLAUDE_PROJECT_DIR: project,
      JAVI_CONFORMANCE_CLOCK: vector.clock,
      [markerKey]: markerValue,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${CLOCK_PRELOAD}`.trim(),
    };
    const needsClaude =
      vector.kind === 'hook'
        ? vector.steps.some((s) => s.platform === 'claude-code')
        : vector.registerSessions.some((r) => r.platform === 'claude-code');

    const state = createState(javi);
    const pending = new Set<Promise<unknown>>();
    const track = (p: Promise<unknown>) => {
      pending.add(p);
      void p.finally(() => pending.delete(p)).catch(() => {});
      return p;
    };
    const settle = async () => {
      // A flush scheduled with a 0 ms gap starts on the next timer turn; await it and any rerun.
      for (let quiet = 0; quiet < 2;) {
        await new Promise((r) => setTimeout(r, 5));
        if (pending.size) {
          quiet = 0;
          await Promise.allSettled([...pending]);
        } else quiet += 1;
      }
    };
    const lines: string[] = [];
    const io: Io = {
      env: {
        HOME: home,
        JAVI_HOME: javi,
        GEMINI_CLI_HOME: home,
        JAVI_CLAUDE_HOME: home,
        JAVI_INGEST_TOKEN: token,
        PATH: process.env.PATH ?? '',
      },
      cwd: project,
      readStdin: async () => '',
      out: (l) => lines.push(l),
      err: (l) => lines.push(`ERR ${l}`),
      spawnFlush: (ref) => void track(runFlush({ state, projectRef: ref })),
      spawnReceiver: () => {},
    };

    let receiver: UsageReceiver | null = null;
    let secret: string | null = null;
    const seen = new Map<string, JgrEvent>();
    const lastSeq = new Map<string, number>();
    const absent = [
      'SENTINEL',
      '/home/dev',
      ...rawSessionIds(vector).filter((s) => !/^\d+$/.test(s)),
      ...vector.absentStrings,
    ];

    /** Spool first, then batches: a flush captures an event before it deletes the file. */
    const observe = async (where: string) => {
      const snapshot: JgrEvent[] = [];
      for (const path of (await listFiles(state.spoolDir(PROJECT))).sort()) {
        if (!path.endsWith('.json')) continue;
        const text = await readIfPresent(path);
        if (text !== null) snapshot.push(JSON.parse(text) as JgrEvent);
      }
      for (const text of stub.batches(token)) {
        snapshot.push(...(JSON.parse(text) as { events: JgrEvent[] }).events);
      }
      const fresh: JgrEvent[] = [];
      for (const event of snapshot) {
        const id = canonicalEventId(String(event.event_id));
        const earlier = seen.get(id);
        if (earlier) {
          // Collapse rule: copies with one id are one event and identical in every field.
          expect(event, `${where}: copies of event ${id} differ`).toEqual(earlier);
          continue;
        }
        seen.set(id, event);
        fresh.push(event);
      }
      return fresh;
    };

    /** I6, README "Absent strings" → Where to scan: records, spool, batches, $HOME/.javi. */
    const scan = async (where: string, records: JgrEvent[]) => {
      const sources: Array<[string, string, boolean]> = [];
      for (const r of records) sources.push([`record ${r.event_id}`, JSON.stringify(r), false]);
      for (const [i, text] of stub.batches(token).entries()) {
        sources.push([`ingest batch ${i + 1}`, text, false]);
      }
      for (const path of await listFiles(javi)) {
        const text = await readIfPresent(path);
        // usage.json holds the bearer secret by design: exempt from the $SECRET check only.
        if (text !== null) sources.push([path, text, basename(path) === 'usage.json']);
      }
      for (const [name, text, secretExempt] of sources) {
        for (const s of absent) {
          expect(text.includes(s), `${where} I6: "${s}" found in ${name}`).toBe(false);
        }
        if (secret && !secretExempt) {
          expect(text.includes(secret), `${where} I6: $SECRET found in ${name}`).toBe(false);
        }
      }
      // Raw session ids (and every other absent string) never name a file either.
      for (const path of await listFiles(javi)) {
        const name = relative(javi, path);
        for (const s of absent) {
          expect(name.includes(s), `${where} I6: "${s}" in file name ${name}`).toBe(false);
        }
      }
    };

    /** I1–I5 for one emitted record; `origin` says what produced it (I3). */
    const invariants = (e: JgrEvent, where: string, origin: Platform | 'receiver' | 'setup') => {
      const at = `${where} [${e.type} ${e.event_id}]`;
      const result = validateEvent(e, clock);
      expect(result.ok, `${at} I1 JGR v0.1 at clock: ${JSON.stringify(result)}`).toBe(true);
      expect(e.privacy_class === undefined || e.privacy_class === 'L0', `${at} I2 L0`).toBe(true);
      expect('encrypted' in e, `${at} I2 no encrypted`).toBe(false);
      for (const [key, value] of Object.entries(e.attributes ?? {})) {
        expect(L0_ATTRIBUTES.has(key), `${at} I2 attribute ${key} in L0 allowlist`).toBe(true);
        if (typeof value === 'string') {
          expect(value.length, `${at} I2 ${key} ≤ 128 chars`).toBeLessThanOrEqual(128);
        }
      }
      if (origin === 'gemini-cli' && !e.type.startsWith('x.')) {
        expect(e.attributes?.platform, `${at} I3 platform`).toBe('gemini-cli');
        expect(e.thread_ref.startsWith('gm_'), `${at} I3 gm_ ref`).toBe(true);
      }
      if (origin === 'claude-code' && !e.type.startsWith('x.')) {
        expect(e.thread_ref.startsWith('cc_'), `${at} I3 cc_ ref`).toBe(true);
      }
      const u = e.usage_delta as Record<string, unknown> | undefined;
      if (u) {
        for (const c of [...COUNTERS, 'cache_write_tokens']) {
          if (u[c] === undefined) continue;
          expect(Number.isInteger(u[c]) && (u[c] as number) >= 0, `${at} I4 ${c}`).toBe(true);
        }
        if (u.cost_usd !== undefined) {
          const cost = u.cost_usd as number;
          expect(Number.isFinite(cost) && cost >= 0, `${at} I4 cost_usd`).toBe(true);
        }
        if (e.thread_ref.startsWith('gm_')) {
          expect(u.cost_usd !== undefined, `${at} I5 cost_usd iff estimated`).toBe(
            u.estimated === true,
          );
          expect(u.cache_write_tokens ?? 0, `${at} I5 cache_write_tokens`).toBe(0);
        }
      }
    };

    /** I7: per thread, sequences strictly increase in emission (step) order. */
    const advanceSequences = (records: JgrEvent[], where: string) => {
      const byThread = new Map<string, number[]>();
      for (const r of records) {
        if (r.type.startsWith('x.')) continue;
        byThread.set(r.thread_ref, [...(byThread.get(r.thread_ref) ?? []), r.sequence]);
      }
      for (const [thread, seqs] of byThread) {
        const before = lastSeq.get(thread) ?? -1;
        expect(new Set(seqs).size, `${where} I7 distinct sequences on ${thread}`).toBe(seqs.length);
        for (const s of seqs) {
          expect(s, `${where} I7 sequence on ${thread} after ${before}`).toBeGreaterThan(before);
        }
        lastSeq.set(thread, Math.max(...seqs));
      }
    };

    const hookArgv: Partial<
      Record<Platform, { shell: string } | { file: string; args: string[] }>
    > = {};

    /** One collector-layer hook step (README "Hook steps"); returns its non-x.* records. */
    const hookStep = async (platform: Platform, stdin: Buffer, where: string) => {
      const argv = hookArgv[platform];
      if (!argv) return blocked(`no javi-collector hook entry for ${platform}`);
      const result = await runProcess(argv, stdin, { cwd: project, env: childEnv });
      expect(result.timedOut, `${where}: hook still running after 10 s`).toBe(false);
      expect(result.code, `${where} I8 exit code (stderr: ${result.stderr})`).toBe(0);
      expect(result.stdout.length, `${where} I8 stdout bytes: ${result.stdout}`).toBe(0);
      if (!(await waitForQuiescence(marker))) {
        return blocked(`${where}: a javi process did not finish within 15 s (cannot observe)`);
      }
      const fresh = await observe(where);
      for (const e of fresh) invariants(e, where, platform);
      expect(
        fresh.filter((e) => e.type === 'usage.reported').map((e) => e.event_id),
        `${where} I9 a hook step produces no usage.reported`,
      ).toEqual([]);
      await scan(where, fresh);
      const records = fresh.filter((e) => !e.type.startsWith('x.'));
      advanceSequences(records, where);
      return records;
    };

    try {
      // --- Pinned clock (README "Pinned clock"): this process, then the hook processes. ---
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(clock);
      if (Date.now() !== clock.getTime()) blocked('cannot pin the clock in the runner process');
      const probe = await runProcess(
        { file: process.execPath, args: ['-e', 'process.stdout.write(String(Date.now()))'] },
        Buffer.alloc(0),
        { cwd: project, env: childEnv },
      );
      if (probe.stdout.toString() !== String(clock.getTime())) {
        blocked(`cannot pin the clock in javi processes (probe: ${probe.stdout}${probe.stderr})`);
      }

      // --- Fixed environment ---
      const init = await main(
        ['init', '--project', PROJECT, '--platform', 'gemini-cli', '--endpoint', stub.endpoint],
        io,
      );
      if (init !== 0)
        blocked(`javi init --platform gemini-cli exited ${init}: ${lines.join(' | ')}`);
      if (needsClaude) {
        const cc = await main(['init', '--project', PROJECT, '--endpoint', stub.endpoint], io);
        if (cc !== 0) blocked(`javi init (claude-code) exited ${cc}: ${lines.join(' | ')}`);
      }
      await settle();
      const geminiSettings = JSON.parse(
        await readFile(join(project, '.gemini', 'settings.json'), 'utf8'),
      ) as {
        hooks?: Record<string, Array<{ hooks?: Array<{ name?: string; command?: string }> }>>;
      };
      const geminiCommands = new Set(
        Object.values(geminiSettings.hooks ?? {})
          .flat()
          .flatMap((g) => g.hooks ?? [])
          .filter((h) => h.name === 'javi-collector' && typeof h.command === 'string')
          .map((h) => h.command!),
      );
      if (geminiCommands.size !== 1) {
        blocked(
          `expected one javi-collector command in .gemini/settings.json, ${geminiCommands.size}`,
        );
      }
      hookArgv['gemini-cli'] = { shell: [...geminiCommands][0]! };
      if (needsClaude) {
        const claude = JSON.parse(
          await readFile(join(project, '.claude', 'settings.local.json'), 'utf8'),
        ) as {
          hooks?: Record<string, Array<{ hooks?: Array<{ command?: string; args?: string[] }> }>>;
        };
        const entries = new Map(
          Object.values(claude.hooks ?? {})
            .flat()
            .flatMap((g) => g.hooks ?? [])
            .filter((h) => Array.isArray(h.args) && h.args.includes('javi-collector'))
            .map((h) => [JSON.stringify([h.command, h.args]), h] as const),
        );
        if (entries.size !== 1) blocked(`expected one javi-collector entry, got ${entries.size}`);
        const entry = [...entries.values()][0]!;
        hookArgv['claude-code'] = { file: entry.command!, args: entry.args! };
      }

      // Setup records (x.javi.collector.installed): invariants and scans, then marked seen.
      const setupRecords = await observe(`${vector.id} setup`);
      for (const e of setupRecords) invariants(e, `${vector.id} setup`, 'setup');
      await scan(`${vector.id} setup`, setupRecords);

      if (vector.kind === 'hook') {
        await ctx.annotate(
          `Layer: collector (javi hook processes from .gemini/settings.json argv); process checks RUN; mapper layer NOT RUN (optional). Ambiguities: ${vector.ambiguities.join(', ') || 'none'}.`,
        );
        for (const [i, step] of vector.steps.entries()) {
          const where = `${file} step ${i + 1} (${step.platform})`;
          const bytes = Buffer.from(
            step.rawStdin !== null ? step.rawStdin : JSON.stringify(step.stdin),
            'utf8',
          );
          const records = await hookStep(step.platform, bytes, where);
          const want = step.expect.record;
          if (want === null) {
            expect(
              records.map((r) => r.type),
              `${where}: expected no record`,
            ).toEqual([]);
            continue;
          }
          expect(
            records.map((r) => r.type),
            `${where}: expected exactly one record`,
          ).toEqual([want.type]);
          const record = records[0]!;
          checkThread(step.platform, want.session, record.thread_ref, where);
          if (want.status !== undefined) {
            expect(record.status, `${where}: status`).toBe(want.status);
          }
          if (want.attributes !== null) {
            const attrs = (record.attributes ?? {}) as Record<string, unknown>;
            for (const key of CONTROLLED) {
              const m = want.attributes[key];
              const value = attrs[key];
              if (m === undefined) {
                expect(value, `${where}: controlled key "${key}" must be absent`).toBeUndefined();
              } else if (typeof m === 'string') {
                expect(value, `${where}: attributes.${key}`).toBe(m);
              } else if (value === undefined) {
                expect(m.optional, `${where}: attributes.${key} may not be absent`).toBe(true);
              } else {
                const ok =
                  typeof value === 'string' &&
                  value.length > 0 &&
                  value.length <= m.maxLength &&
                  m.prefixOf.startsWith(value);
                expect(
                  ok,
                  `${where}: attributes.${key} "${String(value)}" prefix ≤ ${m.maxLength}`,
                ).toBe(true);
              }
            }
          }
        }
        return;
      }

      // --- Usage (U only): usage on, receiver, registration ---
      await ctx.annotate(
        `Layer: receiver in-process (createUsageReceiver, the code javi receive runs); registration hooks are collector-layer processes; mapper layer NOT RUN. Ambiguities: ${vector.ambiguities.join(', ') || 'none'}.`,
      );
      const geminiUser = join(home, '.gemini', 'settings.json');
      if (
        await stat(geminiUser).then(
          () => true,
          () => false,
        )
      ) {
        blocked('~/.gemini/settings.json exists before usage on');
      }
      // A free port per vector: vitest runs other test files in parallel workers.
      const port = await freePort();
      const on = await main(
        ['usage', 'on', '--platform', 'gemini-cli', '--port', String(port)],
        io,
      );
      if (on !== 0)
        blocked(`javi usage on --platform gemini-cli exited ${on}: ${lines.join(' | ')}`);
      if (vector.registerSessions.some((r) => r.platform === 'claude-code')) {
        const ccOn = await main(['usage', 'on'], io);
        if (ccOn !== 0) blocked(`javi usage on exited ${ccOn}: ${lines.join(' | ')}`);
      }
      const config = await state.usageConfig();
      if (!config) return blocked('no usage configuration after javi usage on');
      secret = config.secret;
      const installation = await state.installation();
      expect(installation.salt, 'the run salt is the installation salt').toBe(SALT);
      receiver = createUsageReceiver({
        state,
        port: config.port,
        secret: config.secret,
        salt: installation.salt,
        flushGapMs: 0,
        flush: (ref) => track(runFlush({ state, projectRef: ref })),
      });
      const bound = await receiver.listen().catch((e: Error) => blocked(`receiver: ${e.message}`));
      expect(bound).toBe(config.port);

      const registrations = new Map<string, { thread_ref: string; sequence: number }>();
      for (const reg of vector.registerSessions) {
        const where = `${file} registration ${reg.platform}`;
        const payload =
          reg.platform === 'gemini-cli'
            ? {
                session_id: reg.session,
                transcript_path: '/home/dev/.gemini/tmp/SENTINEL_REG_TRANSCRIPT/chats/session.json',
                cwd: '/home/dev/SENTINEL_REG_CWD/web-app',
                hook_event_name: 'SessionStart',
                timestamp: clock.toISOString(),
                source: 'startup',
              }
            : {
                session_id: reg.session,
                transcript_path: '/home/dev/.claude/projects/SENTINEL_REG_TRANSCRIPT/s.jsonl',
                cwd: '/home/dev/SENTINEL_REG_CWD/web-app',
                hook_event_name: 'SessionStart',
                source: 'startup',
              };
        const records = await hookStep(reg.platform, Buffer.from(JSON.stringify(payload)), where);
        if (records.length !== 1 || records[0]!.type !== 'session.started') {
          blocked(`${where}: expected one session.started, got [${records.map((r) => r.type)}]`);
        }
        checkThread(reg.platform, reg.session, records[0]!.thread_ref, where);
        registrations.set(pairKey(reg.platform, reg.session), {
          thread_ref: records[0]!.thread_ref,
          sequence: records[0]!.sequence,
        });
      }

      const droppedAtStart = (await state.receiverInfo())?.dropped ?? 0;
      const labels = new Map<string, string>();
      const usageSeqs = new Map<string, Set<number>>();

      /** README "Event comparison": every mismatch between one produced and one expected event. */
      const diff = (p: JgrEvent, x: ExpectedEvent): string[] => {
        const d: string[] = [];
        const u = (p.usage_delta ?? {}) as Record<string, unknown>;
        const xu = x.usage_delta;
        if (!validateEvent(p, clock).ok) d.push('envelope invalid at clock');
        if (p.jgr !== '0.1') d.push(`jgr ${p.jgr}`);
        if (p.type !== 'usage.reported') d.push(`type ${p.type}`);
        if (p.project_ref !== PROJECT) d.push(`project_ref ${p.project_ref}`);
        const reg = registrations.get(pairKey(x.platform, x.session));
        if (!reg) d.push(`no registration reference for ${x.platform} ${x.session}`);
        else {
          if (p.thread_ref !== reg.thread_ref) d.push(`thread_ref ≠ registration reference`);
          if (!(Number.isInteger(p.sequence) && p.sequence > reg.sequence)) {
            d.push(`sequence ${p.sequence} not > registration ${reg.sequence}`);
          }
        }
        if (!UUID_V8.test(p.event_id)) d.push(`event_id ${p.event_id} is not a UUID v8`);
        if (Date.parse(p.occurred_at) !== Date.parse(x.occurred_at)) {
          d.push(`occurred_at ${p.occurred_at} ≠ ${x.occurred_at}`);
        }
        for (const c of COUNTERS) {
          if (Number(u[c] ?? 0) !== xu[c]) d.push(`${c} ${String(u[c])} ≠ ${xu[c]}`);
        }
        if (xu.cache_write_tokens !== undefined) {
          if (Number(u.cache_write_tokens ?? 0) !== xu.cache_write_tokens) {
            d.push(`cache_write_tokens ${String(u.cache_write_tokens)} ≠ ${xu.cache_write_tokens}`);
          }
        } else if ((u.cache_write_tokens ?? 0) !== 0) {
          d.push(`cache_write_tokens ${String(u.cache_write_tokens)} must be absent or 0`);
        }
        if (xu.cost_usd === null) {
          if ('cost_usd' in u) d.push(`cost_usd ${String(u.cost_usd)} must be absent`);
        } else if (
          typeof u.cost_usd !== 'number' ||
          !(Math.abs(u.cost_usd - xu.cost_usd) <= COST_TOLERANCE_USD)
        ) {
          d.push(`cost_usd ${String(u.cost_usd)} ≠ ${xu.cost_usd} (±${COST_TOLERANCE_USD})`);
        }
        if (u.model !== xu.model) d.push(`model ${String(u.model)} ≠ ${xu.model}`);
        if (
          xu.estimated ? u.estimated !== true : u.estimated !== false && u.estimated !== undefined
        ) {
          d.push(`estimated ${String(u.estimated)} ≠ ${xu.estimated}`);
        }
        const extra = Object.keys(u).filter((k) => !USAGE_KEYS.has(k));
        if (extra.length) d.push(`extra usage_delta keys ${extra.join(', ')}`);
        return d;
      };

      for (const [i, step] of vector.steps.entries()) {
        const where = `${file} step ${i + 1} (${step.request.path})`;
        const droppedBefore = (await state.receiverInfo())?.dropped ?? 0;
        const body = Buffer.from(
          step.request.rawBody !== null ? step.request.rawBody : JSON.stringify(step.request.body),
          'utf8',
        );
        const reply = await rawPost(
          config.port,
          step.request.path,
          body,
          step.request.auth ? `Bearer ${config.secret}` : null,
        );
        expect(reply.status, `${where}: status (body ${reply.body})`).toBe(step.expect.status);
        if (reply.status === 200) {
          expect(JSON.parse(reply.body), `${where}: body`).toEqual({});
          expect(
            (reply.headers['content-type'] ?? '').split(';')[0]!.trim(),
            `${where}: content-type`,
          ).toBe('application/json');
        }
        await settle();
        const fresh = await observe(where);
        for (const e of fresh) invariants(e, where, 'receiver');
        if (reply.status !== 200) {
          expect(
            fresh.map((e) => e.type),
            `${where} I9 a non-200 step produces nothing`,
          ).toEqual([]);
        }
        expect(
          fresh.filter((e) => e.type !== 'usage.reported').map((e) => e.type),
          `${where} I9 a receiver step produces only usage.reported`,
        ).toEqual([]);
        await scan(where, fresh);
        advanceSequences(fresh, where);

        const produced = fresh.filter((e) => e.type === 'usage.reported');
        const summary = produced.map((e) => ({ occurred_at: e.occurred_at, ...e.usage_delta }));
        expect(produced.length, `${where}: event count; produced ${JSON.stringify(summary)}`).toBe(
          step.expect.events.length,
        );
        const unmatched = [...produced];
        for (const expected of step.expect.events) {
          const diffs = unmatched.map((p) => diff(p, expected));
          const at = diffs.findIndex((d) => d.length === 0);
          expect(
            at,
            `${where}: expected event ${expected.idLabel} (${expected.platform} ${expected.session}) — ${JSON.stringify(diffs)}`,
          ).toBeGreaterThanOrEqual(0);
          const [event] = unmatched.splice(at, 1);
          // README "Event identity": labels within the vector or the identity group.
          const scope = vector.identityGroup
            ? (groupIds.get(vector.identityGroup) ??
              groupIds.set(vector.identityGroup, new Map()).get(vector.identityGroup)!)
            : labels;
          const known = scope.get(expected.idLabel);
          if (known) {
            expect(event!.event_id, `${where}: label ${expected.idLabel} → same event_id`).toBe(
              known,
            );
          } else {
            expect(
              [...scope.values()],
              `${where}: label ${expected.idLabel} → an event_id no other label has`,
            ).not.toContain(event!.event_id);
            scope.set(expected.idLabel, event!.event_id);
          }
          checkThread(expected.platform, expected.session, event!.thread_ref, where);
          const seqs = usageSeqs.get(event!.thread_ref) ?? new Set<number>();
          expect(seqs.has(event!.sequence), `${where}: usage sequences pairwise distinct`).toBe(
            false,
          );
          seqs.add(event!.sequence);
          usageSeqs.set(event!.thread_ref, seqs);
        }

        if (step.expect.droppedUnattributed !== null) {
          const grew = ((await state.receiverInfo())?.dropped ?? 0) - droppedBefore;
          expect(
            intMatches(grew, step.expect.droppedUnattributed),
            `${where}: unattributed drops grew by ${grew}`,
          ).toBe(true);
        }
      }

      if (vector.droppedUnattributedTotal !== null) {
        const grew = ((await state.receiverInfo())?.dropped ?? 0) - droppedAtStart;
        expect(
          intMatches(grew, vector.droppedUnattributedTotal),
          `${file}: unattributed drops over the vector grew by ${grew}`,
        ).toBe(true);
      }
    } finally {
      await waitForQuiescence(marker);
      await receiver?.close();
      await settle();
      vi.useRealTimers();
    }
  });
});
