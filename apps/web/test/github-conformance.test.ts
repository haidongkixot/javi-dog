import { createHmac } from 'node:crypto';
import { resolve } from 'node:path';
import { schema } from '@javis-dog/event-store';
import { createGithubRepository, verifyGithubSignature } from '@javis-dog/github-bridge';
import { createProjectRepository } from '@javis-dog/projects';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
// The in-process Postgres comes from apps/web's dev dependencies (same copies JD-M06 tests use).
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import {
  buildBody,
  compareEvent,
  findAbsent,
  GUID,
  hexBytes,
  loadSchemaValidator,
  loadVectors,
  normaliseState,
  sha256Hex,
  type RouteStep,
  type RouteVector,
  type RowState,
  type SignatureVector,
  type StoredEvent,
} from './github-conformance-helpers';

// S5g H5 part 2 — GitHub App bridge conformance runner (QA lane). Executes every vector in
// docs/jgr/conformance/github/ (README there is the contract) against the real production
// wiring: the exported `POST` of apps/web/src/app/api/github/webhook/route.ts → JD-APP
// `getGithubWebhookHandler(process.env)` → JD-M10 handler and repository + JD-M06 event
// repository, on PGlite with every committed migration. Only the Neon client factory is
// replaced (as in github-webhook-route.test.ts). The route reads its clock from `Date`, so each
// request runs with `Date` (only) faked to the vector's `clock`; secrets come from env; logs are
// captured from the default `consoleGithubWebhookLog` through console spies.
//
// Layer: route (README "Runner rules"). One describe per vector file, one `it` per step (state is
// kept per vector; one fresh store per vector). Not run here: JD-M01 validation of stored events
// (invariant I1) — `@javis-dog/jgr-spec` is not a dependency of apps/web and no dependency may be
// added in this lane; the handler itself validates with JD-M01 before inserting (README of
// JD-M10, check 12), and every envelope field and attribute is compared exactly instead.

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@javis-dog/event-store', async (orig) => ({
  ...(await orig<typeof import('@javis-dog/event-store')>()),
  createDb: () => state.db,
}));

const route = await import('@/app/api/github/webhook/route');
const { resetGithubWebhookForTests } = await import('@/lib/github-webhook');

const DATABASE_URL = 'postgresql://qa:qa@127.0.0.1:9/not-a-real-db';
const URL = 'https://javisdog.test/api/github/webhook';
const MARKER = 'qasentinel';

const vectors = loadVectors();
const validateVector = loadSchemaValidator();

let client: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;
/** A database whose every call fails (closed PGlite): the `store-unavailable` fault (R21). */
let deadClient: PGlite;
let deadDb: ReturnType<typeof drizzle<typeof schema>>;
let tables: string[] = [];

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client, { schema });
  await migrate(db, {
    migrationsFolder: resolve(process.cwd(), '../../packages/event-store/migrations'),
  });
  tables = (
    await client.query<{ t: string }>(
      `select quote_ident(tablename) as t from pg_tables where schemaname = 'public'`,
    )
  ).rows.map((r) => r.t);
  deadClient = new PGlite();
  await deadClient.waitReady;
  await deadClient.close();
  deadDb = drizzle(deadClient, { schema });
  state.db = db;
}, 60_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  resetGithubWebhookForTests();
  await client.close();
});

// ---------------------------------------------------------------------------------------------
// Per-vector context: fresh store, env, log capture.
// ---------------------------------------------------------------------------------------------

interface Ctx {
  workspaces: Map<string, string>; // label → id
  logs: string[];
  lastSequence: Map<string, bigint>; // producer|thread → last sequence
  restore: () => void;
}

const freshStore = async () => {
  await client.exec(`truncate ${tables.join(', ')} restart identity cascade`);
};

const setSecrets = (current: string | null | undefined, previous: string | null | undefined) => {
  vi.stubEnv('DATABASE_URL', DATABASE_URL);
  vi.stubEnv('GITHUB_APP_WEBHOOK_SECRET', current ?? undefined);
  vi.stubEnv('GITHUB_APP_WEBHOOK_SECRET_PREVIOUS', previous ?? undefined);
  resetGithubWebhookForTests();
};

const captureLogs = (logs: string[]) => {
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    }),
  );
  return () => spies.forEach((s) => s.mockRestore());
};

const seed = async (v: RouteVector): Promise<Map<string, string>> => {
  const projects = createProjectRepository(db);
  const workspaces = new Map<string, string>();
  const projectIds = new Map<string, { id: string; workspaceId: string }>();
  for (const ws of v.setup.workspaces) {
    const row = await projects.createWorkspace({ name: `QA ${ws.label}` });
    workspaces.set(ws.label, row.id);
    for (const p of ws.projects) {
      const pr = await projects.createProject(row.id, {
        name: p.slug,
        slug: p.slug,
        platforms: ['claude-code'],
        privacyClass: p.privacyClass,
      });
      projectIds.set(p.slug, { id: pr.id, workspaceId: row.id });
    }
  }
  // github_* rows: plain SQL into the migrated schema (README "Setup": the only product path that
  // creates them is a signed delivery).
  for (const i of v.setup.installations) {
    await client.query(
      `insert into github_installations
         (installation_id, account_id, account_type, claimed_workspace_id, suspended_at)
       values ($1, $2, $3, $4, $5)`,
      [
        i.installationId,
        i.accountId,
        i.accountType,
        i.claimedBy === null ? null : workspaces.get(i.claimedBy),
        i.suspended ? v.clock : null,
      ],
    );
  }
  for (const r of v.setup.repositories) {
    const link = r.project === null ? null : projectIds.get(r.project)!;
    await client.query(
      `insert into github_repositories
         (repo_id, installation_id, full_name, workspace_id, project_id, linked_at)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        r.repoId,
        r.installationId,
        r.fullName,
        link?.workspaceId ?? null,
        link?.id ?? null,
        link ? v.clock : null,
      ],
    );
  }
  return workspaces;
};

const readState = async (workspaces: Map<string, string>): Promise<RowState> => {
  const label = new Map([...workspaces].map(([l, id]) => [id, l]));
  const inst = await client.query<{
    installationId: number;
    accountId: number;
    accountType: 'User' | 'Organization';
    ws: string | null;
    suspended: boolean;
  }>(
    `select installation_id::int as "installationId", account_id::int as "accountId",
            account_type as "accountType", claimed_workspace_id as ws,
            suspended_at is not null as suspended
       from github_installations`,
  );
  const repos = await client.query<{
    repoId: number;
    installationId: number;
    fullName: string;
    project: string | null;
  }>(
    `select r.repo_id::int as "repoId", r.installation_id::int as "installationId",
            r.full_name as "fullName", p.slug as project
       from github_repositories r left join projects p on p.id = r.project_id`,
  );
  return normaliseState({
    installations: inst.rows.map((r) => ({
      installationId: r.installationId,
      accountId: r.accountId,
      accountType: r.accountType,
      claimedBy: r.ws === null ? null : (label.get(r.ws) ?? `unknown-workspace:${r.ws}`),
      suspended: r.suspended,
    })),
    repositories: repos.rows,
  });
};

const readEvents = async () =>
  (
    await client.query<StoredEvent>(
      `select e.id, e.event_id, e.producer_id, p.slug as project_ref, e.thread_ref,
              e.sequence::text as sequence, e.type, e.status, e.agent_ref, e.privacy_class,
              e.occurred_at, e.usage_delta, e.attributes, e.encrypted, row_to_json(e)::text as json
         from events e join projects p on p.id = e.project_id`,
    )
  ).rows;

const deliveryRecorded = async (bodySha256: string) =>
  (
    await client.query<{ n: number }>(
      'select count(*)::int as n from github_deliveries where body_sha256 = $1',
      [bodySha256],
    )
  ).rows[0]!.n === 1;

/** README "Absent strings": events, `github_*` rows (marker allowed only in `full_name`), logs. */
const absentProblems = async (needles: readonly string[], logLines: readonly string[]) => {
  const out: string[] = [];
  const all = [MARKER, ...needles];
  for (const e of await readEvents()) {
    for (const hit of findAbsent(e.json, all)) out.push(`event ${e.event_id} contains "${hit}"`);
  }
  for (const t of ['github_installations', 'github_deliveries']) {
    const rows = await client.query<{ j: string }>(`select row_to_json(t)::text as j from ${t} t`);
    for (const r of rows.rows)
      for (const hit of findAbsent(r.j, all)) out.push(`${t} row contains "${hit}"`);
  }
  const repos = await client.query<{ j: string; full_name: string }>(
    `select (to_jsonb(t) - 'full_name')::text as j, full_name from github_repositories t`,
  );
  for (const r of repos.rows) {
    for (const hit of findAbsent(r.j, all)) out.push(`github_repositories row contains "${hit}"`);
    for (const hit of findAbsent(r.full_name, needles)) {
      out.push(`github_repositories.full_name contains "${hit}"`);
    }
  }
  for (const line of logLines) {
    for (const hit of findAbsent(line, all)) out.push(`log line contains "${hit}": ${line}`);
  }
  return out;
};

// "github-401": every response in the group, across all vectors, has the same status and body.
const group401: { where: string; status: number; body: string }[] = [];

const send = async (
  v: { clock: string },
  headers: Record<string, string>,
  body: Uint8Array<ArrayBuffer>,
  fault: boolean,
) => {
  if (fault) {
    state.db = deadDb;
    resetGithubWebhookForTests();
  }
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(v.clock) });
  try {
    const res = await route.POST(new Request(URL, { method: 'POST', headers, body }));
    return { status: res.status, text: await res.text() };
  } finally {
    vi.useRealTimers();
    if (fault) {
      state.db = db;
      resetGithubWebhookForTests();
    }
  }
};

const runStep = async (v: RouteVector, step: RouteStep, index: number, ctx: Ctx) => {
  const problems: string[] = [];
  const where = `${v.id} step ${index + 1}`;
  const before = new Set((await readEvents()).map((e) => e.id));
  const logStart = ctx.logs.length;

  if (step.action) {
    // README "Setup": releaseClaim through the product's release path for the claiming workspace.
    const claimed = await client.query<{ ws: string | null }>(
      'select claimed_workspace_id as ws from github_installations where installation_id = $1',
      [step.action.installationId],
    );
    const ws = claimed.rows[0]?.ws ?? null;
    if (ws === null) problems.push('releaseClaim: installation is not claimed');
    else {
      const released = await createGithubRepository(db).releaseInstallation(
        ws,
        step.action.installationId,
      );
      if (released !== true) problems.push(`releaseClaim returned ${String(released)}`);
    }
  } else {
    const req = step.request!;
    const body = buildBody(req); // throws BLOCKED on a fixture mismatch
    const res = await send(v, req.headers, body, step.fault === 'store-unavailable');
    const exp = step.expect;
    if (res.status !== exp.status) problems.push(`status ${res.status}, expected ${exp.status}`);
    if (exp.errorCode !== null) {
      let error: unknown;
      try {
        error = (JSON.parse(res.text) as { error?: unknown }).error;
      } catch {
        error = `<not JSON: ${res.text.slice(0, 80)}>`;
      }
      if (error !== exp.errorCode)
        problems.push(`error ${String(error)}, expected ${exp.errorCode}`);
    }
    if (exp.equivalenceGroup === 'github-401') {
      group401.push({ where, status: res.status, body: res.text });
      const first = group401[0]!;
      if (first.status !== res.status || first.body !== res.text) {
        problems.push(
          `github-401 group differs from ${first.where}: ${res.status} ${res.text} vs ${first.status} ${first.body}`,
        );
      }
    }
    if (exp.deliveryRecorded !== null) {
      const recorded = await deliveryRecorded(req.bodySha256);
      if (recorded !== exp.deliveryRecorded) {
        problems.push(`body hash recorded ${recorded}, expected ${exp.deliveryRecorded}`);
      }
    }
    // The capture works: the handler writes one log entry per request (JD-M10 README).
    if (ctx.logs.length === logStart) problems.push('no log line captured for this request');
    // README "Logs": no header value other than a GUID-shaped X-GitHub-Delivery and
    // X-GitHub-Event may appear in a log line (values under 3 characters are not checked).
    const forbidden = Object.entries(req.headers)
      .filter(([k, val]) => {
        if (k === 'x-github-event') return false;
        if (k === 'x-github-delivery' && GUID.test(val)) return false;
        return val.length >= 3;
      })
      .map(([, val]) => val);
    for (const line of ctx.logs.slice(logStart)) {
      for (const hit of findAbsent(line, forbidden)) {
        problems.push(`log line carries header value "${hit}": ${line}`);
      }
    }
  }

  // Events newly stored by this step (README "Event comparison").
  const added = (await readEvents()).filter((e) => !before.has(e.id));
  const expected = step.expect.events;
  if (added.length !== expected.length) {
    problems.push(
      `${added.length} events stored, expected ${expected.length}: ${added.map((e) => `${e.type} ${e.event_id}`).join(', ')}`,
    );
  }
  for (const exp of expected) {
    const stored = added.find((e) => e.event_id === exp.event.event_id);
    if (!stored) {
      problems.push(`expected event ${exp.event.event_id} (${exp.event.type}) not stored`);
      continue;
    }
    for (const p of compareEvent(stored, exp)) problems.push(`event ${exp.event.event_id}: ${p}`);
  }
  for (const e of added) {
    if (!expected.some((x) => x.event.event_id === e.event_id)) {
      problems.push(`unexpected event ${e.event_id} ${e.type} ${e.thread_ref} seq ${e.sequence}`);
    }
    // Spec §3 / JGR-R06: strictly increasing per (producer, thread) in step order.
    const key = `${e.producer_id}|${e.thread_ref}`;
    const seq = BigInt(e.sequence);
    const last = ctx.lastSequence.get(key);
    if (last !== undefined && seq <= last)
      problems.push(`sequence ${seq} not above ${last} on ${key}`);
    ctx.lastSequence.set(key, seq);
  }

  if (step.expect.state !== null) {
    const actual = await readState(ctx.workspaces);
    const want = normaliseState(step.expect.state);
    if (JSON.stringify(actual) !== JSON.stringify(want)) {
      problems.push(`rows: ${JSON.stringify(actual)} expected ${JSON.stringify(want)}`);
    }
  }

  problems.push(...(await absentProblems(v.absentStrings, ctx.logs.slice(logStart))));
  expect(problems, `${where}: ${step.note}`).toEqual([]);
};

// ---------------------------------------------------------------------------------------------
// The suite.
// ---------------------------------------------------------------------------------------------

describe('vector files', () => {
  it('finds the 59 documented vectors (S 12, R 22, M 18, P 7)', () => {
    const groups = vectors.reduce<Record<string, number>>((acc, { vector }) => {
      acc[vector.id[0]!] = (acc[vector.id[0]!] ?? 0) + 1;
      return acc;
    }, {});
    expect(vectors).toHaveLength(59);
    expect(groups).toEqual({ M: 18, P: 7, R: 22, S: 12 });
    const route = vectors.filter((v) => v.vector.kind === 'route');
    const steps = route.flatMap((v) => (v.vector as RouteVector).steps);
    expect(steps).toHaveLength(174);
    expect(steps.flatMap((s) => s.expect.events)).toHaveLength(70);
  });

  it('the schema check is not vacuous: broken copies are rejected', () => {
    const s02 = vectors.find((v) => v.vector.id === 'S02')!.raw;
    const breakers: Record<string, (c: RouteVector) => void> = {
      'status on an event': (c) => {
        (c.steps[0]!.expect.events[0]!.event as Record<string, unknown>).status = 'ok';
      },
      'non-L0 attribute': (c) => {
        (c.steps[0]!.expect.events[0]!.attributes as Record<string, unknown>).branch = 'x';
      },
      'two bodies': (c) => {
        c.steps[0]!.request!.bodyText = '{}';
      },
      'upper-case event_id': (c) => {
        const e = c.steps[0]!.expect.events[0]!.event;
        e.event_id = e.event_id.toUpperCase();
      },
      'missing key': (c) => {
        delete (c as Partial<RouteVector>).absentStrings;
      },
    };
    expect(validateVector(s02).ok).toBe(true);
    for (const [name, breakIt] of Object.entries(breakers)) {
      const copy = structuredClone(s02) as RouteVector;
      breakIt(copy);
      expect(validateVector(copy).ok, name).toBe(false);
    }
  });
});

for (const { file, raw, vector } of vectors) {
  describe(`${vector.id} (${file})`, () => {
    it('validates against schema.json', () => {
      const r = validateVector(raw);
      expect(r.ok ? [] : r.issues).toEqual([]);
    });

    if (vector.kind === 'signature') {
      const v = vector as SignatureVector;
      const ctx = { logs: [] as string[], restore: () => {} };
      beforeAll(() => {
        ctx.logs.length = 0;
        ctx.restore = captureLogs(ctx.logs);
      });
      afterAll(() => {
        ctx.restore();
        vi.unstubAllEnvs();
      });

      for (const c of v.cases) {
        it(`case ${c.label}: ${c.expect.valid ? 'accepted' : '401'}`, async () => {
          const body = hexBytes(c.bodyHex);
          // Informative known answers: HMAC-SHA256 under the UTF-8 bytes of each secret (Y4).
          const hmacs = c.secrets.map((s) =>
            createHmac('sha256', Buffer.from(s, 'utf8')).update(body).digest('hex'),
          );
          if (JSON.stringify(hmacs) !== JSON.stringify(c.expect.hmacHexPerSecret)) {
            throw new Error(
              `BLOCKED (fixture): hmacHexPerSecret disagrees with ${hmacs.join(',')}`,
            );
          }
          // Verifier layer: the public JD-M10 verifier.
          expect(verifyGithubSignature(body, c.header, c.secrets) === 'ok', 'verifier').toBe(
            c.expect.valid,
          );
          // Route layer: a fresh store per case (several cases share a body), the configured
          // secrets in env, only the signature header sent.
          await freshStore();
          setSecrets(c.secrets[0], c.secrets[1]);
          const logStart = ctx.logs.length;
          const headers: Record<string, string> =
            c.header === null ? {} : { 'x-hub-signature-256': c.header };
          const res = await send({ clock: '2026-11-01T12:00:00Z' }, headers, body, false);
          if (c.expect.valid) {
            expect(res.status, 'a verified body is acknowledged, never 401').not.toBe(401);
            expect([200, 202]).toContain(res.status);
          } else {
            expect(res.status).toBe(401);
            group401.push({ where: `S01 ${c.label}`, status: res.status, body: res.text });
            expect(res.text).toBe(group401[0]!.body);
          }
          expect(await deliveryRecorded(sha256Hex(body))).toBe(c.expect.valid);
          const leaks = await absentProblems(
            [...c.secrets, ...hmacs, ...(c.header ? [c.header] : [])].filter((s) => s.length >= 8),
            ctx.logs.slice(logStart),
          );
          expect(leaks).toEqual([]);
        });
      }
      return;
    }

    const v = vector as RouteVector;
    const ctx: Ctx = {
      workspaces: new Map(),
      logs: [],
      lastSequence: new Map(),
      restore: () => {},
    };
    beforeAll(async () => {
      await freshStore();
      setSecrets(v.setup.secrets.current, v.setup.secrets.previous);
      ctx.workspaces = await seed(v);
      ctx.logs.length = 0;
      ctx.lastSequence.clear();
      ctx.restore = captureLogs(ctx.logs);
      // The seeded rows are exactly the setup (a seeding error is the runner's, not a FAIL).
      const seeded = await readState(ctx.workspaces);
      const want = normaliseState({
        installations: v.setup.installations,
        repositories: v.setup.repositories,
      });
      if (JSON.stringify(seeded) !== JSON.stringify(want)) {
        throw new Error(`BLOCKED (runner seed): ${JSON.stringify(seeded)}`);
      }
    });
    afterAll(() => {
      ctx.restore();
      vi.unstubAllEnvs();
      resetGithubWebhookForTests();
    });

    v.steps.forEach((step, i) => {
      const what = step.action
        ? `action ${step.action.op}`
        : `${step.expect.status} ${step.expect.outcome}`;
      it(`step ${i + 1}: ${what} — ${step.note}`, () => runStep(v, step, i, ctx));
    });
  });
}

// Beyond the vectors: R21's fault fails every database call of the request, so the first call
// (the dedupe read) already fails and a hash written before a failing event insert can never be
// observed (README mutation table "Record the hash before a failed insert → R21"). This replays
// R21's first delivery with only the event insert failing (the events table renamed away), and
// keeps G14: 500, no hash; the redelivery is then stored once.
describe('R21 supplement: only the event insert fails (G14)', () => {
  const v = vectors.find((x) => x.vector.id === 'R21')!.vector as RouteVector;
  const ctx: Ctx = { workspaces: new Map(), logs: [], lastSequence: new Map(), restore: () => {} };
  beforeAll(async () => {
    await freshStore();
    setSecrets(v.setup.secrets.current, v.setup.secrets.previous);
    ctx.workspaces = await seed(v);
    ctx.restore = captureLogs(ctx.logs);
  });
  afterAll(() => {
    ctx.restore();
    vi.unstubAllEnvs();
    resetGithubWebhookForTests();
  });

  it('500 with no hash recorded, then the same bytes are stored once', async () => {
    const step = v.steps.find((s) => s.fault === 'store-unavailable')!;
    const redelivery = v.steps.find((s) => s.expect.events.length === 1)!;
    const req = step.request!;
    expect(redelivery.request!.bodySha256).toBe(req.bodySha256);
    const body = buildBody(req);
    await client.exec('alter table events rename to events_unavailable');
    let failed: { status: number; text: string };
    try {
      failed = await send(v, req.headers, body, false);
    } finally {
      await client.exec('alter table events_unavailable rename to events');
    }
    expect(failed.status).toBe(500);
    expect(await deliveryRecorded(req.bodySha256)).toBe(false);
    const again = await send(v, redelivery.request!.headers, buildBody(redelivery.request!), false);
    expect(again.status).toBe(200);
    expect(await deliveryRecorded(req.bodySha256)).toBe(true);
    const stored = await readEvents();
    expect(stored.map((e) => e.event_id)).toEqual(
      redelivery.expect.events.map((e) => e.event.event_id),
    );
  });
});

describe('github-401 equivalence group (across all vectors)', () => {
  it('every 401 has the same status and the same body bytes', () => {
    expect(group401.length).toBeGreaterThan(0);
    const distinct = new Set(group401.map((g) => `${g.status} ${g.body}`));
    expect([...distinct]).toHaveLength(1);
  });
});
