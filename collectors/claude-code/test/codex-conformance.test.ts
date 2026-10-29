import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { canonicalEventId, L0_ATTRIBUTES, validateEvent, type JgrEvent } from '@javis-dog/jgr-spec';
import { parse as parseToml } from 'smol-toml';
import { afterAll, beforeAll, describe, expect, it, vi, type TestContext } from 'vitest';
import {
  codexHome,
  createState,
  createUsageReceiver,
  main,
  opaqueRef,
  runFlush,
  type Io,
  type UsageReceiver,
} from '../src/index.ts';
import {
  at,
  collectRawIds,
  FORBIDDEN_ENV,
  freePort,
  hygienicEnv,
  listFiles,
  markedProcesses,
  rawPost,
  readIfPresent,
  runProcess,
  startIngestStub,
  waitForQuiescence,
} from './codex-conformance-harness.ts';

// R1 (S5c): runner for the QA lane's black-box vectors in docs/jgr/conformance/codex, written
// from that README's runner rules only. Expectations come from the vector files; product code
// is driven through its public seams (src/index.ts), never consulted for expected values.
//
// Layers (README "Hook steps", "Fixed environment" → Receiver):
// - Hook steps (registration included) run at the COLLECTOR layer as real processes: javi's
//   handler command from <project>/.codex/hooks.json (the launcher <HOME>/.javi/bin/javi-hook
//   ... --source javi-collector) run with `/bin/sh -c`; Gemini steps run the javi-collector
//   command of .gemini/settings.json with `bash -c`; Claude Code steps the exec-form entry of
//   .claude/settings.local.json. Process checks (exit 0, 0 bytes of stdout, 10 s) RUN.
// - The pinned clock reaches those processes (and the `javi flush` / `javi receive` they
//   spawn) through NODE_OPTIONS=--import test/codex-conformance-clock.ts; the hook command
//   stays exactly as written.
// - `javi init` and `javi usage on` run in-process through the CLI entry `main()` with a
//   vector-local HOME, CODEX_HOME = $HOME/.codex, JAVI_HOME, GEMINI_CLI_HOME and
//   JAVI_CLAUDE_HOME (never the real ones).
// - The receiver is an in-process instance of the code `javi receive` runs
//   (createUsageReceiver), fresh per vector, on the port read from $CODEX_HOME/config.toml;
//   Date is pinned in this process with vi.useFakeTimers({ toFake: ['Date'] }).
// - The optional mapper layer (JD-C02 mapCodexHook) is NOT RUN.

const DIR = fileURLToPath(new URL('../../../docs/jgr/conformance/codex/', import.meta.url));
const CLOCK_PRELOAD = pathToFileURL(
  fileURLToPath(new URL('./codex-conformance-clock.ts', import.meta.url)),
).href;
const SALT = 'codex-conformance-salt-fixed-for-the-whole-run';
const PRODUCER = 'prod_codex-conformance_c0ffee';
const PROJECT = 'web-app';
const RUN = randomBytes(6).toString('hex');
const UUID_V8 = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const AGENT_REF = /^[A-Za-z0-9_:-]{1,128}$/;
const PREFIX = { 'codex-cli': 'cx', 'gemini-cli': 'gm', 'claude-code': 'cc' } as const;
const CODEX_PATH = '/v1/logs/codex-cli';
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
  'cache_write_tokens',
  'reasoning_tokens',
] as const;
const COST_TOLERANCE_USD = 1e-9;
/** `$HOME/.javi` files that hold the bearer secret or the ingest token (README scan item 4). */
const SECRET_STORES = new Set(['usage.json', 'credentials.json']);
/** Names the runner itself puts into child environments (README env hygiene allows CODEX_HOME). */
const RUNNER_ENV = new Set(['CODEX_HOME', 'JAVI_CONFORMANCE_CLOCK', 'JAVI_CONFORMANCE_RUN']);

type Platform = keyof typeof PREFIX;
type AttrMatcher = string | { prefixOf: string; maxLength: number; optional: boolean };
interface ExpectedRecord {
  type: string;
  session: string;
  agent: string | null;
  status?: string;
  attributes: Record<string, AttrMatcher> | null;
}
interface HookInput {
  platform: Platform;
  stdin: unknown;
  rawStdin: string | null;
  env: Record<string, string> | null;
}
interface HookStep extends HookInput {
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
  agent: string | null;
  occurred_at: string | null;
  usage_delta: Record<(typeof COUNTERS)[number], number> & {
    cost_usd: number | null;
    model: string | null;
    estimated: boolean;
  };
}
interface RequestStep {
  request: {
    path: string;
    auth: boolean;
    body: unknown;
    rawBody: string | null;
    bodyPadBytes: number | null;
  };
  expect: { status: number; events: ExpectedEvent[]; droppedUnattributed: IntMatcher | null };
}
interface UsageHookStep {
  hook: HookInput;
  expect: { record: ExpectedRecord | null };
}
interface VectorBase {
  id: string;
  ambiguities: string[];
  clock: string;
  absentStrings: string[];
}
interface HookVector extends VectorBase {
  kind: 'hook';
  usageOn: Platform[];
  steps: HookStep[];
}
interface UsageVector extends VectorBase {
  kind: 'usage';
  registerSessions: Array<{ platform: Platform; session: string }>;
  steps: Array<RequestStep | UsageHookStep>;
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

const isRequest = (s: RequestStep | UsageHookStep): s is RequestStep => 'request' in s;

/** README "Absent strings" → Global: raw session and agent ids, per vector. */
const rawIds = (vector: Vector) => {
  const c = collectRawIds();
  const hook = (h: HookInput, want: ExpectedRecord | null) => {
    c.payload(h.stdin);
    c.rawStdin(h.rawStdin);
    if (want) {
      c.sessions.add(want.session);
      if (want.agent) c.agents.add(want.agent);
    }
  };
  if (vector.kind === 'hook') {
    for (const s of vector.steps) hook(s, s.expect.record);
  } else {
    for (const r of vector.registerSessions) c.sessions.add(r.session);
    for (const s of vector.steps) {
      if (!isRequest(s)) {
        hook(s.hook, s.expect.record);
        continue;
      }
      c.body(s.request.body);
      c.rawBody(s.request.rawBody);
      for (const e of s.expect.events) {
        c.sessions.add(e.session);
        if (e.agent) c.agents.add(e.agent);
      }
    }
  }
  // README: the numeric id 12345 (H14) is excluded; digit-only strings likewise.
  return [...c.sessions, ...c.agents].filter((s) => s && !/^\d+$/.test(s));
};

/** Platforms a vector needs `javi init` for (README "Fixed environment" → Project). */
const platformsOf = (vector: Vector) => {
  const named = new Set<Platform>(['codex-cli']);
  if (vector.kind === 'hook') {
    vector.steps.forEach((s) => named.add(s.platform));
    vector.usageOn.forEach((p) => named.add(p));
  } else {
    vector.registerSessions.forEach((r) => named.add(r.platform));
    vector.steps.forEach((s) => !isRequest(s) && named.add(s.hook.platform));
  }
  return named;
};

/** Run-wide: README "Thread identity" holds across vectors (one salt per run). */
const threadRefs = new Map<string, string>();
const pairOfRef = new Map<string, string>();
/** Run-wide `idLabel` scopes for vectors that share an `identityGroup` (U01 / U12). */
const groupIds = new Map<string, Map<string, string>>();
/** Per-vector outcome lines, printed after the run (PASS / FAIL / BLOCKED + NOT RUN layers). */
const outcomes = new Map<string, string>();

const pairKey = (platform: Platform, session: string) => `${platform}\u0000${session}`;

const realCodexConfig = join(homedir(), '.codex', 'config.toml');
const fingerprint = (path: string) =>
  stat(path).then(
    (s) => `${s.size}:${s.mtimeMs}`,
    () => 'absent',
  );

let stub: Awaited<ReturnType<typeof startIngestStub>>;
let root: string;
let realCodexBefore: string;
beforeAll(async () => {
  realCodexBefore = await fingerprint(realCodexConfig);
  stub = await startIngestStub();
  root = await mkdtemp(join(tmpdir(), 'javi-codex-conf-'));
});
afterAll(async () => {
  await stub?.close();
  if (root) await rm(root, { recursive: true, force: true });
  const lines = files.map((f) => `${f.slice(0, 3)} ${outcomes.get(f) ?? 'NOT RUN'}`);
  console.info(`Codex conformance results (R1):\n${lines.join('\n')}`);
});

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
  // SHOULD (README "Thread identity"): the collector's ref helper, C2 / ADR-0016 §2.
  expect(ref, `${where}: thread_ref = opaqueRef('${prefix}', session, salt)`).toBe(
    opaqueRef(prefix, session, SALT),
  );
};

describe('Codex CLI collector conformance vectors (docs/jgr/conformance/codex)', () => {
  it('has the vectors the README lists (41: 19 hook, 22 usage)', () => {
    expect(vectors.length).toBe(41);
    const hooks = vectors.map(([, v]) => v).filter((v): v is HookVector => v.kind === 'hook');
    const usage = vectors.map(([, v]) => v).filter((v): v is UsageVector => v.kind === 'usage');
    expect(hooks.length).toBe(19);
    expect(usage.length).toBe(22);
    // README "Vectors": 68 hook steps; 52 usage steps (48 requests, 4 hooks), 38 events.
    expect(hooks.reduce((n, v) => n + v.steps.length, 0)).toBe(68);
    const steps = usage.flatMap((v) => v.steps);
    expect(steps.length).toBe(52);
    expect(steps.filter(isRequest).length).toBe(48);
    expect(
      steps.filter(isRequest).reduce((n, s) => n + s.expect.events.length, 0),
      'expected usage events',
    ).toBe(38);
  });

  it.for(vectors)('%s', { timeout: 240_000 }, async ([file, vector], ctx: TestContext) => {
    outcomes.set(file, 'FAIL');
    const blocked = (why: string): never => {
      outcomes.set(file, `BLOCKED: ${why}`);
      return ctx.skip(`BLOCKED (${vector.id}): ${why}`);
    };
    const clock = new Date(vector.clock);
    const home = await mkdtemp(join(root, `${vector.id}-`));
    expect(home.includes('/home/dev'), 'temp dirs must not live under /home/dev').toBe(false);
    const javi = join(home, '.javi');
    const codexDir = join(home, '.codex');
    const project = join(home, PROJECT);
    await mkdir(javi, { recursive: true, mode: 0o700 });
    await mkdir(codexDir, { recursive: true });
    await mkdir(project, { recursive: true });
    // One installation salt for the whole run (README "Fixed environment" → Salt).
    await writeFile(
      join(javi, 'installation.json'),
      JSON.stringify({ producer_id: PRODUCER, salt: SALT }),
      { mode: 0o600 },
    );
    const token = `jd_it_${vector.id}${'c'.repeat(43 - vector.id.length)}`;
    const markerKey = 'JAVI_CONFORMANCE_RUN';
    const markerValue = `${RUN}-${vector.id}`;
    const marker = `${markerKey}=${markerValue}`;
    const childEnv: NodeJS.ProcessEnv = {
      ...hygienicEnv(),
      HOME: home,
      CODEX_HOME: codexDir,
      SHELL: '/bin/sh',
      PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
      JAVI_CONFORMANCE_CLOCK: vector.clock,
      [markerKey]: markerValue,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${CLOCK_PRELOAD}`.trim(),
    };
    const leaked = Object.keys(childEnv).filter((k) => FORBIDDEN_ENV(k) && !RUNNER_ENV.has(k));
    if (leaked.length) blocked(`env hygiene: ${leaked.join(', ')} would reach javi processes`);
    const platforms = platformsOf(vector);

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
        CODEX_HOME: codexDir,
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
    const notRun: string[] = ['mapper layer (optional)'];
    const softFailures: string[] = [];
    const verdict = () =>
      softFailures.length
        ? `FAIL (${softFailures.join('; ')})`
        : `PASS (NOT RUN: ${notRun.join('; ')})`;
    const seen = new Map<string, JgrEvent>();
    const lastSeq = new Map<string, number>();
    const absent = ['SENTINEL', '/home/dev', ...rawIds(vector), ...vector.absentStrings];
    /** README "Thread identity": first record per (platform, session) in this vector. */
    const references = new Map<string, { thread_ref: string; sequence: number }>();
    /** README "Agent identity": (platform, session, agent) → agent_ref. */
    const agentRefs = new Map<string, string>();

    const isCodexCostOnly = (e: JgrEvent) => {
      const u = e.usage_delta as Record<string, unknown> | undefined;
      return (
        e.type === 'usage.reported' &&
        e.thread_ref.startsWith('cx_') &&
        u?.cost_usd !== undefined &&
        u.model === undefined
      );
    };

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
          // Collapse rule: copies with one id are one event and identical in every compared
          // field, except `occurred_at` of a Codex cost-only report (X19).
          const strip = (e: JgrEvent) => {
            if (!isCodexCostOnly(e)) return e;
            const rest: Partial<JgrEvent> = { ...e };
            delete rest.occurred_at;
            return rest;
          };
          // Soft: the vector still FAILs, but later steps run, so the report shows them too.
          if (!isDeepStrictEqual(strip(event), strip(earlier)))
            softFailures.push(`${where}: collapse rule`);
          expect
            .soft(strip(event), `${where}: copies of event ${id} differ (collapse rule)`)
            .toEqual(strip(earlier));
          continue;
        }
        seen.set(id, event);
        fresh.push(event);
      }
      return fresh;
    };

    /** I6 on one text (a response body); README "Absent strings" item 3. */
    const scanText = (where: string, name: string, text: string, secretExempt = false) => {
      for (const s of absent) {
        expect(text.includes(s), `${where} I6: "${s}" found in ${name}`).toBe(false);
      }
      if (secret && !secretExempt) {
        expect(text.includes(secret), `${where} I6: $SECRET found in ${name}`).toBe(false);
      }
    };

    /** I6, README "Absent strings" → Where to scan: records, spool, batches, $HOME/.javi. */
    const scan = async (where: string, records: JgrEvent[]) => {
      for (const r of records) scanText(where, `record ${r.event_id}`, JSON.stringify(r));
      for (const [i, text] of stub.batches(token).entries()) {
        scanText(where, `ingest batch ${i + 1}`, text);
      }
      for (const path of await listFiles(javi)) {
        const text = await readIfPresent(path);
        const name = relative(javi, path);
        // Only javi's secret / token stores are exempt, and only from the $SECRET check;
        // warning files never are (README item 4, D0 H1/H2).
        const exempt = SECRET_STORES.has(basename(path)) && !name.startsWith('warnings');
        if (text !== null) scanText(where, path, text, exempt);
        for (const s of absent) {
          expect(name.includes(s), `${where} I6: "${s}" in file name ${name}`).toBe(false);
        }
      }
    };

    /** I1–I5, I10 for one emitted record; `origin` says what produced it (I3). */
    const invariants = (e: JgrEvent, where: string, origin: Platform | 'receiver' | 'setup') => {
      const atw = `${where} [${e.type} ${e.event_id}]`;
      const result = validateEvent(e, clock);
      expect(result.ok, `${atw} I1 JGR v0.1 at clock: ${JSON.stringify(result)}`).toBe(true);
      expect(e.privacy_class === undefined || e.privacy_class === 'L0', `${atw} I2 L0`).toBe(true);
      expect('encrypted' in e, `${atw} I2 no encrypted`).toBe(false);
      for (const [key, value] of Object.entries(e.attributes ?? {})) {
        expect(L0_ATTRIBUTES.has(key), `${atw} I2 attribute ${key} in L0 allowlist`).toBe(true);
        if (typeof value === 'string') {
          expect(value.length, `${atw} I2 ${key} ≤ 128 chars`).toBeLessThanOrEqual(128);
        }
      }
      if (origin !== 'receiver' && origin !== 'setup' && !e.type.startsWith('x.')) {
        // I3: refs and the platform attribute follow the agent that sent the payload.
        expect(e.thread_ref.startsWith(`${PREFIX[origin]}_`), `${atw} I3 ${origin} ref`).toBe(true);
        if (origin === 'codex-cli') {
          expect(e.attributes?.platform, `${atw} I3 platform`).toBe('codex-cli');
        }
      }
      if (e.agent_ref !== undefined) {
        // I10
        expect(e.agent_ref, `${atw} I10 agent_ref pattern`).toMatch(AGENT_REF);
        expect(pairOfRef.has(e.agent_ref) || e.agent_ref === e.thread_ref, `${atw} I10`).toBe(
          false,
        );
      }
      const u = e.usage_delta as Record<string, unknown> | undefined;
      if (u) {
        for (const c of COUNTERS) {
          if (u[c] === undefined) continue;
          expect(Number.isInteger(u[c]) && (u[c] as number) >= 0, `${atw} I4 ${c}`).toBe(true);
        }
        if (u.cost_usd !== undefined) {
          const cost = u.cost_usd as number;
          expect(Number.isFinite(cost) && cost >= 0, `${atw} I4 cost_usd`).toBe(true);
        }
        if (e.thread_ref.startsWith('cx_')) {
          // I5: exact counts, no reasoning tokens, token and cost reports separate (C5).
          expect(u.estimated === true, `${atw} I5 estimated must not be true`).toBe(false);
          expect(u.reasoning_tokens ?? 0, `${atw} I5 reasoning_tokens`).toBe(0);
          const tokens = COUNTERS.some((c) => Number(u[c] ?? 0) > 0);
          expect(tokens && u.cost_usd !== undefined, `${atw} I5 tokens and cost_usd`).toBe(false);
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

    /** javi's Codex handlers by event (README "Invocation"); Gemini / Claude Code argv. */
    const codexCommands = new Map<string, string>();
    const hookArgv: Partial<
      Record<Platform, { sh: string } | { bash: string } | { file: string; args: string[] }>
    > = {};

    /** One collector-layer hook step (README "Hook steps"); returns its non-x.* records. */
    const hookStep = async (
      platform: Platform,
      stdin: Buffer,
      parsed: unknown,
      where: string,
      stepEnv: Record<string, string> | null = null,
    ) => {
      let argv = hookArgv[platform];
      if (platform === 'codex-cli') {
        const name =
          parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as { hook_event_name?: unknown }).hook_event_name
            : undefined;
        const command =
          (typeof name === 'string' && codexCommands.get(name)) ||
          codexCommands.get('SessionStart');
        if (command) argv = { sh: command };
      }
      if (!argv) return blocked(`no javi-collector hook entry for ${platform}`);
      const env: NodeJS.ProcessEnv = { ...childEnv };
      if (platform === 'gemini-cli') {
        env.GEMINI_PROJECT_DIR = project;
        env.GEMINI_CWD = project;
      }
      if (platform === 'claude-code') env.CLAUDE_PROJECT_DIR = project;
      for (const [k, v] of Object.entries(stepEnv ?? {})) {
        if (v.includes('$SECRET') && !secret) return blocked(`${where}: $SECRET with usage off`);
        env[k] = v.replaceAll('$SECRET', secret ?? '');
      }
      const result = await runProcess(argv, stdin, { cwd: project, env });
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

    /** README "Record comparison" for one hook step's records against its expectation. */
    const compareRecord = (
      platform: Platform,
      parsed: unknown,
      records: JgrEvent[],
      want: ExpectedRecord | null,
      where: string,
    ) => {
      if (want === null) {
        expect(
          records.map((r) => r.type),
          `${where}: expected no record`,
        ).toEqual([]);
        return;
      }
      expect(
        records.map((r) => r.type),
        `${where}: expected exactly one record`,
      ).toEqual([want.type]);
      const record = records[0]!;
      checkThread(platform, want.session, record.thread_ref, where);
      const key = pairKey(platform, want.session);
      if (!references.has(key)) {
        references.set(key, { thread_ref: record.thread_ref, sequence: record.sequence });
      }
      // README "Agent identity" / I10.
      const payloadAgent =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as { agent_id?: unknown }).agent_id
          : undefined;
      if (typeof payloadAgent !== 'string') {
        expect(record.agent_ref, `${where} I10 no agent_id in payload → no agent_ref`).toBe(
          undefined,
        );
      }
      if (want.agent === null) {
        expect(record.agent_ref, `${where}: agent_ref must be absent`).toBeUndefined();
      } else {
        const ref = record.agent_ref;
        expect(typeof ref, `${where}: agent_ref for agent ${want.agent}`).toBe('string');
        expect(ref, `${where}: agent_ref pattern`).toMatch(AGENT_REF);
        expect(ref, `${where}: agent_ref ≠ thread_ref`).not.toBe(record.thread_ref);
        const akey = `${key}\u0000${want.agent}`;
        const known = agentRefs.get(akey);
        if (known) expect(ref, `${where}: same agent → same agent_ref`).toBe(known);
        else {
          expect(
            [...agentRefs.values()],
            `${where}: another agent has this agent_ref`,
          ).not.toContain(ref);
          agentRefs.set(akey, ref!);
        }
      }
      if (want.status !== undefined) expect(record.status, `${where}: status`).toBe(want.status);
      if (want.attributes !== null) {
        const attrs = (record.attributes ?? {}) as Record<string, unknown>;
        for (const k of CONTROLLED) {
          const m = want.attributes[k];
          const value = attrs[k];
          if (m === undefined) {
            expect(value, `${where}: controlled key "${k}" must be absent`).toBeUndefined();
          } else if (typeof m === 'string') {
            expect(value, `${where}: attributes.${k}`).toBe(m);
          } else if (value === undefined) {
            expect(m.optional, `${where}: attributes.${k} may not be absent`).toBe(true);
          } else {
            const ok =
              typeof value === 'string' &&
              value.length > 0 &&
              value.length <= m.maxLength &&
              m.prefixOf.startsWith(value);
            expect(ok, `${where}: attributes.${k} "${String(value)}" prefix ≤ ${m.maxLength}`).toBe(
              true,
            );
          }
        }
      }
    };

    const runHookInput = async (h: HookInput, want: ExpectedRecord | null, where: string) => {
      const text = h.rawStdin !== null ? h.rawStdin : JSON.stringify(h.stdin);
      const parsed = h.rawStdin !== null ? undefined : h.stdin;
      const records = await hookStep(h.platform, Buffer.from(text, 'utf8'), parsed, where, h.env);
      compareRecord(h.platform, parsed, records, want, where);
    };

    try {
      // --- Pinned clock (README "Pinned clock"): this process, then the javi processes. ---
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

      // --- CODEX_HOME (README "Fixed environment"): BLOCKED, running nothing, if javi would
      // resolve Codex's folder anywhere but the vector's $HOME/.codex. ---
      if (codexHome(io.env) !== codexDir || codexHome(childEnv) !== codexDir) {
        blocked(`CODEX_HOME does not point at ${codexDir}`);
      }

      // --- Fixed environment: init (Codex always; Gemini / Claude Code when named) ---
      const init = await main(
        ['init', '--project', PROJECT, '--platform', 'codex-cli', '--endpoint', stub.endpoint],
        io,
      );
      if (init !== 0)
        blocked(`javi init --platform codex-cli exited ${init}: ${lines.join(' | ')}`);
      if (platforms.has('gemini-cli')) {
        const gm = await main(
          ['init', '--project', PROJECT, '--platform', 'gemini-cli', '--endpoint', stub.endpoint],
          io,
        );
        if (gm !== 0) blocked(`javi init --platform gemini-cli exited ${gm}: ${lines.join(' | ')}`);
      }
      if (platforms.has('claude-code')) {
        const cc = await main(['init', '--project', PROJECT, '--endpoint', stub.endpoint], io);
        if (cc !== 0) blocked(`javi init (claude-code) exited ${cc}: ${lines.join(' | ')}`);
      }
      await settle();

      // javi's handlers: `type: "command"` handlers whose command has `--source javi-collector`.
      const hooksJson = JSON.parse(
        await readFile(join(project, '.codex', 'hooks.json'), 'utf8'),
      ) as {
        hooks?: Record<string, Array<{ hooks?: Array<{ type?: string; command?: string }> }>>;
      };
      for (const [event, groups] of Object.entries(hooksJson.hooks ?? {})) {
        for (const h of (groups ?? []).flatMap((g) => g.hooks ?? [])) {
          if (h.type === 'command' && h.command?.includes('--source javi-collector')) {
            codexCommands.set(event, h.command);
          }
        }
      }
      const sessionStart = codexCommands.get('SessionStart');
      if (!sessionStart) blocked('no javi SessionStart handler in .codex/hooks.json');
      // README "Invocation" (D0 H4): the expected shape of the command, unquoted.
      const launcher = `${join(home, '.javi', 'bin', 'javi-hook')} --platform codex-cli --project ${PROJECT} --source javi-collector`;
      for (const [event, command] of codexCommands) {
        expect(command, `setup: .codex/hooks.json ${event} command shape (D0 H4)`).toBe(launcher);
      }
      if (platforms.has('gemini-cli')) {
        const settings = JSON.parse(
          await readFile(join(project, '.gemini', 'settings.json'), 'utf8'),
        ) as {
          hooks?: Record<string, Array<{ hooks?: Array<{ name?: string; command?: string }> }>>;
        };
        const commands = new Set(
          Object.values(settings.hooks ?? {})
            .flat()
            .flatMap((g) => g.hooks ?? [])
            .filter((h) => h.name === 'javi-collector' && typeof h.command === 'string')
            .map((h) => h.command!),
        );
        if (commands.size !== 1) blocked(`${commands.size} javi-collector commands in Gemini`);
        hookArgv['gemini-cli'] = { bash: [...commands][0]! };
      }
      if (platforms.has('claude-code')) {
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

      // --- Usage (usage vectors; hook vectors with a non-empty usageOn) ---
      const usagePlatforms: Platform[] =
        vector.kind === 'usage'
          ? [
              'codex-cli',
              ...(vector.registerSessions.some((r) => r.platform === 'gemini-cli')
                ? (['gemini-cli'] as const)
                : []),
              ...(vector.registerSessions.some((r) => r.platform === 'claude-code')
                ? (['claude-code'] as const)
                : []),
            ]
          : (['codex-cli', 'gemini-cli', 'claude-code'] as const).filter((p) =>
              vector.usageOn.includes(p),
            );
      let port: number | null = null;
      if (usagePlatforms.length) {
        if (
          usagePlatforms.includes('gemini-cli') &&
          (await stat(join(home, '.gemini', 'settings.json')).then(
            () => true,
            () => false,
          ))
        ) {
          blocked('~/.gemini/settings.json exists before usage on');
        }
        // A free port per vector: vitest runs other test files in parallel workers. Only the
        // first `usage on` carries --port (one receiver port and secret for all platforms).
        const free = await freePort();
        for (const [i, p] of usagePlatforms.entries()) {
          const argv = ['usage', 'on'];
          if (p !== 'claude-code') argv.push('--platform', p);
          if (i === 0) argv.push('--port', String(free));
          const code = await main(argv, io);
          if (code !== 0) blocked(`javi ${argv.join(' ')} exited ${code}: ${lines.join(' | ')}`);
        }
        const config = await state.usageConfig();
        if (!config) return blocked('no usage configuration after javi usage on');

        if (usagePlatforms.includes('codex-cli')) {
          // README "Setup checks" S1–S5 on $CODEX_HOME/config.toml (a FAIL, reported as setup).
          const tomlPath = join(codexDir, 'config.toml');
          const text = (await readIfPresent(tomlPath)) ?? '';
          let toml: unknown = null;
          try {
            toml = parseToml(text);
          } catch (e) {
            expect.fail(`setup S1: ${tomlPath} does not parse as TOML: ${(e as Error).message}`);
          }
          const fileLines = text.split(/\r?\n/);
          expect(fileLines, 'setup S1: start marker line').toContain(
            '# >>> javi usage (do not edit)',
          );
          expect(fileLines, 'setup S1: end marker line').toContain('# <<< javi');
          const exporter = ['otel', 'exporter', 'otlp-http'];
          const endpoint = at(toml, [...exporter, 'endpoint']);
          const m = /^http:\/\/127\.0\.0\.1:(\d+)\/v1\/logs\/codex-cli$/.exec(String(endpoint));
          expect(m, `setup S2: endpoint ${String(endpoint)}`).not.toBeNull();
          expect(at(toml, [...exporter, 'protocol']), 'setup S2: protocol').toBe('json');
          const auth = at(toml, [...exporter, 'headers', 'Authorization']);
          const a = /^Bearer ([^ ].*)$/.exec(typeof auth === 'string' ? auth : '');
          expect(a, 'setup S3: Authorization = "Bearer <secret>"').not.toBeNull();
          for (const k of [
            'log_user_prompt',
            'log_agent_responses',
            'log_guardian_assessments',
            'log_sse_deltas',
          ]) {
            expect(at(toml, ['otel', k]), `setup S4: otel.${k}`).toBe(false);
          }
          expect(at(toml, ['otel', 'metrics_exporter']), 'setup S5: otel.metrics_exporter').toBe(
            undefined,
          );
          expect(at(toml, ['otel', 'trace_exporter']), 'setup S5: otel.trace_exporter').toBe(
            undefined,
          );
          port = Number(m![1]);
          secret = a![1]!;
          // README "$PORT, $SECRET": equal to javi's usage configuration when readable.
          expect(port, 'setup: config.toml port = javi usage port').toBe(config.port);
          expect(secret, 'setup: config.toml secret = javi usage secret').toBe(config.secret);
        } else {
          port = config.port;
          secret = config.secret;
        }
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
        const bound = await receiver
          .listen()
          .catch((e: Error) => blocked(`receiver: ${e.message}`));
        expect(bound).toBe(config.port);
      }

      if (vector.kind === 'hook') {
        await ctx.annotate(
          `Layer: collector (/bin/sh -c javi's .codex/hooks.json command; launcher RUN); process checks RUN; mapper layer NOT RUN (optional). Ambiguities: ${vector.ambiguities.join(', ') || 'none'}.`,
        );
        for (const [i, step] of vector.steps.entries()) {
          await runHookInput(step, step.expect.record, `${file} step ${i + 1} (${step.platform})`);
        }
        outcomes.set(file, verdict());
        return;
      }

      // --- Usage vectors: registration, then request and hook steps ---
      await ctx.annotate(
        `Layer: receiver in-process (createUsageReceiver, the code javi receive runs); hook and registration steps are collector-layer processes; mapper layer NOT RUN (optional). Ambiguities: ${vector.ambiguities.join(', ') || 'none'}.`,
      );
      for (const reg of vector.registerSessions) {
        const where = `${file} registration ${reg.platform} ${reg.session}`;
        const payload =
          reg.platform === 'codex-cli'
            ? {
                session_id: reg.session,
                transcript_path:
                  '/home/dev/.codex/sessions/2026/10/29/rollout-SENTINEL_REG_TRANSCRIPT.jsonl',
                cwd: '/home/dev/SENTINEL_REG_CWD/web-app',
                hook_event_name: 'SessionStart',
                model: 'gpt-5.5-codex',
                permission_mode: 'default',
                source: 'startup',
              }
            : reg.platform === 'gemini-cli'
              ? {
                  session_id: reg.session,
                  transcript_path:
                    '/home/dev/.gemini/tmp/SENTINEL_REG_TRANSCRIPT/chats/session.json',
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
        const records = await hookStep(
          reg.platform,
          Buffer.from(JSON.stringify(payload)),
          payload,
          where,
        );
        if (records.length !== 1 || records[0]!.type !== 'session.started') {
          blocked(`${where}: expected one session.started, got [${records.map((r) => r.type)}]`);
        }
        compareRecord(
          reg.platform,
          payload,
          records,
          { type: 'session.started', session: reg.session, agent: null, attributes: null },
          where,
        );
      }

      const dropped = async () => (await state.receiverInfo())?.dropped;
      const droppedAtStart = await dropped();
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
        const ref = references.get(pairKey(x.platform, x.session));
        if (!ref) d.push(`no thread reference for ${x.platform} ${x.session}`);
        else {
          if (p.thread_ref !== ref.thread_ref) d.push('thread_ref ≠ thread reference');
          if (!(Number.isInteger(p.sequence) && p.sequence > ref.sequence)) {
            d.push(`sequence ${p.sequence} not > reference ${ref.sequence}`);
          }
        }
        if (x.agent === null) {
          if (p.agent_ref !== undefined) d.push(`agent_ref ${p.agent_ref} must be absent`);
        } else {
          const want = agentRefs.get(`${pairKey(x.platform, x.session)}\u0000${x.agent}`);
          if (!want) d.push(`no agent reference established for ${x.agent}`);
          else if (p.agent_ref !== want) d.push(`agent_ref ${String(p.agent_ref)} ≠ ${want}`);
        }
        if (!UUID_V8.test(p.event_id)) d.push(`event_id ${p.event_id} is not a UUID v8`);
        if (x.occurred_at !== null) {
          if (Date.parse(p.occurred_at) !== Date.parse(x.occurred_at)) {
            d.push(`occurred_at ${p.occurred_at} ≠ ${x.occurred_at}`);
          }
        } else if (!(Date.parse(p.occurred_at) <= clock.getTime())) {
          d.push(`occurred_at ${p.occurred_at} invalid or after clock`);
        }
        for (const c of COUNTERS) {
          if (Number(u[c] ?? 0) !== xu[c]) d.push(`${c} ${String(u[c])} ≠ ${xu[c]}`);
        }
        if (xu.cost_usd === null) {
          if ('cost_usd' in u) d.push(`cost_usd ${String(u.cost_usd)} must be absent`);
        } else if (x.platform === 'claude-code' && xu.cost_usd === 0 && !('cost_usd' in u)) {
          // Claude Code: an expected 0 also matches an absent key.
        } else if (
          typeof u.cost_usd !== 'number' ||
          !(Math.abs(u.cost_usd - xu.cost_usd) <= COST_TOLERANCE_USD)
        ) {
          d.push(`cost_usd ${String(u.cost_usd)} ≠ ${xu.cost_usd} (±${COST_TOLERANCE_USD})`);
        }
        if (xu.model === null) {
          if ('model' in u) d.push(`model ${String(u.model)} must be absent`);
        } else if (u.model !== xu.model) d.push(`model ${String(u.model)} ≠ ${xu.model}`);
        if (u.estimated !== false && u.estimated !== undefined) {
          d.push(`estimated ${String(u.estimated)} must be false or absent`);
        }
        const extra = Object.keys(u).filter((k) => !USAGE_KEYS.has(k));
        if (extra.length) d.push(`extra usage_delta keys ${extra.join(', ')}`);
        return d;
      };

      for (const [i, step] of vector.steps.entries()) {
        if (!isRequest(step)) {
          await runHookInput(
            step.hook,
            step.expect.record,
            `${file} step ${i + 1} (hook ${step.hook.platform})`,
          );
          continue;
        }
        const where = `${file} step ${i + 1} (${step.request.path})`;
        const droppedBefore = await dropped();
        let body = Buffer.from(
          step.request.rawBody !== null ? step.request.rawBody : JSON.stringify(step.request.body),
          'utf8',
        );
        const pad = step.request.bodyPadBytes;
        if (pad !== null && body.length < pad) {
          body = Buffer.concat([body, Buffer.alloc(pad - body.length, 0x20)]);
        }
        const reply = await rawPost(
          port!,
          step.request.path,
          body,
          step.request.auth ? `Bearer ${secret}` : null,
        );
        expect(reply.status, `${where}: status (body ${reply.body})`).toBe(step.expect.status);
        if (reply.status === 200) {
          expect(JSON.parse(reply.body), `${where}: body`).toEqual({});
          expect(
            (reply.headers['content-type'] ?? '').split(';')[0]!.trim(),
            `${where}: content-type`,
          ).toBe('application/json');
        }
        // README "Response" (D0 M1): no absent string in any response body.
        scanText(where, 'response body', reply.body);
        await settle();
        if (!(await waitForQuiescence(marker))) {
          return blocked(`${where}: a javi process did not finish within 15 s (cannot observe)`);
        }
        const fresh = await observe(where);
        for (const e of fresh) {
          invariants(e, where, 'receiver');
          // I3: Codex log records only ever give cx_ refs; other paths never do.
          if (step.request.path === CODEX_PATH) {
            expect(e.thread_ref.startsWith('cx_'), `${where} I3 cx_ ref on the Codex path`).toBe(
              true,
            );
          } else {
            expect(
              e.thread_ref.startsWith('cx_'),
              `${where} I3 no cx_ ref off the Codex path`,
            ).toBe(false);
          }
        }
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
        const summary = produced.map((e) => ({
          occurred_at: e.occurred_at,
          agent_ref: e.agent_ref,
          ...e.usage_delta,
        }));
        expect(produced.length, `${where}: event count; produced ${JSON.stringify(summary)}`).toBe(
          step.expect.events.length,
        );
        const unmatched = [...produced];
        for (const expected of step.expect.events) {
          const diffs = unmatched.map((p) => diff(p, expected));
          const idx = diffs.findIndex((d) => d.length === 0);
          expect(
            idx,
            `${where}: expected event ${expected.idLabel} (${expected.platform} ${expected.session}) — ${JSON.stringify(diffs)}`,
          ).toBeGreaterThanOrEqual(0);
          const [event] = unmatched.splice(idx, 1);
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
          const after = await dropped();
          if (typeof after !== 'number' || typeof droppedBefore !== 'number') {
            notRun.push(`${where}: drop counter unreadable`);
          } else {
            expect(
              intMatches(after - droppedBefore, step.expect.droppedUnattributed),
              `${where}: unattributed drops grew by ${after - droppedBefore}`,
            ).toBe(true);
          }
        }
      }

      if (vector.droppedUnattributedTotal !== null) {
        const after = await dropped();
        if (typeof after !== 'number' || typeof droppedAtStart !== 'number') {
          notRun.push('vector drop total: drop counter unreadable');
        } else {
          expect(
            intMatches(after - droppedAtStart, vector.droppedUnattributedTotal),
            `${file}: unattributed drops over the vector grew by ${after - droppedAtStart}`,
          ).toBe(true);
        }
      }
      if (notRun.length > 1) await ctx.annotate(`NOT RUN: ${notRun.join('; ')}`);
      outcomes.set(file, verdict());
    } finally {
      if (!(await waitForQuiescence(marker))) {
        // README "Receiver": kill any leftover javi process of this vector.
        for (const pid of (await markedProcesses(marker)) ?? []) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // already gone
          }
        }
      }
      await receiver?.close();
      await settle();
      vi.useRealTimers();
    }
  });

  it('never touched the real ~/.codex/config.toml', async () => {
    expect(await fingerprint(realCodexConfig)).toBe(realCodexBefore);
  });
});
