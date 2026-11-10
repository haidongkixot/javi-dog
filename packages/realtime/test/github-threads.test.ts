import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createEventRepository, type NewEvent } from '@javis-dog/event-store';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createDashboardReader,
  GITHUB_NO_RESULT_AFTER_MS,
  GITHUB_PRODUCER_PREFIX,
  GITHUB_TERMINAL_TYPES,
  githubNoResult,
  type DashboardSnapshot,
  type ThreadState,
} from '../src/index.ts';
import { ago, freshDb, HOUR, MIN, SEC, seeder, type Scope } from './helpers.ts';

// TEST_PLAN §S5g rows "Dashboard: GitHub threads labelled with their source…" and "D0: GitHub
// threads end on a terminal event…" (ADR-0019 decision 6, D0 M1, M2), reader layer on PGlite
// with the real migrations.
//
// GitHub events are stored the way the bridge stores them: the JGR event JD-M10 maps (no
// `status`, no `agent_ref`, L0, `producer_id` `gh-app_<installation>`, `thread_ref` `gh_<32 hex>`)
// becomes one events row exactly as ingest builds rows (attributes as sent, nothing else). The
// event shapes come from the QA vectors in docs/jgr/conformance/github/M*.json ("expect.events"),
// the independent oracle, never from the bridge implementation.

const DIR = fileURLToPath(new URL('../../../docs/jgr/conformance/github/', import.meta.url));
/** The vectors' clock. */
const NOW = new Date('2026-11-01T12:00:00.000Z');

interface VectorEvent {
  producer_id: string;
  thread_ref: string;
  sequence: number;
  type: string;
  occurred_at: string;
  privacy_class?: 'L0' | 'L1' | 'L2';
  status?: string;
}
type VectorAttributes = Record<string, unknown>;
interface Expected {
  event: VectorEvent;
  attributes?: VectorAttributes;
}

/** Every expected event of a vector, in step order. */
const vectorEvents = (file: string): Expected[] => {
  const v = JSON.parse(readFileSync(`${DIR}${file}`, 'utf8')) as {
    steps: { expect?: { events?: Expected[] | null } }[];
  };
  return v.steps.flatMap((s) => s.expect?.events ?? []);
};

/** `{ optional, equals }` attribute specs become their value (the bridge sends `ci.<conclusion>`). */
const attributesOf = (a: VectorAttributes | undefined): Record<string, unknown> | null => {
  if (!a) return null;
  return Object.fromEntries(
    Object.entries(a).map(([k, v]) =>
      typeof v === 'object' && v !== null && 'equals' in v ? [k, v.equals] : [k, v],
    ),
  );
};

let ctx: Awaited<ReturnType<typeof freshDb>>;
let seed: ReturnType<typeof seeder>;
let reader: ReturnType<typeof createDashboardReader>;
let store: ReturnType<typeof createEventRepository>;

beforeAll(async () => {
  ctx = await freshDb();
  seed = seeder(ctx.db);
  reader = createDashboardReader(ctx.db);
  store = createEventRepository(ctx.db);
});
beforeEach(async () => {
  await ctx.client.exec('truncate workspaces, ingest_rate_windows cascade');
});

const oneProject = async () => {
  const ws = await seed.workspace('GitHub team');
  return seed.project(ws, 'Web App', 'web-app');
};

/** A bridge row: the mapped JGR event as ingest would store it, received at `receivedAt`. */
const bridgeRow = (
  p: Scope,
  e: VectorEvent,
  attributes: Record<string, unknown> | null,
  receivedAt: Date,
): NewEvent => ({
  ...p,
  producerId: e.producer_id,
  eventId: randomUUID(),
  threadRef: e.thread_ref,
  agentRef: null,
  sequence: e.sequence,
  type: e.type,
  status: e.status ?? null,
  privacyClass: e.privacy_class ?? 'L0',
  occurredAt: new Date(e.occurred_at),
  receivedAt,
  usageDelta: null,
  attributes,
  encrypted: null,
});

/** Stores a vector's events; each is received at its own `occurred_at` unless `at` says otherwise. */
const storeVector = async (p: Scope, file: string, at?: (e: VectorEvent, i: number) => Date) => {
  const rows = vectorEvents(file).map((x, i) =>
    bridgeRow(
      p,
      x.event,
      attributesOf(x.attributes),
      at?.(x.event, i) ?? new Date(x.event.occurred_at),
    ),
  );
  expect(rows.length, `${file} has expected events`).toBeGreaterThan(0);
  for (const row of rows) expect(await store.insertEvents([row])).toBe(1);
  return rows;
};

/** A run-thread event shaped like the vectors (for times the vectors do not cover). */
const runEvent = (
  p: Scope,
  threadRef: string,
  sequence: number,
  type: string,
  receivedAt: Date,
  extra: Partial<NewEvent> = {},
): NewEvent => ({
  ...bridgeRow(
    p,
    {
      producer_id: 'gh-app_1001',
      thread_ref: threadRef,
      sequence,
      type,
      occurred_at: receivedAt.toISOString(),
    },
    { tool_name: 'github-actions', task_kind: 'ci.workflow', attempt: 1 },
    receivedAt,
  ),
  ...extra,
});

const prEvent = (p: Scope, threadRef: string, sequence: number, type: string, at: Date) =>
  bridgeRow(
    p,
    {
      producer_id: 'gh-app_1001',
      thread_ref: threadRef,
      sequence,
      type,
      occurred_at: at.toISOString(),
    },
    { task_kind: 'pr' },
    at,
  );

const put = async (...rows: NewEvent[]) => {
  for (const row of rows) expect(await store.insertEvents([row])).toBe(1);
};

const snap = (p: Scope): Promise<DashboardSnapshot> => reader.snapshot(p.workspaceId, { now: NOW });

const threadOf = (s: DashboardSnapshot, ref: string): ThreadState => {
  const t = s.threads.find((x) => x.threadRef === ref);
  if (!t) throw new Error(`thread ${ref} missing`);
  return t;
};

const refsOf = (file: string) => [...new Set(vectorEvents(file).map((x) => x.event.thread_ref))];

describe('GitHub threads: source and no status (ADR-0019 decision 6, D0 M1, M2)', () => {
  it('marks a bridge thread as github with kind ci, no status, no attention and no agent tasks', async () => {
    const p = await oneProject();
    await storeVector(p, 'M01-workflow-run-lifecycle-attempt-1.json');
    const [ref] = refsOf('M01-workflow-run-lifecycle-attempt-1.json');
    const s = await snap(p);
    expect(s.threads).toHaveLength(1);
    expect(threadOf(s, ref!)).toMatchObject({
      source: 'github',
      githubKind: 'ci',
      status: null,
      statusSource: 'collector',
      statusReason: null,
      lastType: 'task.completed',
      freshness: 'ended',
      attention: false,
      needsAttention: false,
      agents: 0,
      tasksCompleted: 0,
      identity: null,
    });
  });

  it('takes the source from the reserved producer prefix only', async () => {
    expect(GITHUB_PRODUCER_PREFIX).toBe('gh-app_');
    const p = await oneProject();
    // Rows that older data or a forged producer could hold: a `gh_` ref from an ordinary
    // producer, and a `github-actions` tool name from an agent. Neither is GitHub.
    await put(
      runEvent(p, 'gh_00000000000000000000000000000001', 0, 'task.started', ago(NOW, 30 * SEC), {
        producerId: 'prod_laptop',
      }),
      runEvent(p, 'cc_agent_tool', 0, 'task.started', ago(NOW, 20 * SEC), {
        producerId: 'prod_laptop',
      }),
      runEvent(p, 'gh_00000000000000000000000000000002', 0, 'task.started', ago(NOW, 10 * SEC)),
    );
    const s = await snap(p);
    expect(threadOf(s, 'gh_00000000000000000000000000000001').source).toBe('agent');
    expect(threadOf(s, 'gh_00000000000000000000000000000001').githubKind).toBeNull();
    expect(threadOf(s, 'cc_agent_tool').source).toBe('agent');
    expect(threadOf(s, 'gh_00000000000000000000000000000002').source).toBe('github');
  });

  it('never shows a status on a GitHub thread, even if a row carried one', async () => {
    const p = await oneProject();
    const ref = 'gh_00000000000000000000000000000003';
    await put(
      runEvent(p, ref, 0, 'task.started', ago(NOW, 40 * SEC), { status: 'working' }),
      runEvent(p, ref, 1, 'task.started', ago(NOW, 30 * SEC), { status: 'blocked' }),
    );
    const s = await snap(p);
    expect(threadOf(s, ref)).toMatchObject({
      source: 'github',
      status: null,
      attention: false,
      needsAttention: false,
      freshness: 'fresh',
    });
    expect(s.overview.agentsWorking.value).toBe(0);
  });

  it('labels PR threads pr (draft or not) and CI results ci', async () => {
    const p = await oneProject();
    await storeVector(p, 'M16-pull-request-converted-to-draft.json');
    await storeVector(p, 'M14-check-suite-other-conclusions.json');
    const s = await snap(p);
    for (const ref of refsOf('M16-pull-request-converted-to-draft.json')) {
      expect(threadOf(s, ref)).toMatchObject({ source: 'github', githubKind: 'pr' });
    }
    for (const ref of refsOf('M14-check-suite-other-conclusions.json')) {
      expect(threadOf(s, ref)).toMatchObject({ source: 'github', githubKind: 'ci' });
    }
  });
});

describe('GitHub threads: ended on a terminal event (D0 M1)', () => {
  it('lists exactly the six terminal types', () => {
    expect([...GITHUB_TERMINAL_TYPES].sort()).toEqual(
      [
        'task.completed',
        'task.failed',
        'x.github.ci.cancelled',
        'x.github.ci.skipped',
        'x.github.pr.closed',
        'x.github.pr.merged',
      ].sort(),
    );
  });

  it('ends runs and suites on completed, failed, cancelled and skipped; attention stays open', async () => {
    const p = await oneProject();
    const files = [
      'M02-workflow-run-completed-failure.json',
      'M05-workflow-run-completed-cancelled.json',
      'M06-workflow-run-completed-skipped.json',
      'M07-workflow-run-completed-neutral.json',
      'M08-workflow-run-completed-action-required.json',
      'M11-check-suite-completed-listed-app.json',
      'M14-check-suite-other-conclusions.json',
    ];
    for (const f of files) await storeVector(p, f);
    const s = await snap(p);
    const all = files.flatMap((f) => vectorEvents(f));
    expect(all.length).toBeGreaterThanOrEqual(12);
    for (const { event } of all) {
      const t = threadOf(s, event.thread_ref);
      expect(t.lastType).toBe(event.type);
      // Every vector event is minutes old at NOW: an open thread reads stale, never fresh.
      expect(t.freshness, `${event.type} ${event.thread_ref}`).toBe(
        event.type === 'x.github.ci.attention' ? 'stale' : 'ended',
      );
      expect(t.status).toBeNull();
      expect(t.needsAttention).toBe(false);
    }
  });

  it('ends a PR on merge or close and reopens it on a later opened event', async () => {
    const p = await oneProject();
    const file = 'M15-pull-request-lifecycle.json';
    const events = vectorEvents(file);
    const [ref] = refsOf(file);
    // opened, updated, ready, closed: ended.
    await put(
      ...events
        .slice(0, 4)
        .map((x) =>
          bridgeRow(p, x.event, attributesOf(x.attributes), new Date(x.event.occurred_at)),
        ),
    );
    let t = threadOf(await snap(p), ref!);
    expect(t).toMatchObject({
      lastType: 'x.github.pr.closed',
      freshness: 'ended',
      githubKind: 'pr',
    });
    // reopened (`x.github.pr.opened`): open again, so freshness follows the usual rules.
    await put(
      bridgeRow(p, events[4]!.event, attributesOf(events[4]!.attributes), ago(NOW, 20 * SEC)),
    );
    t = threadOf(await snap(p), ref!);
    expect(t).toMatchObject({ lastType: 'x.github.pr.opened', freshness: 'fresh' });
    // merged: ended.
    await put(
      bridgeRow(p, events[5]!.event, attributesOf(events[5]!.attributes), ago(NOW, 10 * SEC)),
    );
    t = threadOf(await snap(p), ref!);
    expect(t).toMatchObject({ lastType: 'x.github.pr.merged', freshness: 'ended' });
  });

  it('orders a GitHub thread by sequence, so a late in_progress delivery does not reopen a run', async () => {
    const p = await oneProject();
    const file = 'M01-workflow-run-lifecycle-attempt-1.json';
    // Received: requested, completed, then in_progress (GitHub does not promise order).
    const received = [ago(NOW, 50 * SEC), ago(NOW, 40 * SEC), ago(NOW, 30 * SEC)];
    await storeVector(p, file, (e) => received[e.sequence === 2 ? 1 : e.sequence === 1 ? 2 : 0]!);
    const t = threadOf(await snap(p), refsOf(file)[0]!);
    expect(t).toMatchObject({ lastType: 'task.completed', freshness: 'ended' });
    expect(t.lastSignalAt).toBe(ago(NOW, 30 * SEC).toISOString());
  });

  it('keeps run_attempt 2 as its own thread, without assuming one thread per run id', async () => {
    const p = await oneProject();
    const file = 'M10-workflow-run-attempt-2-new-thread.json';
    await storeVector(p, file);
    const s = await snap(p);
    const refs = refsOf(file);
    expect(refs).toHaveLength(2);
    expect(s.threads.filter((t) => t.source === 'github')).toHaveLength(2);
    expect(threadOf(s, refs[0]!)).toMatchObject({ lastType: 'task.failed', freshness: 'ended' });
    expect(threadOf(s, refs[1]!)).toMatchObject({ lastType: 'task.completed', freshness: 'ended' });
    expect(s.github.ciFailed24h.value).toBe(1);
    expect(s.github.ciRunning.value).toBe(0);
  });
});

describe('GitHub threads: counters (D0 M1)', () => {
  it('leaves GitHub out of agents working and agent tasks, and counts CI and PRs on their own', async () => {
    const p = await oneProject();
    // An agent: working, fresh, one completed task.
    await seed.event(p, {
      threadRef: 'cc_agent',
      type: 'heartbeat',
      status: 'working',
      agentRef: 'agent_1',
      receivedAt: ago(NOW, 2 * MIN),
    });
    await seed.event(p, {
      threadRef: 'cc_agent',
      type: 'task.completed',
      receivedAt: ago(NOW, 90 * SEC),
    });
    // GitHub: a run in progress (fresh), a run in progress (stale), a run that passed, a run
    // that failed, a suite that failed, an open PR, a merged PR.
    const r = (n: number) => `gh_${n.toString(16).padStart(32, '0')}`;
    await put(
      runEvent(p, r(1), 1, 'task.started', ago(NOW, 30 * SEC)),
      runEvent(p, r(2), 1, 'task.started', ago(NOW, 20 * MIN)),
      runEvent(p, r(3), 1, 'task.started', ago(NOW, 10 * MIN)),
      runEvent(p, r(3), 2, 'task.completed', ago(NOW, 5 * MIN)),
      runEvent(p, r(4), 2, 'task.failed', ago(NOW, 4 * MIN)),
      runEvent(p, r(5), 1793534200, 'task.failed', ago(NOW, 3 * MIN), {
        attributes: { tool_name: 'vercel', task_kind: 'ci.check_suite' },
      }),
      prEvent(p, r(6), 14348272800, 'x.github.pr.opened', ago(NOW, 50 * SEC)),
      prEvent(p, r(7), 14348272800, 'x.github.pr.opened', ago(NOW, 40 * MIN)),
      prEvent(p, r(7), 14348272805, 'x.github.pr.merged', ago(NOW, 30 * MIN)),
    );
    const s = await snap(p);
    expect(s.threads.filter((t) => t.source === 'agent').map((t) => t.threadRef)).toEqual([
      'cc_agent',
    ]);
    expect(s.overview.agentsWorking).toEqual({
      value: 1,
      lastSignalAt: ago(NOW, 90 * SEC).toISOString(),
    });
    // Only the agent's task counts; GitHub's task.completed results never do.
    expect(s.overview.tasksCompleted24h).toEqual({
      value: 1,
      lastSignalAt: ago(NOW, 90 * SEC).toISOString(),
    });
    expect(s.github).toEqual({
      ciRunning: { value: 2, lastSignalAt: ago(NOW, 30 * SEC).toISOString() },
      ciNoResult: { value: 0, lastSignalAt: null },
      ciFailed24h: { value: 2, lastSignalAt: ago(NOW, 3 * MIN).toISOString() },
      prsOpen: { value: 1, lastSignalAt: ago(NOW, 50 * SEC).toISOString() },
    });
    // A GitHub delivery is a verified project signal: the project is active, its fresh-thread
    // count includes the fresh run and PR, and none of them needs attention.
    expect(s.overview.activeProjects.value).toBe(1);
    expect(s.projects[0]).toMatchObject({ freshThreads: 3, attentionThreads: 0 });
    // The activity feed keeps its shape; GitHub items carry the app as tool and no status.
    const gh = s.activity.filter((a) => a.threadRef.startsWith('gh_'));
    expect(gh.length).toBeGreaterThan(0);
    for (const a of gh) expect(a).toMatchObject({ status: null, statusSource: 'collector' });
  });

  it('counts nothing for GitHub when no GitHub thread is in the window', async () => {
    const p = await oneProject();
    await seed.event(p, { threadRef: 'cc_a', type: 'task.completed', receivedAt: ago(NOW, MIN) });
    const s = await snap(p);
    expect(s.github).toEqual({
      ciRunning: { value: 0, lastSignalAt: null },
      ciNoResult: { value: 0, lastSignalAt: null },
      ciFailed24h: { value: 0, lastSignalAt: null },
      prsOpen: { value: 0, lastSignalAt: null },
    });
  });
});

// TEST_PLAN §S5h row 1 (ADR-0019 Changes "S5h decisions"): a CI thread whose newest event (by
// sequence) is `task.started` and whose last signal is more than 6 h old is "No result
// received", not running. The boundary is measured against the snapshot clock.
describe('GitHub CI threads: no result received after 6 h (S5h)', () => {
  const r = (n: number) => `gh_${(0x500 + n).toString(16).padStart(32, '0')}`;

  it('uses a 6 h threshold', () => {
    expect(GITHUB_NO_RESULT_AFTER_MS).toBe(6 * HOUR);
  });

  it('counts a run as running up to 6 h after its last delivery and as no result after that', async () => {
    const p = await oneProject();
    await put(
      runEvent(p, r(1), 1, 'task.started', ago(NOW, 6 * HOUR - SEC)),
      runEvent(p, r(2), 1, 'task.started', ago(NOW, 6 * HOUR)),
      runEvent(p, r(3), 1, 'task.started', ago(NOW, 6 * HOUR + SEC)),
      // Requested, then in progress: the newest delivery is what ages.
      runEvent(p, r(4), 1, 'task.started', ago(NOW, 9 * HOUR)),
      runEvent(p, r(4), 2, 'task.started', ago(NOW, 7 * HOUR)),
    );
    const s = await snap(p);
    expect(s.github.ciRunning).toEqual({
      value: 2,
      lastSignalAt: ago(NOW, 6 * HOUR - SEC).toISOString(),
    });
    expect(s.github.ciNoResult).toEqual({
      value: 2,
      lastSignalAt: ago(NOW, 6 * HOUR + SEC).toISOString(),
    });
    expect(s.github.ciFailed24h).toEqual({ value: 0, lastSignalAt: null });
    // The thread itself keeps what GitHub sent: no status, no failure, never ended.
    for (const ref of [r(3), r(4)]) {
      expect(threadOf(s, ref)).toMatchObject({
        lastType: 'task.started',
        status: null,
        freshness: 'stale',
        needsAttention: false,
      });
      expect(githubNoResult(threadOf(s, ref), s.generatedAt)).toBe(true);
    }
    for (const ref of [r(1), r(2)]) {
      expect(githubNoResult(threadOf(s, ref), s.generatedAt)).toBe(false);
    }
  });

  it('ends the thread normally when a result arrives after the threshold', async () => {
    const p = await oneProject();
    await put(
      runEvent(p, r(5), 1, 'task.started', ago(NOW, 8 * HOUR)),
      runEvent(p, r(5), 2, 'task.completed', ago(NOW, MIN)),
      runEvent(p, r(6), 1, 'task.started', ago(NOW, 8 * HOUR)),
      runEvent(p, r(6), 2, 'task.failed', ago(NOW, 2 * MIN)),
      // A late in_progress delivery with a lower sequence does not reopen it (D0 M3).
      runEvent(p, r(5), 0, 'task.started', ago(NOW, 30 * SEC)),
    );
    const s = await snap(p);
    expect(threadOf(s, r(5))).toMatchObject({ lastType: 'task.completed', freshness: 'ended' });
    expect(threadOf(s, r(6))).toMatchObject({ lastType: 'task.failed', freshness: 'ended' });
    for (const ref of [r(5), r(6)]) {
      expect(githubNoResult(threadOf(s, ref), s.generatedAt)).toBe(false);
    }
    expect(s.github.ciRunning).toEqual({ value: 0, lastSignalAt: null });
    expect(s.github.ciNoResult).toEqual({ value: 0, lastSignalAt: null });
    expect(s.github.ciFailed24h).toEqual({
      value: 1,
      lastSignalAt: ago(NOW, 2 * MIN).toISOString(),
    });
  });

  it('applies to CI only: an open PR older than 6 h stays open', async () => {
    const p = await oneProject();
    await put(prEvent(p, r(7), 14348272800, 'x.github.pr.opened', ago(NOW, 7 * HOUR)));
    const s = await snap(p);
    expect(s.github.prsOpen.value).toBe(1);
    expect(s.github.ciNoResult.value).toBe(0);
  });

  it('measures against the database clock when no clock is pinned', async () => {
    const p = await oneProject();
    const dbNow = new Date(
      String(((await ctx.client.query('select now() as n')).rows[0] as { n: unknown }).n),
    );
    await put(
      runEvent(p, r(8), 1, 'task.started', ago(dbNow, 6 * HOUR + MIN)),
      runEvent(p, r(9), 1, 'task.started', ago(dbNow, 6 * HOUR - MIN)),
    );
    const s = await reader.snapshot(p.workspaceId);
    expect(s.github.ciNoResult.value).toBe(1);
    expect(s.github.ciRunning.value).toBe(1);
  });
});

describe('GitHub events never touch an agent status or self-report (ADR-0019 decision 6)', () => {
  const SELF = 'mcp__javi__report_status';

  it('keeps an agent self-report while GitHub events arrive in the same project', async () => {
    const p = await oneProject();
    await seed.event(p, {
      threadRef: 'cc_agent',
      type: 'heartbeat',
      status: 'blocked',
      attributes: { tool_name: SELF, error_code: 'blocked.ci_failing' },
      receivedAt: ago(NOW, 2 * MIN),
    });
    const before = threadOf(await snap(p), 'cc_agent');
    await storeVector(p, 'M01-workflow-run-lifecycle-attempt-1.json', (_, i) =>
      ago(NOW, (60 - i * 10) * SEC),
    );
    await storeVector(p, 'M15-pull-request-lifecycle.json', (_, i) => ago(NOW, (30 - i) * SEC));
    const after = threadOf(await snap(p), 'cc_agent');
    expect(after).toEqual(before);
    expect(after).toMatchObject({
      source: 'agent',
      status: 'blocked',
      statusSource: 'agent',
      statusReason: 'ci_failing',
      needsAttention: true,
    });
  });

  it('ignores a gh-app_ row inside an agent thread for status, self-report and tasks', async () => {
    const p = await oneProject();
    await seed.event(p, {
      threadRef: 'cc_agent',
      type: 'heartbeat',
      status: 'waiting',
      attributes: { tool_name: SELF, error_code: 'waiting.needs_input' },
      receivedAt: ago(NOW, 2 * MIN),
    });
    // Data ingest would refuse today (D0 M2): bridge-shaped rows in an agent's thread, one of
    // them with a status. A `task.*` would clear a self-report if it were an agent's.
    await put(
      runEvent(p, 'cc_agent', 900, 'task.completed', ago(NOW, 60 * SEC), { status: 'completed' }),
      runEvent(p, 'cc_agent', 901, 'task.started', ago(NOW, 30 * SEC), { status: 'working' }),
    );
    const s = await snap(p);
    expect(threadOf(s, 'cc_agent')).toMatchObject({
      source: 'agent',
      githubKind: null,
      status: 'waiting',
      statusSource: 'agent',
      statusReason: 'needs_input',
      needsAttention: true,
      tasksCompleted: 0,
    });
    expect(s.overview.tasksCompleted24h.value).toBe(0);
    expect(s.overview.agentsWorking.value).toBe(0);
  });

  it('keeps a collector status when GitHub rows with statuses share the thread', async () => {
    const p = await oneProject();
    await seed.event(p, {
      threadRef: 'cc_agent',
      type: 'heartbeat',
      status: 'idle',
      receivedAt: ago(NOW, 2 * MIN),
    });
    await put(runEvent(p, 'cc_agent', 902, 'task.failed', ago(NOW, MIN), { status: 'failed' }));
    expect(threadOf(await snap(p), 'cc_agent')).toMatchObject({
      status: 'idle',
      statusSource: 'collector',
    });
  });
});
