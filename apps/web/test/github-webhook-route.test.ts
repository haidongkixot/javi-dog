import { createHmac, createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { schema } from '@javis-dog/event-store';
import { createGithubRepository, type GithubWebhookLogEntry } from '@javis-dog/github-bridge';
import { createProjectRepository } from '@javis-dog/projects';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
// The in-process Postgres comes from apps/web's dev dependencies (same copies JD-M06 tests use).
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';

// S5g H3 (TEST_PLAN §S5g rows "Route", "Installations", "Never stored" and the D0 replay row):
// the real `POST /api/github/webhook` wiring — JD-APP route → JD-M10 handler → JD-M10 repository
// and JD-M06 event repository — on PGlite with every committed migration (0000–0006). Only the
// Neon client factory is replaced. Secrets are obviously fake; nothing points at a real host.

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@javis-dog/event-store', async (orig) => ({
  ...(await orig<typeof import('@javis-dog/event-store')>()),
  createDb: () => state.db,
}));

const route = await import('@/app/api/github/webhook/route');
const { getGithubWebhookHandler, resetGithubWebhookForTests } =
  await import('@/lib/github-webhook');

const CURRENT = 'test-route-webhook-secret-NOT-REAL';
const PREVIOUS = 'test-route-webhook-secret-previous-NOT-REAL';
const DATABASE_URL = 'postgresql://test@127.0.0.1:9/not-a-real-db';
const SENTINEL = 'routesentinel';

const INSTALLATION = 5150;
const ACCOUNT = 7070;
const REPO = 8080;
const FULL_NAME = 'octo-owner/octo-repo';

let client: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;
let world: { workspaceId: string; projectId: string; slug: string };

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client, { schema });
  await migrate(db, {
    migrationsFolder: resolve(process.cwd(), '../../packages/event-store/migrations'),
  });
  state.db = db;
}, 60_000);

beforeEach(async () => {
  await client.exec('truncate workspaces, github_installations, github_deliveries, events cascade');
  const projects = createProjectRepository(db);
  const ws = await projects.createWorkspace({ name: 'Signal team' });
  const p = await projects.createProject(ws.id, { name: 'Web', platforms: ['claude-code'] });
  world = { workspaceId: ws.id, projectId: p.id, slug: p.slug };
  vi.stubEnv('DATABASE_URL', DATABASE_URL);
  vi.stubEnv('GITHUB_APP_WEBHOOK_SECRET', CURRENT);
  vi.stubEnv('GITHUB_APP_WEBHOOK_SECRET_PREVIOUS', '');
  resetGithubWebhookForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetGithubWebhookForTests();
});

// ---------------------------------------------------------------------------------------------
// Payloads (GitHub's webhook shapes, minimal) with a sentinel in every field never stored.
// ---------------------------------------------------------------------------------------------

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const person = (f: string) => ({ login: `${SENTINEL}-${f}`, id: 31337, type: 'User' });
const repository = (fullName = FULL_NAME, id = REPO) => ({
  id,
  full_name: fullName,
  name: `${SENTINEL}-repo-name`,
  owner: person('owner'),
  html_url: `https://github.com/${SENTINEL}`,
});

const workflowRun = (
  action: string,
  over: { id?: number; updatedAgoMs?: number; fullName?: string; repoId?: number } = {},
) => ({
  action,
  workflow_run: {
    id: over.id ?? 31001,
    run_attempt: 1,
    status: action,
    conclusion: action === 'completed' ? 'success' : null,
    head_branch: `${SENTINEL}-branch`,
    display_title: `${SENTINEL} title`,
    path: `.github/workflows/${SENTINEL}.yml`,
    head_commit: { message: `${SENTINEL} message`, author: { email: `${SENTINEL}@example.test` } },
    actor: person('actor'),
    run_started_at: iso(10 * 60_000),
    updated_at: iso(over.updatedAgoMs ?? 60_000),
  },
  repository: repository(over.fullName, over.repoId),
  installation: { id: INSTALLATION },
  sender: person('sender'),
});

const installationCreated = () => ({
  action: 'created',
  installation: {
    id: INSTALLATION,
    account: { id: ACCOUNT, type: 'User', login: `${SENTINEL}-account` },
    contact_email: `${SENTINEL}@example.test`,
    suspended_by: person('suspended_by'),
  },
  repositories: [{ id: REPO, full_name: FULL_NAME, name: `${SENTINEL}-name` }],
  requester: person('requester'),
  sender: person('sender'),
});

const enc = new TextEncoder();
const sign = (body: Uint8Array, secret = CURRENT) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
const sha256 = (body: Uint8Array) => createHash('sha256').update(body).digest('hex');

let guid = 0;
const nextGuid = () => `0d0c0ffe-0019-41f1-8000-${String(++guid).padStart(12, '0')}`;

interface Delivery {
  body: Uint8Array<ArrayBuffer>;
  event: string;
  signature?: string;
  headers?: Record<string, string>;
}
const delivery = (payload: unknown, event: string): Delivery => ({
  body: enc.encode(JSON.stringify(payload)),
  event,
});

const request = (d: Delivery) =>
  new Request('https://javisdog.test/api/github/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': d.event,
      'x-github-delivery': nextGuid(),
      'x-hub-signature-256': d.signature ?? sign(d.body),
      ...d.headers,
    },
    body: d.body,
  });

/** Through the exported route, exactly as Next.js calls it. */
const post = async (d: Delivery) => {
  const res = await route.POST(request(d));
  return { status: res.status, json: (await res.json()) as Record<string, unknown>, res };
};

const count = async (sql: string, params: unknown[] = []) =>
  Number((await client.query<{ n: number }>(sql, params)).rows[0]!.n);
const eventCount = () => count('select count(*)::int as n from events');
const recorded = (body: Uint8Array) =>
  count('select count(*)::int as n from github_deliveries where body_sha256 = $1', [sha256(body)]);

/** A signed `installation created`, then the owner's claim and link (the product path). */
const installAndLink = async () => {
  const created = await post(delivery(installationCreated(), 'installation'));
  expect(created.status).toBe(200);
  const gh = createGithubRepository(db);
  expect(
    await gh.claimInstallation({
      workspaceId: world.workspaceId,
      installationId: INSTALLATION,
      githubAccountId: ACCOUNT,
    }),
  ).toBe('claimed');
  expect(
    await gh.linkRepository({
      workspaceId: world.workspaceId,
      repoId: REPO,
      projectId: world.projectId,
      userId: '00000000-0000-4000-8000-0000000000aa',
    }),
  ).toBe('linked');
};

describe('POST /api/github/webhook', () => {
  it('is a dynamic Node route', () => {
    expect(route.runtime).toBe('nodejs');
    expect(route.dynamic).toBe('force-dynamic');
  });

  it('answers 503 not_configured without a secret, with only the previous one, or without a database', async () => {
    const d = delivery(workflowRun('completed'), 'workflow_run');
    for (const env of [
      { GITHUB_APP_WEBHOOK_SECRET: '' },
      { GITHUB_APP_WEBHOOK_SECRET: '', GITHUB_APP_WEBHOOK_SECRET_PREVIOUS: CURRENT },
      { DATABASE_URL: '' },
    ]) {
      for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
      resetGithubWebhookForTests();
      const r = await post(d);
      expect(r.status).toBe(503);
      expect(r.json).toEqual({ error: 'not_configured' });
      expect(r.res.headers.get('cache-control')).toBe('no-store');
      vi.stubEnv('DATABASE_URL', DATABASE_URL);
      vi.stubEnv('GITHUB_APP_WEBHOOK_SECRET', CURRENT);
      vi.stubEnv('GITHUB_APP_WEBHOOK_SECRET_PREVIOUS', '');
    }
    expect(await count('select count(*)::int as n from github_deliveries')).toBe(0);
  });

  it('fills installations only from a signed delivery; a replay changes nothing', async () => {
    const d = delivery(installationCreated(), 'installation');
    expect((await post(d)).status).toBe(200);
    const rows = await client.query<{ installation_id: number; account_id: number; repos: number }>(
      `select i.installation_id, i.account_id,
              (select count(*)::int from github_repositories r where r.installation_id = i.installation_id) as repos
         from github_installations i`,
    );
    expect(rows.rows).toEqual([{ installation_id: INSTALLATION, account_id: ACCOUNT, repos: 1 }]);
    const again = await post(d);
    expect(again.status).toBe(202);
    expect(again.json).toEqual({ ok: true, outcome: 'duplicate' });
    const kinds = await client.query<{ kind: string }>('select kind from github_deliveries');
    expect(kinds.rows).toEqual([{ kind: 'installation' }]);
  });

  it('stores one L0 event for a linked repository, touches the signals, and dedupes a redelivery', async () => {
    await installAndLink();
    const d = delivery(workflowRun('completed'), 'workflow_run');
    const r = await post(d);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, outcome: 'stored' });
    expect(r.res.headers.get('cache-control')).toBe('no-store');

    const stored = await client.query<Record<string, unknown>>(
      'select project_id, workspace_id, producer_id, thread_ref, type, status, agent_ref, privacy_class, sequence, attributes from events',
    );
    expect(stored.rows).toEqual([
      {
        project_id: world.projectId,
        workspace_id: world.workspaceId,
        producer_id: `gh-app_${INSTALLATION}`,
        thread_ref: expect.stringMatching(/^gh_[0-9a-f]{32}$/),
        type: 'task.completed',
        status: null,
        agent_ref: null,
        privacy_class: 'L0',
        sequence: 2,
        attributes: expect.objectContaining({
          tool_name: 'github-actions',
          task_kind: 'ci.workflow',
        }),
      },
    ]);
    expect(await recorded(d.body)).toBe(1);
    expect(
      await count(
        'select count(*)::int as n from projects where id = $1 and last_signal_at is not null',
        [world.projectId],
      ),
    ).toBe(1);
    expect(
      await count(
        'select count(*)::int as n from github_installations where last_verified_delivery_at is not null',
      ),
    ).toBe(1);

    // Same body, new GUID (GitHub's manual redelivery or a replay): nothing new.
    const again = await post(d);
    expect(again.status).toBe(202);
    expect(again.json).toEqual({ ok: true, outcome: 'duplicate' });
    // Same body re-labelled as another event: still the same signed content.
    expect((await post({ ...d, event: 'check_suite' })).status).toBe(202);
    expect(await eventCount()).toBe(1);
  });

  it('accepts the previous secret during a rotation, and only then', async () => {
    await installAndLink();
    const d = delivery(workflowRun('in_progress'), 'workflow_run');
    const old = { ...d, signature: sign(d.body, PREVIOUS) };
    expect((await post(old)).status).toBe(401);
    vi.stubEnv('GITHUB_APP_WEBHOOK_SECRET_PREVIOUS', PREVIOUS);
    expect((await post(old)).status).toBe(200);
    expect(await eventCount()).toBe(1);
  });

  it('answers 401 for a wrong signature, the same for a malformed one, and records nothing', async () => {
    await installAndLink();
    const d = delivery(workflowRun('completed'), 'workflow_run');
    const wrong = await post({ ...d, signature: sign(d.body, 'test-other-secret-NOT-REAL') });
    const malformed = await post({ ...d, signature: 'sha1=00' });
    expect(wrong.status).toBe(401);
    expect(malformed.status).toBe(401);
    expect(wrong.json).toEqual({ error: 'unauthorized' });
    expect(malformed.json).toEqual(wrong.json);
    expect(await recorded(d.body)).toBe(0);
    expect(await eventCount()).toBe(0);
  });

  it('answers 413 over 1 MiB and 415 for a compressed body, recording nothing', async () => {
    await installAndLink();
    const json = JSON.stringify(workflowRun('completed'));
    const big = enc.encode(json + ' '.repeat(1_048_577 - json.length));
    expect(big.byteLength).toBe(1_048_577);
    const tooLarge = await post({ body: big, event: 'workflow_run' });
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.json).toEqual({ error: 'too_large' });
    const d = delivery(workflowRun('completed'), 'workflow_run');
    const gz = await post({ ...d, headers: { 'content-encoding': 'gzip' } });
    expect(gz.status).toBe(415);
    expect(
      await count('select count(*)::int as n from github_deliveries where kind = $1', ['activity']),
    ).toBe(0);
    expect(await eventCount()).toBe(0);
  });

  it('answers 202 and stores nothing for an unlinked repository, ping, or a header that disagrees', async () => {
    expect((await post(delivery(installationCreated(), 'installation'))).status).toBe(200);
    // Installed but not claimed or linked.
    const unlinked = await post(delivery(workflowRun('completed'), 'workflow_run'));
    expect(unlinked.status).toBe(202);
    expect(unlinked.json).toEqual({ ok: true, outcome: 'unrouted' });
    const ping = await post(delivery({ zen: `${SENTINEL} zen`, hook_id: 1 }, 'ping'));
    expect(ping.status).toBe(202);
    const mismatch = await post(delivery(workflowRun('requested'), 'pull_request'));
    expect(mismatch.status).toBe(202);
    expect(await eventCount()).toBe(0);
  });

  it('drops a delivery whose event time is more than 3 days old', async () => {
    await installAndLink();
    const old = delivery(
      workflowRun('completed', { updatedAgoMs: 72 * 3_600_000 + 60_000 }),
      'workflow_run',
    );
    const r = await post(old);
    expect(r.status).toBe(202);
    expect(r.json).toEqual({ ok: true, outcome: 'too_old' });
    expect(await eventCount()).toBe(0);
  });

  it('refreshes full_name from a signed delivery (G20)', async () => {
    await installAndLink();
    const renamed = 'octo-owner/octo-renamed';
    expect(
      (await post(delivery(workflowRun('completed', { fullName: renamed }), 'workflow_run')))
        .status,
    ).toBe(200);
    const row = await client.query<{ full_name: string }>(
      'select full_name from github_repositories where repo_id = $1',
      [REPO],
    );
    expect(row.rows).toEqual([{ full_name: renamed }]);
  });

  it('answers 500 on a database failure with nothing recorded, and processes the redelivery', async () => {
    await installAndLink();
    const d = delivery(workflowRun('completed'), 'workflow_run');
    // A real failure inside the handler, after routing and before the hash: the insert fails.
    await client.exec('alter table events rename to events_unavailable');
    let failed: Awaited<ReturnType<typeof post>>;
    try {
      failed = await post(d);
    } finally {
      await client.exec('alter table events_unavailable rename to events');
    }
    expect(failed.status).toBe(500);
    expect(failed.json).toEqual({ error: 'unavailable' });
    expect(await recorded(d.body)).toBe(0);
    const redelivered = await post(d);
    expect(redelivered.status).toBe(200);
    expect(await eventCount()).toBe(1);
    expect(await recorded(d.body)).toBe(1);
  });

  it('keeps every sentinel out of events, github rows and logs', async () => {
    const logs: GithubWebhookLogEntry[] = [];
    const send = async (d: Delivery) =>
      getGithubWebhookHandler(process.env, { log: (e) => logs.push(e) })(request(d));
    expect((await send(delivery(installationCreated(), 'installation'))).status).toBe(200);
    await createGithubRepository(db).claimInstallation({
      workspaceId: world.workspaceId,
      installationId: INSTALLATION,
      githubAccountId: ACCOUNT,
    });
    await createGithubRepository(db).linkRepository({
      workspaceId: world.workspaceId,
      repoId: REPO,
      projectId: world.projectId,
      userId: '00000000-0000-4000-8000-0000000000aa',
    });
    const run = delivery(workflowRun('completed'), 'workflow_run');
    expect((await send(run)).status).toBe(200);
    expect((await send({ ...run, signature: sign(run.body, 'test-other-NOT-REAL') })).status).toBe(
      401,
    );
    expect((await send(delivery({ zen: SENTINEL }, `${SENTINEL}-event`))).status).toBe(202);

    const dump = async (table: string) =>
      JSON.stringify((await client.query(`select * from ${table}`)).rows).toLowerCase();
    for (const table of ['events', 'github_installations', 'github_deliveries']) {
      expect(await dump(table), table).not.toContain(SENTINEL);
    }
    // full_name is the one GitHub-derived name kept, and only in github_repositories (§4).
    expect(await dump('github_repositories')).not.toContain(SENTINEL);
    expect(await dump('events')).not.toContain(FULL_NAME);

    expect(logs).toHaveLength(4);
    const text = JSON.stringify(logs).toLowerCase();
    for (const forbidden of [SENTINEL, CURRENT.toLowerCase(), sign(run.body).slice(7), FULL_NAME]) {
      expect(text).not.toContain(forbidden);
    }
    expect(logs.map((l) => [l.status, l.outcome, l.event, l.action])).toEqual([
      [200, 'applied', 'installation', 'created'],
      [200, 'stored', 'workflow_run', 'completed'],
      [401, 'unauthorized', undefined, undefined],
      [202, 'ignored:shape', undefined, undefined],
    ]);
  });
});
