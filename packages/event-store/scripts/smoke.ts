// Manual smoke test against a real Neon branch (dev-agent only). Not part of `pnpm test`.
// Creates a throwaway workspace, exercises the repository, then deletes it (cascade).
// Usage: NODE_USE_ENV_PROXY=1 pnpm --filter @javis-dog/event-store db:smoke
import { createProjectRepository } from '@javis-dog/projects';
import { eq, sql } from 'drizzle-orm';
import { createDb, createEventRepository, pingDb, workspaces } from '../src/index.ts';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const db = createDb(url);
const check = (label: string, ok: boolean) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  if (!ok) process.exitCode = 1;
};

const ping = await pingDb(db);
check(
  `ping (${ping.latencyMs} ms, ${ping.migrationsApplied} migrations applied)`,
  ping.migrationsApplied > 0,
);

const tables = await db.execute<{ table_name: string }>(
  sql`select table_name from information_schema.tables where table_schema = 'public' order by 1`,
);
const names = tables.rows.map((r) => r.table_name).join(', ');
const expected =
  'accounts, budget_alerts, events, ingest_rate_windows, ingest_tokens, invitations, project_budgets, projects, sessions, users, verifications, workspace_members, workspaces';
check(`tables: ${names}`, names === expected);

const repo = createProjectRepository(db);
const ws = await repo.createWorkspace({ name: 'Smoke', slug: `smoke-${Date.now()}` });
try {
  const project = await repo.createProject(ws.id, {
    name: 'Smoke project',
    platforms: ['claude-code'],
  });
  check('project defaults to L0', project.privacyClass === 'L0');
  const { token, record } = await repo.issueToken(ws.id, project.id, 'smoke');
  const verified = await repo.verifyToken(token);
  check(
    'issued token verifies to its scope',
    verified?.projectId === project.id && verified.workspaceId === ws.id,
  );
  const [stored] = await db
    .execute<{ token_hash: string }>(
      sql`select token_hash from ingest_tokens where id = ${record.id}`,
    )
    .then((r) => r.rows);
  check(
    'stored value is a hash, not the token',
    stored?.token_hash !== token && /^[0-9a-f]{64}$/.test(stored?.token_hash ?? ''),
  );
  await repo.revokeToken(ws.id, record.id);
  check('revoked token no longer verifies', (await repo.verifyToken(token)) === null);

  const events = createEventRepository(db);
  const row = {
    projectId: project.id,
    workspaceId: ws.id,
    producerId: 'prod_smoke',
    eventId: '01JBZ4XQ800000000000000001',
    threadRef: 'sess_smoke',
    sequence: 1,
    type: 'heartbeat',
    status: 'working',
    privacyClass: 'L0',
    occurredAt: new Date(),
  };
  check('event stored once', (await events.insertEvents([row])) === 1);
  check('retry is deduplicated', (await events.insertEvents([row])) === 0);
  const hit = await events.hitRateWindow(record.id, new Date());
  check('rate window counts', hit.count >= 1);
} finally {
  await db.delete(workspaces).where(eq(workspaces.id, ws.id));
  const [left] = await db
    .execute<{ n: number; e: number }>(
      sql`select (select count(*)::int from projects where workspace_id = ${ws.id}) as n,
                 (select count(*)::int from events where workspace_id = ${ws.id}) as e`,
    )
    .then((r) => r.rows);
  check('cleanup cascaded to projects and events', left?.n === 0 && left?.e === 0);
}
