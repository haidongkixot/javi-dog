import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { schema } from '@javis-dog/event-store';
import { getMigrationsFolder } from '@javis-dog/event-store/migrations';
import { createIngestDeps, createIngestHandler } from '@javis-dog/ingest';
import { createProjectRepository } from '@javis-dog/projects';
import { createDashboardReader, type ThreadState } from '@javis-dog/realtime';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createState, main, type CollectorState, type Io, type Platform } from '../src/index.ts';

// T6 (S5d) end to end, TEST_PLAN §S5d row "End to end" (ADR-0017 Verification): a real hook
// path (`javi hook` through the CLI entry) → file spool → `javi flush` → the real JD-M05 ingest
// handler on PGlite → the real JD-M07 dashboard reader. Nothing is mocked; the background
// flush spawner is a spy (as in self-report-hook.test.ts), and the flush is then run
// explicitly, so the spy shows WHICH hooks asked for an immediate flush (ADR-0017 §3 "Prompt
// delivery") and the reader shows what reached the server.
//
// Per platform (Claude Code, Codex CLI): UserPromptSubmit → (control: an ordinary PreToolUse
// right after a flush, which must NOT flush at once) → PostToolUse of javi's `report_status`
// {status: 'blocked', reason: 'missing_credentials'} → Stop → reader: blocked, reported by the
// agent, reason missing_credentials, needs attention → a new UserPromptSubmit → reader:
// working, from the collector.

const SENTINEL = 'SENTINEL_S5D_E2E_9f3a';
const PROJECT = 'web-app';

let client: PGlite;
let workspaceId: string;
let token: string;
let home: string;
let project: string;
let state: CollectorState;
let fetchToHandler: typeof fetch;
let reader: ReturnType<typeof createDashboardReader>;
/** Projects the spy saw a `spawnFlush` for, in call order. */
const flushRequests: string[] = [];

beforeAll(async () => {
  client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: getMigrationsFolder() });
  const projects = createProjectRepository(db);
  workspaceId = (await projects.createWorkspace({ name: 'Self-report team' })).id;
  const p = await projects.createProject(workspaceId, {
    name: 'Web App',
    platforms: ['claude-code', 'codex-cli'],
  });
  token = (await projects.issueToken(workspaceId, p.id, 'laptop')).token;
  const handler = createIngestHandler(createIngestDeps(db));
  fetchToHandler = async (url, init) => handler(new Request(url as string, init));
  reader = createDashboardReader(db);
  home = await mkdtemp(join(tmpdir(), 'javi-sr-e2e-'));
  project = join(home, PROJECT);
  await mkdir(project, { recursive: true });
  await mkdir(join(home, '.codex'), { recursive: true });
  state = createState(join(home, '.javi'));
});
afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

const io = (stdin = ''): Io => ({
  env: {
    HOME: home,
    JAVI_HOME: join(home, '.javi'),
    JAVI_CLAUDE_HOME: home,
    CODEX_HOME: join(home, '.codex'),
    GEMINI_CLI_HOME: home,
    JAVI_INGEST_TOKEN: token,
  },
  cwd: project,
  readStdin: async () => stdin,
  out: () => {},
  err: () => {},
  spawnFlush: (ref) => void flushRequests.push(ref),
  spawnReceiver: () => {},
  fetch: fetchToHandler,
});

/** One hook invocation through the CLI entry, as the agent's hook entry runs it. */
const hook = async (platform: Platform, payload: Record<string, unknown>) => {
  const before = flushRequests.length;
  const argv = [
    'hook',
    '--project',
    PROJECT,
    ...(platform === 'claude-code' ? [] : ['--platform', platform]),
  ];
  expect(await main(argv, io(JSON.stringify(payload)))).toBe(0);
  return { flushedAtOnce: flushRequests.length > before };
};

/** `javi flush` into the real ingest handler; every spooled event must be accepted. */
const flush = async () => {
  expect(await main(['flush', '--project', PROJECT, '--quiet'], io())).toBe(0);
  const last = await state.lastFlush(PROJECT);
  expect(last).toMatchObject({ status: 'ok', rejected: 0, remaining: 0 });
};

/** The JD-M07 reader's state of the one thread of this platform. */
const thread = async (platform: Platform): Promise<ThreadState> => {
  const snapshot = await reader.snapshot(workspaceId, { now: new Date() });
  const prefix = platform === 'codex-cli' ? 'cx_' : 'cc_';
  const own = snapshot.threads.filter((t) => t.threadRef.startsWith(prefix));
  expect(own, `one ${prefix} thread`).toHaveLength(1);
  return own[0]!;
};

const payloads = (platform: Platform) => {
  const session = platform === 'codex-cli' ? 'cx-e2e-session' : 'cc-e2e-session';
  const base = {
    session_id: session,
    transcript_path: `/home/dev/${SENTINEL}/t.jsonl`,
    cwd: `/home/dev/${SENTINEL}/web-app`,
    ...(platform === 'codex-cli' && { model: 'gpt-5.5-codex', turn_id: `${SENTINEL}_turn` }),
  };
  return {
    session,
    prompt: { ...base, hook_event_name: 'UserPromptSubmit', prompt: `${SENTINEL} please deploy` },
    ordinaryPre: {
      ...base,
      hook_event_name: 'PreToolUse',
      tool_name: platform === 'codex-cli' ? 'shell' : 'Bash',
      tool_input: { command: `echo ${SENTINEL}` },
      tool_use_id: `${SENTINEL}_call_0`,
    },
    report: {
      ...base,
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__javi__report_status',
      tool_input: { status: 'blocked', reason: 'missing_credentials' },
      tool_use_id: `${SENTINEL}_call_1`,
      tool_response: [{ type: 'text', text: `Noted. ${SENTINEL}` }],
    },
    stop: { ...base, hook_event_name: 'Stop', stop_hook_active: false },
  };
};

describe('agent self-report end to end: hook → spool → ingest (PGlite) → JD-M07 reader', () => {
  it('javi init for Claude Code and Codex CLI (no --self-report: mapping does not need it)', async () => {
    const initArgs = ['init', '--project', PROJECT, '--endpoint', 'http://localhost/api/v1/events'];
    expect(await main(initArgs, io())).toBe(0);
    expect(await main([...initArgs, '--platform', 'codex-cli'], io())).toBe(0);
  });

  it.each<Platform>(['claude-code', 'codex-cli'])(
    '%s: agent-reported blocked survives Stop, needs attention; a new prompt clears it',
    async (platform) => {
      const p = payloads(platform);

      await hook(platform, p.prompt);
      await flush();
      expect(await thread(platform)).toMatchObject({
        status: 'working',
        statusSource: 'collector',
        statusReason: null,
        needsAttention: false,
      });

      // Control: right after a flush an ordinary event waits for the backlog/interval rule.
      expect((await hook(platform, p.ordinaryPre)).flushedAtOnce, 'ordinary PreToolUse').toBe(
        false,
      );
      // ADR-0017 §3 Prompt delivery: a self-reported status other than `working` at once …
      expect((await hook(platform, p.report)).flushedAtOnce, 'self-report blocked').toBe(true);
      await flush();
      // … and the end-of-turn `heartbeat idle` (Stop) at once.
      expect((await hook(platform, p.stop)).flushedAtOnce, 'Stop').toBe(true);
      await flush();

      const blocked = await thread(platform);
      expect(blocked).toMatchObject({
        status: 'blocked',
        statusSource: 'agent',
        statusReason: 'missing_credentials',
        attention: true,
        needsAttention: true,
        freshness: 'fresh',
      });

      await hook(platform, { ...p.prompt, prompt: `${SENTINEL} creds added` });
      await flush();
      const resumed = await thread(platform);
      expect(resumed.threadRef).toBe(blocked.threadRef);
      expect(resumed).toMatchObject({
        status: 'working',
        statusSource: 'collector',
        statusReason: null,
        needsAttention: false,
      });

      // What the server stored for this thread, in order; no raw id or payload text.
      const { rows } = await client.query<{
        type: string;
        status: string | null;
        attributes: unknown;
      }>(
        'select type, status, attributes from events where thread_ref = $1 order by received_at, sequence',
        [blocked.threadRef],
      );
      expect(rows.map((r) => `${r.type}${r.status ? ` ${r.status}` : ''}`)).toEqual([
        'heartbeat working',
        'task.started',
        'heartbeat blocked',
        'heartbeat idle',
        'heartbeat working',
      ]);
      expect(rows[2]!.attributes).toMatchObject({
        tool_name: 'mcp__javi__report_status',
        error_code: 'blocked.missing_credentials',
      });
      const stored = JSON.stringify((await client.query('select * from events')).rows);
      for (const needle of [SENTINEL, p.session, '/home/dev']) {
        expect(stored).not.toContain(needle);
      }
    },
  );
});
