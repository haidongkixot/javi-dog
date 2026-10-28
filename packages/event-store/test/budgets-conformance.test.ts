import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ProjectRepositoryError } from '@javis-dog/projects';
import {
  createBudgetRepository,
  type BudgetAlertJob,
  type BudgetRepository,
  type BudgetStatus,
} from '@javis-dog/resilience';
import { describe, expect, it } from 'vitest';
import { freshDb } from './helpers.ts';

// JGR v0.1 budget conformance runner (ADR-0014, TEST_PLAN §S4c). Implements the runner rules of
// docs/jgr/conformance/budgets/README.md: one fresh PGlite database with the JD-M06 migrations
// (0000–0005) per vector, seeding straight into the store, every repository call pinned to the
// step clock (`now` option), partial comparison with the README tolerances, invariants I1–I7.
// A seeding error or an informative `*AtUtc` mismatch fails with a `BLOCKED` message (vector or
// setup defect), never as a FAIL of the implementation.

const vectorsDir = fileURLToPath(
  new URL('../../../docs/jgr/conformance/budgets/', import.meta.url),
);

// ---------------------------------------------------------------------------------------------
// Vector format (README "Vector file format", schema.json)

type WorkspaceKey = string;
type Threshold = 80 | 100;
type AlertStatus = 'pending' | 'sent' | 'failed' | 'covered';

interface UsageDelta {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  reasoning_tokens?: number;
  cost_usd?: number;
  model?: string;
  estimated?: boolean;
}

interface EventSeed {
  workspace: WorkspaceKey;
  project: string;
  thread_ref: string;
  type: string;
  status?: string;
  sequence: number;
  receivedOffsetMs: number;
  receivedAtUtc: string;
  occurredOffsetMs?: number;
  usage_delta?: UsageDelta;
}

interface AlertSeed {
  workspace: WorkspaceKey;
  project: string;
  month: string;
  threshold: Threshold;
  status: AlertStatus;
  attempts: number;
  claimedOffsetMs: number;
  claimedAtUtc: string;
  sentOffsetMs?: number;
  sentAtUtc?: string;
}

interface StatusExpect {
  limitUsd?: number | null;
  month?: string;
  spendUsd?: number;
  percentUsed?: number | null;
  forecastUsd?: number | null;
  reports?: number;
  estimatedReports?: number;
  alerted?: Threshold[];
}

interface ClaimExpect {
  threshold: Threshold;
  recipients: string[];
  projectSlug?: string;
  projectName?: string;
  status?: StatusExpect;
  acceptNull?: true;
}

interface ForeignProject {
  workspace: WorkspaceKey;
  slug: string;
}

type Step =
  | {
      op: 'status';
      workspace: WorkspaceKey;
      project?: string;
      foreignProject?: ForeignProject;
      atOffsetMs?: number;
      expect: StatusExpect | null;
    }
  | {
      op: 'claimAlert';
      workspace: WorkspaceKey;
      project: string;
      label?: string;
      parallel?: number;
      atOffsetMs?: number;
      expect: ClaimExpect | null;
    }
  | {
      op: 'markAlert';
      job: string;
      outcome: 'sent' | 'failed';
      atOffsetMs?: number;
      expect?: { ok: true };
    }
  | {
      op: 'setBudget';
      workspace: WorkspaceKey;
      project?: string;
      foreignProject?: ForeignProject;
      limitUsd: number | null;
      by?: string;
      atOffsetMs?: number;
      expect: { ok: true } | { ok: false; errorKind: 'invalid_limit' | 'not_found' };
    }
  | { op: 'insertEvents'; events: EventSeed[] }
  | {
      op: 'alertRows';
      workspace: WorkspaceKey;
      project: string;
      expect: {
        exact: boolean;
        rows: { month: string; threshold: Threshold; status: AlertStatus; attempts?: number }[];
      };
    };

interface Vector {
  description: string;
  contract: string;
  now: string;
  users: Record<string, { email: string; emailVerified: boolean }>;
  workspaces: Record<
    WorkspaceKey,
    {
      name: string;
      members: { user: string; role: 'owner' | 'admin' | 'member' }[];
      projects: { slug: string; name: string; budget?: { limitUsd: number } }[];
    }
  >;
  events: EventSeed[];
  alerts?: AlertSeed[];
  steps: Step[];
}

const vectorFiles = readdirSync(vectorsDir)
  .filter((f) => /^\d{2}-[a-z0-9-]+\.json$/.test(f))
  .sort();

const loadVector = (file: string) =>
  JSON.parse(readFileSync(`${vectorsDir}${file}`, 'utf8')) as Vector;

// ---------------------------------------------------------------------------------------------
// Helpers

class Blocked extends Error {
  constructor(message: string) {
    super(`BLOCKED (setup/vector defect): ${message}`);
  }
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const encode32 = (value: bigint, length: number) => {
  let out = '';
  let v = value;
  for (let i = 0; i < length; i += 1) {
    out = CROCKFORD[Number(v % 32n)] + out;
    v /= 32n;
  }
  return out;
};
/** Canonical ULID: 48-bit ms timestamp + an 80-bit per-vector counter (unique, deterministic). */
const ulid = (ms: number, counter: number) =>
  encode32(BigInt(ms), 10) + encode32(BigInt(counter), 16);

const DAY_MS = 24 * 60 * 60 * 1000;
const utcMonthStart = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
const utcMonthKey = (d: Date) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

/**
 * `|actual − expected| ≤ tol`, exactly as the README states — no extra slack (an earlier version
 * added a few ULPs, which hid a rounding defect in `percentUsed`; removed after the S4c review).
 */
const within = (actual: number, expected: number, tol: number) =>
  Math.abs(actual - expected) <= tol;

const show = (v: unknown) => JSON.stringify(v);

/** Set equality: order ignored, a duplicate in `actual` fails. */
const sameSet = <T>(actual: unknown, expected: T[]) =>
  Array.isArray(actual) &&
  new Set(actual).size === actual.length &&
  actual.length === expected.length &&
  expected.every((e) => actual.includes(e));

// ---------------------------------------------------------------------------------------------
// Runner

interface Ctx {
  db: Awaited<ReturnType<typeof freshDb>>;
  repo: BudgetRepository;
  now: number;
  vector: Vector;
  userIds: Map<string, string>;
  workspaceIds: Map<WorkspaceKey, string>;
  /** `${workspace}/${slug}` → project id. */
  projectIds: Map<string, string>;
  jobs: Map<string, BudgetAlertJob>;
  eventCounter: number;
  /** thread_ref → [received ms, sequence] of every seeded event (README sequence rule). */
  threads: Map<string, [number, number][]>;
  problems: string[];
  notes: string[];
}

const projectKey = (ws: WorkspaceKey, slug: string) => `${ws}/${slug}`;

const projectIdOf = (ctx: Ctx, ws: WorkspaceKey, slug: string) => {
  const id = ctx.projectIds.get(projectKey(ws, slug));
  if (!id) throw new Blocked(`unknown project ${ws}/${slug}`);
  return id;
};

const workspaceIdOf = (ctx: Ctx, ws: WorkspaceKey) => {
  const id = ctx.workspaceIds.get(ws);
  if (!id) throw new Blocked(`unknown workspace ${ws}`);
  return id;
};

const targetOf = (
  ctx: Ctx,
  step: { workspace: WorkspaceKey; project?: string; foreignProject?: ForeignProject },
) => {
  if (step.project !== undefined && step.foreignProject !== undefined) {
    throw new Blocked('step has both project and foreignProject');
  }
  if (step.foreignProject) {
    return projectIdOf(ctx, step.foreignProject.workspace, step.foreignProject.slug);
  }
  if (step.project === undefined) throw new Blocked('step has neither project nor foreignProject');
  return projectIdOf(ctx, step.workspace, step.project);
};

const checkInstant = (label: string, offsetMs: number, utc: string, now: number) => {
  if (!Number.isInteger(offsetMs)) throw new Blocked(`${label}: offset ${offsetMs} not an integer`);
  if (Date.parse(utc) !== now + offsetMs) {
    throw new Blocked(
      `${label}: ${utc} ≠ now + ${offsetMs} ms = ${new Date(now + offsetMs).toISOString()}`,
    );
  }
};

const insertEvents = async (ctx: Ctx, events: EventSeed[], where: string) => {
  // Validate the whole batch first (README events rules), then write.
  events.forEach((e, i) => {
    const label = `${where} event[${i}]`;
    checkInstant(label, e.receivedOffsetMs, e.receivedAtUtc, ctx.now);
    if (e.occurredOffsetMs !== undefined && e.occurredOffsetMs - e.receivedOffsetMs > 5 * 60_000) {
      throw new Blocked(`${label}: occurred_at more than 5 min after received_at (spec §10)`);
    }
    const seen = ctx.threads.get(e.thread_ref) ?? [];
    seen.push([e.receivedOffsetMs, e.sequence]);
    ctx.threads.set(e.thread_ref, seen);
  });
  for (const [ref, seen] of ctx.threads) {
    const ordered = [...seen].sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < ordered.length; i += 1) {
      if (ordered[i]![1] <= ordered[i - 1]![1]) {
        throw new Blocked(`${where}: sequence of thread_ref ${ref} does not increase strictly`);
      }
    }
  }

  const newest = new Map<string, number>();
  for (const e of events) {
    const projectId = projectIdOf(ctx, e.workspace, e.project);
    const receivedMs = ctx.now + e.receivedOffsetMs;
    const occurredMs = ctx.now + (e.occurredOffsetMs ?? e.receivedOffsetMs);
    ctx.eventCounter += 1;
    try {
      await ctx.db.client.query(
        `insert into events (project_id, workspace_id, producer_id, event_id, thread_ref, agent_ref,
                             sequence, type, status, privacy_class, occurred_at, received_at,
                             usage_delta, attributes, encrypted)
         values ($1, $2, 'prod_budgets_qa', $3, $4, null, $5, $6, $7, 'L0', $8, $9, $10::jsonb,
                 null, null)`,
        [
          projectId,
          workspaceIdOf(ctx, e.workspace),
          ulid(receivedMs, ctx.eventCounter),
          e.thread_ref,
          e.sequence,
          e.type,
          e.status ?? null,
          new Date(occurredMs).toISOString(),
          new Date(receivedMs).toISOString(),
          e.usage_delta === undefined ? null : JSON.stringify(e.usage_delta),
        ],
      );
    } catch (error) {
      throw new Blocked(`${where}: inserting event failed: ${(error as Error).message}`);
    }
    newest.set(projectId, Math.max(newest.get(projectId) ?? -Infinity, receivedMs));
  }
  // `last_signal_at` as ingest would leave it (not read by the contract).
  for (const [projectId, ms] of newest) {
    await ctx.db.client.query(
      `update projects set last_signal_at = greatest(coalesce(last_signal_at, $2::timestamptz),
                                                    $2::timestamptz)
        where id = $1`,
      [projectId, new Date(ms).toISOString()],
    );
  }
};

const seed = async (ctx: Ctx) => {
  const { vector: v, db } = ctx;
  const q = db.client.query.bind(db.client);
  try {
    // 1. users
    for (const [key, u] of Object.entries(v.users)) {
      const { rows } = await q<{ id: string }>(
        'insert into users (name, email, email_verified) values ($1, $2, $3) returning id',
        [key, u.email, u.emailVerified],
      );
      ctx.userIds.set(key, rows[0]!.id);
    }
    // 2–3. workspaces, members, projects, budgets
    for (const [wsKey, ws] of Object.entries(v.workspaces)) {
      const { rows } = await q<{ id: string }>(
        'insert into workspaces (name, slug) values ($1, $2) returning id',
        [ws.name, `budgets-qa-${wsKey.toLowerCase()}`],
      );
      const workspaceId = rows[0]!.id;
      ctx.workspaceIds.set(wsKey, workspaceId);
      for (const m of ws.members) {
        const userId = ctx.userIds.get(m.user);
        if (!userId) throw new Blocked(`workspace ${wsKey}: unknown member ${m.user}`);
        await q('insert into workspace_members (workspace_id, user_id, role) values ($1, $2, $3)', [
          workspaceId,
          userId,
          m.role,
        ]);
      }
      for (const p of ws.projects) {
        const { rows: pr } = await q<{ id: string }>(
          `insert into projects (workspace_id, name, slug, platforms, privacy_class)
           values ($1, $2, $3, '{claude-code}', 'L0') returning id`,
          [workspaceId, p.name, p.slug],
        );
        const projectId = pr[0]!.id;
        ctx.projectIds.set(projectKey(wsKey, p.slug), projectId);
        if (p.budget) {
          await q(
            `insert into project_budgets (project_id, workspace_id, monthly_limit_usd, updated_by)
             values ($1, $2, $3::numeric, null)`,
            [projectId, workspaceId, String(p.budget.limitUsd)],
          );
        }
      }
    }
    // 4. events (also sets last_signal_at to the newest seeded received_at)
    await insertEvents(ctx, v.events, 'events');
    // 5. alerts
    for (const [i, a] of (v.alerts ?? []).entries()) {
      checkInstant(`alerts[${i}].claimedAtUtc`, a.claimedOffsetMs, a.claimedAtUtc, ctx.now);
      if ((a.sentOffsetMs === undefined) !== (a.sentAtUtc === undefined)) {
        throw new Blocked(`alerts[${i}]: sentOffsetMs and sentAtUtc must come together`);
      }
      if (a.sentOffsetMs !== undefined) {
        checkInstant(`alerts[${i}].sentAtUtc`, a.sentOffsetMs, a.sentAtUtc!, ctx.now);
      }
      await q(
        `insert into budget_alerts (project_id, month, threshold, status, claimed_at, sent_at,
                                    attempts)
         values ($1, $2::date, $3, $4, $5, $6, $7)`,
        [
          projectIdOf(ctx, a.workspace, a.project),
          a.month,
          a.threshold,
          a.status,
          new Date(ctx.now + a.claimedOffsetMs).toISOString(),
          a.sentOffsetMs === undefined ? null : new Date(ctx.now + a.sentOffsetMs).toISOString(),
          a.attempts,
        ],
      );
    }
  } catch (error) {
    if (error instanceof Blocked) throw error;
    throw new Blocked(`seeding failed: ${(error as Error).message}`);
  }
};

// --- comparison --------------------------------------------------------------------------------

const compareStatus = (
  actual: BudgetStatus,
  expected: StatusExpect,
  where: string,
  problems: string[],
) => {
  const fail = (field: string, got: unknown, want: unknown) =>
    problems.push(`${where}: ${field} expected ${show(want)}, got ${show(got)}`);
  const num = (field: keyof StatusExpect, tol: number, nullable: boolean) => {
    if (!(field in expected)) return;
    const want = expected[field] as number | null;
    const got = actual[field as keyof BudgetStatus] as unknown;
    if (want === null) {
      if (!nullable || got !== null) fail(field, got, want);
      return;
    }
    if (typeof got !== 'number' || !Number.isFinite(got) || !within(got, want, tol)) {
      fail(field, got, want);
    }
  };
  num('limitUsd', 1e-9, true);
  num('spendUsd', 1e-6, false);
  num('percentUsed', 0.01, true);
  num('forecastUsd', 0.01, true);
  if ('month' in expected && actual.month !== expected.month) {
    fail('month', actual.month, expected.month);
  }
  for (const field of ['reports', 'estimatedReports'] as const) {
    if (field in expected) {
      const got = actual[field] as unknown;
      if (!Number.isInteger(got) || got !== expected[field]) fail(field, got, expected[field]);
    }
  }
  if (expected.alerted !== undefined && !sameSet(actual.alerted, expected.alerted)) {
    fail('alerted', actual.alerted, expected.alerted);
  }
};

const compareJob = (actual: BudgetAlertJob, expected: ClaimExpect, where: string) => {
  const problems: string[] = [];
  if (actual.threshold !== expected.threshold) {
    problems.push(`${where}: threshold expected ${expected.threshold}, got ${actual.threshold}`);
  }
  if (!sameSet(actual.recipients, expected.recipients)) {
    problems.push(
      `${where}: recipients expected ${show(expected.recipients)}, got ${show(actual.recipients)}`,
    );
  }
  for (const field of ['projectSlug', 'projectName'] as const) {
    if (expected[field] !== undefined && actual[field] !== expected[field]) {
      problems.push(
        `${where}: ${field} expected ${show(expected[field])}, got ${show(actual[field])}`,
      );
    }
  }
  if (expected.status) compareStatus(actual.status, expected.status, `${where} status`, problems);
  return problems;
};

// --- invariants ----------------------------------------------------------------------------------

const PCT_TOL = 0.01;

/** I1–I5 on a BudgetStatus read at `clock`. */
const statusInvariants = (s: BudgetStatus, clock: Date, where: string, problems: string[]) => {
  const fail = (id: string, msg: string) => problems.push(`${where}: ${id} ${msg}`);
  if (typeof s.generatedAt !== 'string' || !Number.isFinite(Date.parse(s.generatedAt))) {
    fail('I1', `generatedAt ${show(s.generatedAt)} is not an instant`);
  }
  if ((s.percentUsed === null) !== (s.limitUsd === null)) {
    fail('I2', `percentUsed ${show(s.percentUsed)} vs limitUsd ${show(s.limitUsd)}`);
  } else if (s.limitUsd !== null && s.percentUsed !== null) {
    const exact = (s.spendUsd / s.limitUsd) * 100;
    if (!within(s.percentUsed, exact, PCT_TOL)) {
      fail('I2', `percentUsed ${s.percentUsed} vs spend ÷ limit × 100 = ${exact}`);
    }
  }
  const elapsed = clock.getTime() - utcMonthStart(clock);
  if ((s.forecastUsd === null) !== elapsed < DAY_MS) {
    fail('I3', `forecastUsd ${show(s.forecastUsd)} with ${elapsed} ms of the month elapsed`);
  } else if (s.forecastUsd !== null && !(s.forecastUsd >= s.spendUsd - 1e-6)) {
    fail('I3', `forecastUsd ${s.forecastUsd} < spendUsd ${s.spendUsd}`);
  }
  if (s.month !== utcMonthKey(clock)) fail('I4', `month ${show(s.month)} ≠ ${utcMonthKey(clock)}`);
  if (!(s.estimatedReports >= 0 && s.estimatedReports <= s.reports)) {
    fail('I4', `estimatedReports ${s.estimatedReports} not in [0, reports ${s.reports}]`);
  }
  if (!(s.spendUsd >= 0)) fail('I4', `spendUsd ${s.spendUsd} < 0`);
  if (
    !Array.isArray(s.alerted) ||
    new Set(s.alerted).size !== s.alerted.length ||
    s.alerted.some((t) => t !== 80 && t !== 100)
  ) {
    fail('I5', `alerted ${show(s.alerted)} not a duplicate-free subset of {80, 100}`);
  }
};

/** I1–I6 on a claimed job for (workspace, project slug). */
const jobInvariants = (
  ctx: Ctx,
  job: BudgetAlertJob,
  ws: WorkspaceKey,
  slug: string,
  clock: Date,
  where: string,
) => {
  const problems: string[] = [];
  statusInvariants(job.status, clock, `${where} job.status`, problems);
  const project = ctx.vector.workspaces[ws]!.projects.find((p) => p.slug === slug)!;
  const fail = (msg: string) => problems.push(`${where}: I6 ${msg}`);
  if (job.projectId !== projectIdOf(ctx, ws, slug)) fail(`projectId ${job.projectId}`);
  if (job.workspaceId !== workspaceIdOf(ctx, ws)) fail(`workspaceId ${job.workspaceId}`);
  if (job.projectSlug !== project.slug) fail(`projectSlug ${show(job.projectSlug)}`);
  if (job.projectName !== project.name) fail(`projectName ${show(job.projectName)}`);
  if (job.status.limitUsd === null) fail('job.status.limitUsd is null');
  if (!(
    typeof job.status.percentUsed === 'number' && job.status.percentUsed >= job.threshold - PCT_TOL
  )) {
    fail(`job.status.percentUsed ${show(job.status.percentUsed)} < threshold ${job.threshold}`);
  }
  const verifiedOwners = new Set(
    ctx.vector.workspaces[ws]!.members.filter(
      (m) => m.role === 'owner' && ctx.vector.users[m.user]!.emailVerified,
    ).map((m) => ctx.vector.users[m.user]!.email),
  );
  for (const r of job.recipients) {
    if (!verifiedOwners.has(r)) fail(`recipient ${show(r)} is not a verified owner of ${ws}`);
  }
  return problems;
};

/** I7 over the whole `budget_alerts` table. */
const alertTableInvariant = async (ctx: Ctx, where: string) => {
  const { rows } = await ctx.db.client.query<{ id: string; attempts: number; status: string }>(
    'select id, attempts, status from budget_alerts',
  );
  for (const r of rows) {
    if (!(r.attempts >= 1 && r.attempts <= 5)) {
      ctx.problems.push(`${where}: I7 row ${r.id} attempts ${r.attempts}`);
    }
    if (!['pending', 'sent', 'failed', 'covered'].includes(r.status)) {
      ctx.problems.push(`${where}: I7 row ${r.id} status ${show(r.status)}`);
    }
  }
};

// --- steps -----------------------------------------------------------------------------------------

const errorKindOf = (error: unknown) =>
  error instanceof RangeError
    ? 'invalid_limit'
    : error instanceof ProjectRepositoryError
      ? ((error as ProjectRepositoryError & { code?: string }).code ?? 'project_error')
      : `${(error as Error)?.name ?? 'unknown'}: ${(error as Error)?.message ?? show(error)}`;

const runStep = async (ctx: Ctx, step: Step, index: number) => {
  const where = `step ${index} (${step.op})`;
  const clock = new Date(ctx.now + ('atOffsetMs' in step ? (step.atOffsetMs ?? 0) : 0));

  switch (step.op) {
    case 'status': {
      const result = await ctx.repo.status(
        workspaceIdOf(ctx, step.workspace),
        targetOf(ctx, step),
        { now: clock },
      );
      if (result !== null) statusInvariants(result, clock, where, ctx.problems);
      if (step.expect === null) {
        if (result !== null) ctx.problems.push(`${where}: expected null, got ${show(result)}`);
      } else if (result === null) {
        ctx.problems.push(`${where}: expected a status, got null`);
      } else {
        compareStatus(result, step.expect, where, ctx.problems);
      }
      return;
    }

    case 'claimAlert': {
      const scope = {
        workspaceId: workspaceIdOf(ctx, step.workspace),
        projectId: projectIdOf(ctx, step.workspace, step.project),
      };
      const n = step.parallel ?? 1;
      // All calls are started before any is awaited (README Concurrency).
      const pending: Promise<BudgetAlertJob | null>[] = [];
      for (let i = 0; i < n; i += 1) pending.push(ctx.repo.claimAlert(scope, { now: clock }));
      const results = await Promise.all(pending);
      const jobs = results.filter((r): r is BudgetAlertJob => r !== null);
      for (const job of jobs) {
        ctx.problems.push(...jobInvariants(ctx, job, step.workspace, step.project, clock, where));
      }
      if (step.expect === null) {
        if (jobs.length > 0) {
          ctx.problems.push(
            `${where}: expected ${n} null result(s), got ${jobs.length} job(s): ${show(
              jobs.map((j) => ({ threshold: j.threshold, recipients: j.recipients })),
            )}`,
          );
        }
        return;
      }
      if (jobs.length === 0 && step.expect.acceptNull) {
        ctx.notes.push(`${where}: null claim accepted (acceptNull, README A5)`);
        return;
      }
      if (jobs.length !== 1) {
        ctx.problems.push(
          `${where}: expected exactly 1 job and ${n - 1} null result(s), got ${jobs.length} job(s)`,
        );
        return;
      }
      ctx.problems.push(...compareJob(jobs[0]!, step.expect, where));
      if (step.label) ctx.jobs.set(step.label, jobs[0]!);
      return;
    }

    case 'markAlert': {
      const job = ctx.jobs.get(step.job);
      if (!job) {
        ctx.problems.push(`${where}: job ${step.job} was never claimed; markAlert not run`);
        return;
      }
      try {
        await ctx.repo.markAlert(job.alertId, step.outcome);
      } catch (error) {
        ctx.problems.push(`${where}: expected ok, threw ${errorKindOf(error)}`);
      }
      return;
    }

    case 'setBudget': {
      const workspaceId = workspaceIdOf(ctx, step.workspace);
      const projectId = targetOf(ctx, step);
      let thrown: unknown;
      let threw = false;
      try {
        if (step.limitUsd === null) {
          await ctx.repo.clearBudget(workspaceId, projectId);
        } else {
          const userId = step.by === undefined ? undefined : ctx.userIds.get(step.by);
          if (step.by !== undefined && !userId) throw new Blocked(`unknown user ${step.by}`);
          await ctx.repo.setBudget(workspaceId, projectId, step.limitUsd, userId ?? '');
        }
      } catch (error) {
        if (error instanceof Blocked) throw error;
        threw = true;
        thrown = error;
      }
      if (step.expect.ok && threw) {
        ctx.problems.push(`${where}: expected ok, threw ${errorKindOf(thrown)}`);
      } else if (!step.expect.ok) {
        if (!threw) {
          ctx.problems.push(
            `${where}: expected refusal (${step.expect.errorKind}) of limitUsd ${show(step.limitUsd)}, but it succeeded`,
          );
        } else if (errorKindOf(thrown) !== step.expect.errorKind) {
          // errorKind is informative (README A9): noted, not failed.
          ctx.notes.push(
            `${where}: refused as ${errorKindOf(thrown)} (vector says ${step.expect.errorKind})`,
          );
        }
      }
      return;
    }

    case 'insertEvents':
      await insertEvents(ctx, step.events, where);
      return;

    case 'alertRows': {
      const projectId = projectIdOf(ctx, step.workspace, step.project);
      const { rows } = await ctx.db.client.query<{
        month: string;
        threshold: number;
        status: string;
        attempts: number;
      }>(
        `select to_char(month, 'YYYY-MM-DD') as month, threshold, status, attempts
           from budget_alerts where project_id = $1 order by month, threshold`,
        [projectId],
      );
      for (const want of step.expect.rows) {
        const matches = rows.filter(
          (r) => r.month === want.month && r.threshold === want.threshold,
        );
        if (matches.length !== 1) {
          ctx.problems.push(
            `${where}: expected one row (${want.month}, ${want.threshold}), found ${matches.length}; rows ${show(rows)}`,
          );
          continue;
        }
        const got = matches[0]!;
        if (
          got.status !== want.status ||
          (want.attempts !== undefined && got.attempts !== want.attempts)
        ) {
          ctx.problems.push(
            `${where}: row (${want.month}, ${want.threshold}) expected ${show(want)}, got ${show(got)}`,
          );
        }
      }
      if (step.expect.exact && rows.length !== step.expect.rows.length) {
        ctx.problems.push(
          `${where}: expected exactly ${step.expect.rows.length} row(s), got ${show(rows)}`,
        );
      }
      return;
    }
  }
};

const runVector = async (vector: Vector) => {
  const now = Date.parse(vector.now);
  if (!Number.isFinite(now)) throw new Blocked(`now ${show(vector.now)} is not an instant`);
  let db: Awaited<ReturnType<typeof freshDb>>;
  try {
    db = await freshDb();
  } catch (error) {
    throw new Blocked(`fresh database failed: ${(error as Error).message}`);
  }
  const ctx: Ctx = {
    db,
    repo: createBudgetRepository(db.db),
    now,
    vector,
    userIds: new Map(),
    workspaceIds: new Map(),
    projectIds: new Map(),
    jobs: new Map(),
    eventCounter: 0,
    threads: new Map(),
    problems: [],
    notes: [],
  };
  try {
    await seed(ctx);
    for (const [i, step] of vector.steps.entries()) {
      await runStep(ctx, step, i);
      await alertTableInvariant(ctx, `after step ${i} (${step.op})`);
    }
  } finally {
    await db.client.close();
  }
  return { problems: ctx.problems, notes: ctx.notes };
};

// ---------------------------------------------------------------------------------------------

describe('JGR v0.1 budget conformance (ADR-0014, docs/jgr/conformance/budgets)', () => {
  it('finds the 25 vectors listed in the README', () => {
    expect(vectorFiles).toHaveLength(25);
  });

  for (const file of vectorFiles) {
    it(file, async () => {
      const { problems, notes } = await runVector(loadVector(file));
      for (const note of notes) console.info(`[${file}] note: ${note}`);
      expect(problems, `${file} FAIL`).toEqual([]);
    });
  }
});
