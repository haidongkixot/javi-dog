import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { canonicalEventId, L0_ATTRIBUTES, validateEvent, type JgrEvent } from '@javis-dog/jgr-spec';
import { afterAll, beforeAll, describe, expect, it, vi, type TestContext } from 'vitest';
import { createState, main, runFlush, type Io } from '../src/index.ts';
import {
  collectRawIds,
  FORBIDDEN_ENV,
  hygienicEnv,
  listFiles,
  markedProcesses,
  readIfPresent,
  runProcess,
  startIngestStub,
  waitForQuiescence,
} from './codex-conformance-harness.ts';
import {
  attributeProblem,
  isJaviToolCall,
  loadHookVectors,
  loadSchemaValidator,
  statusProblem,
  ULID,
  ulidTimeMs,
  type ExpectedRecord,
  type HookVector,
  type Platform,
} from './self-report-conformance-vectors.ts';

// T5 (S5d) runner part 2: the QA lane's agent self-report vectors, group H (hook mapping), in
// docs/jgr/conformance/self-report, written from that README's "Runner rules" → "Hook steps".
// Expectations come from the vector files only; product code is driven through its public
// seams and real processes, never consulted for expected values.
//
// - Layer: COLLECTOR (required for a PASS). Every step runs javi's real hook entry as a
//   process: Claude Code the exec-form argv of `<project>/.claude/settings.local.json`, Codex
//   the javi-collector handler of `<project>/.codex/hooks.json` with `/bin/sh -c`, Gemini the
//   javi-collector command of `<project>/.gemini/settings.json` with `bash -c`. Process checks
//   (I8: exit 0, 0 bytes of stdout, 10 s) RUN.
// - Fixed environment: one fresh HOME per vector, CODEX_HOME = $HOME/.codex, env hygiene as the
//   Codex runner, one fixed installation salt for the whole run, project `web-app` initialised
//   with `javi init` for claude-code, codex-cli and gemini-cli WITHOUT `--self-report` (G11),
//   in-process through `main()`; a capturing ingest stub on 127.0.0.1.
// - Pinned clock: NODE_OPTIONS=--import test/codex-conformance-clock.ts (the Codex runner's
//   preload, reused) in every javi process and the detached `javi flush` they spawn; Date is
//   pinned in this process with vi.useFakeTimers({ toFake: ['Date'] }).
// - Observation: after the hook and any flush it started have exited (/proc marker, or the
//   README's 4 s fallback), new canonical event ids from the spool and the captured batches.
// - The optional MAPPER layer (JD-C02 mappers called directly) is NOT RUN.
// - Every H file is validated against schema.json with Ajv draft-07, resolved through JD-C03's
//   dev dependency `@modelcontextprotocol/sdk` (the M runner's validator), no new dependency.

const CLOCK_PRELOAD = pathToFileURL(
  fileURLToPath(new URL('./codex-conformance-clock.ts', import.meta.url)),
).href;
const SALT = 'self-report-conformance-salt-fixed-for-the-whole-run';
const PRODUCER = 'prod_self-report-conformance_5d';
const PROJECT = 'web-app';
const RUN = randomBytes(6).toString('hex');
const AGENT_REF = /^[A-Za-z0-9_:-]{1,128}$/;
const PREFIX: Readonly<Record<Platform, string>> = {
  'claude-code': 'cc',
  'codex-cli': 'cx',
  'gemini-cli': 'gm',
};
/** README "Record comparison": the L0 allowlist minus the free keys. */
const FREE_KEYS = new Set(['platform_version', 'collector_version', 'duration_ms']);
const CONTROLLED = [...L0_ATTRIBUTES].filter((k) => !FREE_KEYS.has(k));
/** Names the runner itself puts into child environments. */
const RUNNER_ENV = new Set(['CODEX_HOME', 'JAVI_CONFORMANCE_CLOCK', 'JAVI_CONFORMANCE_RUN']);

const loaded = await loadHookVectors();
const vectors = loaded.map(([f, v]) => [f, v as HookVector] as const);
const validate = await loadSchemaValidator();

/** Run-wide: README "Thread and agent identity" holds across vectors (one salt per run). */
const threadRefs = new Map<string, string>();
const pairOfRef = new Map<string, string>();
/** Run-wide `idLabel` scopes for vectors that share an `identityGroup` (H11 / H12). */
const groupIds = new Map<string, Map<string, string>>();
/** Per-vector outcome lines, printed after the run. */
const outcomes = new Map<string, string>();

const pairKey = (platform: Platform, session: string) => `${platform}\u0000${session}`;

let stub: Awaited<ReturnType<typeof startIngestStub>>;
let root: string;
beforeAll(async () => {
  stub = await startIngestStub();
  root = await mkdtemp(join(tmpdir(), 'javi-sr-conf-'));
});
afterAll(async () => {
  await stub?.close();
  if (root) await rm(root, { recursive: true, force: true });
  const lines = vectors.map(([f]) => `${f.slice(0, 3)} ${outcomes.get(f) ?? 'NOT RUN'}`);
  console.info(`Self-report conformance results, group H (collector layer):\n${lines.join('\n')}`);
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
};

describe('self-report conformance vectors: schema (README "Format")', () => {
  it('has the hook vectors the README lists (14 vectors, 200 steps)', () => {
    expect(vectors.length).toBe(14);
    expect(vectors.reduce((n, [, v]) => n + v.steps.length, 0)).toBe(200);
  });

  it('the schema validator resolves and is not vacuous', (ctx) => {
    if (!validate) return ctx.skip('BLOCKED: Ajv not resolvable through JD-C03');
    const [, sample] = vectors[0]!;
    expect(validate(sample).valid).toBe(true);
    expect(validate({ ...sample, steps: [] }).valid).toBe(false);
    expect(validate({ ...sample, clock: '2026-10-30T10:00:01Z' }).valid).toBe(false);
    const step = { ...sample.steps[0]!, expect: { record: { type: 'heartbeat' } } };
    expect(validate({ ...sample, steps: [step] }).valid).toBe(false);
  });

  it.for(vectors.map(([f]) => f))('%s validates against schema.json', (file, ctx) => {
    if (!validate) return ctx.skip('BLOCKED: Ajv not resolvable through JD-C03');
    const [, vector] = vectors.find(([f]) => f === file)!;
    const result = validate(vector);
    expect(result.errorMessage ?? null, `${file} against schema.json`).toBeNull();
    expect(result.valid).toBe(true);
    expect(file.startsWith(`${vector.id}-`)).toBe(true);
    expect(vector.kind).toBe('hook');
  });
});

describe('self-report conformance vectors: H group (JD-C01 + JD-C02, collector layer)', () => {
  it.for(vectors)('%s', { timeout: 300_000 }, async ([file, vector], ctx: TestContext) => {
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
    const token = `jd_it_${vector.id}${'s'.repeat(43 - vector.id.length)}`;
    const markerKey = 'JAVI_CONFORMANCE_RUN';
    const markerValue = `${RUN}-${vector.id}`;
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

    const state = createState(javi);
    const pending = new Set<Promise<unknown>>();
    const settle = async () => {
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
      spawnFlush: (ref) => {
        const p = runFlush({ state, projectRef: ref });
        pending.add(p);
        void p.finally(() => pending.delete(p)).catch(() => {});
      },
      spawnReceiver: () => {},
    };

    const seen = new Set<string>();
    const lastSeq = new Map<string, number>();
    const labels = new Map<string, string>();
    const agentRefs = new Map<string, string>();
    const raw = collectRawIds();
    for (const s of vector.steps) {
      raw.payload(s.stdin);
      if (s.expect.record) {
        raw.sessions.add(s.expect.record.session);
        if (s.expect.record.agent) raw.agents.add(s.expect.record.agent);
      }
    }
    const absent = [
      'SENTINEL',
      '/home/dev',
      ...raw.sessions,
      ...raw.agents,
      ...vector.absentStrings,
    ];

    /** Spool first, then batches: a flush captures an event before it deletes the file. */
    const observe = async () => {
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
        if (seen.has(id)) continue;
        seen.add(id);
        fresh.push(event);
      }
      return fresh;
    };

    /** I6: records, spool files, captured batches and every file under $HOME/.javi. */
    const scan = async (where: string, records: JgrEvent[]) => {
      const texts: Array<[string, string]> = records.map((r) => [
        `record ${r.event_id}`,
        JSON.stringify(r),
      ]);
      for (const [i, text] of stub.batches(token).entries()) texts.push([`batch ${i + 1}`, text]);
      for (const path of await listFiles(javi)) {
        const name = relative(javi, path);
        texts.push([`file name ${name}`, name]);
        const text = await readIfPresent(path);
        if (text !== null) texts.push([`file ${name}`, text]);
      }
      for (const [name, text] of texts) {
        for (const s of absent) {
          expect(text.includes(s), `${where} I6: "${s}" found in ${name}`).toBe(false);
        }
      }
    };

    /** I1–I3 for one emitted record (x.* included: I1, I2 and I6 apply to them too). */
    const invariants = (e: JgrEvent, where: string, platform: Platform | 'setup') => {
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
      if (platform !== 'setup' && !e.type.startsWith('x.')) {
        expect(e.thread_ref.startsWith(`${PREFIX[platform]}_`), `${atw} I3 ref prefix`).toBe(true);
        const attr = (e.attributes ?? {}) as Record<string, unknown>;
        if (attr.platform !== undefined) {
          expect(attr.platform, `${atw} I3 attributes.platform`).toBe(platform);
        }
      }
    };

    /** I7: per thread, sequences strictly increase in emission (step) order. */
    const advanceSequences = (records: JgrEvent[], where: string) => {
      for (const r of records) {
        const before = lastSeq.get(r.thread_ref) ?? -1;
        expect(
          r.sequence,
          `${where} I7 sequence on ${r.thread_ref} after ${before}`,
        ).toBeGreaterThan(before);
        lastSeq.set(r.thread_ref, r.sequence);
      }
    };

    const hookArgv: Partial<
      Record<Platform, { sh: string } | { bash: string } | { file: string; args: string[] }>
    > = {};
    const codexCommands = new Map<string, string>();

    /** README "Record comparison" and "Event identity" for one step. */
    const compare = (
      platform: Platform,
      stdin: Record<string, unknown>,
      records: JgrEvent[],
      want: ExpectedRecord | null,
      where: string,
    ) => {
      if (want === null) {
        expect(
          records.map((r) => `${r.type}${r.status ? ` ${r.status}` : ''}`),
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
      if (want.agent === null) {
        expect(record.agent_ref, `${where}: agent_ref must be absent`).toBeUndefined();
      } else {
        const ref = record.agent_ref;
        expect(typeof ref, `${where}: agent_ref for agent ${want.agent}`).toBe('string');
        expect(ref, `${where}: agent_ref pattern`).toMatch(AGENT_REF);
        expect(pairOfRef.has(ref!), `${where}: agent_ref differs from every thread_ref`).toBe(
          false,
        );
        const akey = `${pairKey(platform, want.session)}\u0000${want.agent}`;
        const known = agentRefs.get(akey);
        if (known) expect(ref, `${where}: same agent → same agent_ref`).toBe(known);
        else agentRefs.set(akey, ref!);
      }
      const statusIssue = statusProblem(want.status, record.status);
      expect(statusIssue, `${where}: status`).toBeNull();
      if (want.attributes !== null) {
        const attrs = (record.attributes ?? {}) as Record<string, unknown>;
        const issues = CONTROLLED.map((k) =>
          attributeProblem(k, want.attributes![k], attrs[k]),
        ).filter((x) => x !== null);
        expect(issues, `${where}: attributes ${JSON.stringify(attrs)}`).toEqual([]);
      }
      if (want.eventId !== null) {
        const id = String(record.event_id).toUpperCase();
        expect(id, `${where}: event_id is a ULID`).toMatch(ULID);
        expect(ulidTimeMs(id), `${where}: ULID time part = vector clock`).toBe(clock.getTime());
        const label = want.eventId.idLabel;
        if (label !== null) {
          const scope = vector.identityGroup
            ? (groupIds.get(vector.identityGroup) ??
              groupIds.set(vector.identityGroup, new Map()).get(vector.identityGroup)!)
            : labels;
          const canonical = canonicalEventId(String(record.event_id));
          const known = scope.get(label);
          if (known) expect(canonical, `${where}: idLabel ${label} → same event_id`).toBe(known);
          else {
            expect(
              [...scope.values()],
              `${where}: idLabel ${label} → an event_id no other label has`,
            ).not.toContain(canonical);
            scope.set(label, canonical);
          }
        }
      }
      // I5: a heartbeat carrying tool_name came from a javi tool call step.
      if (record.type === 'heartbeat' && record.attributes?.tool_name !== undefined) {
        expect(isJaviToolCall(platform, stdin), `${where} I5 tool_name heartbeat source`).toBe(
          true,
        );
      }
    };

    const marker = `${markerKey}=${markerValue}`;
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

      // --- Fixed environment → Project: three inits, none with --self-report (G11). ---
      for (const argv of [
        ['init', '--project', PROJECT, '--endpoint', stub.endpoint],
        ['init', '--project', PROJECT, '--platform', 'codex-cli', '--endpoint', stub.endpoint],
        ['init', '--project', PROJECT, '--platform', 'gemini-cli', '--endpoint', stub.endpoint],
      ]) {
        const code = await main(argv, io);
        if (code !== 0) blocked(`javi ${argv.join(' ')} exited ${code}: ${lines.join(' | ')}`);
      }
      await settle();
      // The setup must really be "without --self-report": no MCP registration anywhere.
      const registered = [
        (await readIfPresent(join(project, '.mcp.json'))) !== null && '.mcp.json',
        ((await readIfPresent(join(project, '.codex', 'config.toml'))) ?? '').includes(
          'mcp_servers',
        ) && '.codex/config.toml',
        ((await readIfPresent(join(project, '.gemini', 'settings.json'))) ?? '').includes(
          'mcpServers',
        ) && '.gemini/settings.json',
      ].filter(Boolean);
      if (registered.length) blocked(`self-report registered by init: ${registered.join(', ')}`);

      // Collector-layer entries (README "Invocation and observation").
      const claude = JSON.parse(
        await readFile(join(project, '.claude', 'settings.local.json'), 'utf8'),
      ) as {
        hooks?: Record<string, Array<{ hooks?: Array<{ command?: string; args?: string[] }> }>>;
      };
      const claudeEntries = new Map(
        Object.values(claude.hooks ?? {})
          .flat()
          .flatMap((g) => g.hooks ?? [])
          .filter((h) => Array.isArray(h.args) && h.args.includes('javi-collector'))
          .map((h) => [JSON.stringify([h.command, h.args]), h] as const),
      );
      if (claudeEntries.size !== 1) blocked(`${claudeEntries.size} Claude Code javi entries`);
      const entry = [...claudeEntries.values()][0]!;
      hookArgv['claude-code'] = { file: entry.command!, args: entry.args! };

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
      if (!codexCommands.get('SessionStart')) blocked('no javi SessionStart handler for Codex');

      const gemini = JSON.parse(
        await readFile(join(project, '.gemini', 'settings.json'), 'utf8'),
      ) as {
        hooks?: Record<string, Array<{ hooks?: Array<{ name?: string; command?: string }> }>>;
      };
      const geminiCommands = new Set(
        Object.values(gemini.hooks ?? {})
          .flat()
          .flatMap((g) => g.hooks ?? [])
          .filter((h) => h.name === 'javi-collector' && typeof h.command === 'string')
          .map((h) => h.command!),
      );
      if (geminiCommands.size !== 1) blocked(`${geminiCommands.size} Gemini javi commands`);
      hookArgv['gemini-cli'] = { bash: [...geminiCommands][0]! };

      // Setup records (x.javi.collector.installed): invariants and scans, then marked seen.
      const setup = await observe();
      for (const e of setup) invariants(e, `${vector.id} setup`, 'setup');
      await scan(`${vector.id} setup`, setup);

      for (const [i, step] of vector.steps.entries()) {
        const where = `${vector.id} step ${i + 1} (${step.platform} ${step.note})`;
        const name = step.stdin.hook_event_name;
        const argv =
          step.platform === 'codex-cli'
            ? {
                sh:
                  (typeof name === 'string' && codexCommands.get(name)) ||
                  codexCommands.get('SessionStart')!,
              }
            : hookArgv[step.platform]!;
        const env: NodeJS.ProcessEnv = { ...childEnv };
        if (step.platform === 'claude-code') env.CLAUDE_PROJECT_DIR = project;
        if (step.platform === 'gemini-cli') {
          env.GEMINI_PROJECT_DIR = project;
          env.GEMINI_CWD = project;
        }
        const result = await runProcess(argv, Buffer.from(JSON.stringify(step.stdin), 'utf8'), {
          cwd: project,
          env,
        });
        expect(result.timedOut, `${where}: hook still running after 10 s`).toBe(false);
        expect(result.code, `${where} I8 exit code (stderr: ${result.stderr})`).toBe(0);
        expect(result.stdout.length, `${where} I8 stdout bytes: ${result.stdout}`).toBe(0);
        if (!(await waitForQuiescence(marker))) {
          return blocked(`${where}: a javi process did not finish within 15 s (cannot observe)`);
        }
        const fresh = await observe();
        for (const e of fresh) invariants(e, where, step.platform);
        await scan(where, fresh);
        const records = fresh.filter((e) => !e.type.startsWith('x.'));
        expect(records.length, `${where} I4 at most one record per step`).toBeLessThanOrEqual(1);
        advanceSequences(records, where);
        compare(step.platform, step.stdin, records, step.expect.record, where);
      }
      outcomes.set(file, 'PASS (NOT RUN: mapper layer (optional))');
    } finally {
      if (!(await waitForQuiescence(marker))) {
        for (const pid of (await markedProcesses(marker)) ?? []) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // already gone
          }
        }
      }
      await settle();
      vi.useRealTimers();
    }
  });
});
