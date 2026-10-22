// Manual end-to-end smoke against a deployed ingest endpoint (S3a). Not part of `pnpm test`.
// Creates a throwaway workspace + project + token in DATABASE_URL, posts real batches to
// INGEST_URL, checks the results in the database, then deletes the workspace (cascade).
// Usage: pnpm --filter @javis-dog/ingest smoke:live   (DATABASE_URL must be the deployment's DB)
import { createDb, workspaces } from '@javis-dog/event-store';
import { createProjectRepository } from '@javis-dog/projects';
import { eq, sql } from 'drizzle-orm';

const url = process.env.DATABASE_URL;
const endpoint = process.env.INGEST_URL ?? 'https://javisdog.vercel.app/api/v1/events';
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const db = createDb(url);
const repo = createProjectRepository(db);
const check = (label: string, ok: boolean) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  if (!ok) process.exitCode = 1;
};

const stamp = Date.now();
const event = (n: number, extra: Record<string, unknown> = {}) => ({
  jgr: '0.1',
  event_id: `01JBZ4XQ80${String(stamp).slice(-10)}${String(n).padStart(6, '0')}`,
  producer_id: 'prod_live-smoke',
  project_ref: 'live-smoke',
  thread_ref: 'sess_live_smoke',
  sequence: n,
  type: 'heartbeat',
  status: 'working',
  occurred_at: new Date().toISOString(),
  ...extra,
});

const ws = await repo.createWorkspace({ name: 'Live smoke', slug: `live-smoke-${stamp}` });
try {
  const project = await repo.createProject(ws.id, {
    name: 'Live smoke',
    slug: 'live-smoke',
    platforms: ['claude-code'],
  });
  const { token } = await repo.issueToken(ws.id, project.id, 'live smoke');
  const post = (body: unknown, auth = token) =>
    fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${auth}` },
      body: JSON.stringify(body),
    });

  const unauth = await post({ events: [event(1)] }, `jd_it_${'A'.repeat(43)}`);
  check(`unknown token → ${unauth.status}`, unauth.status === 401);

  const batch = { events: [event(1), event(2, { project_ref: 'not-this-project' })] };
  const first = await post(batch);
  const firstBody = (await first.json()) as {
    accepted?: number;
    duplicates?: number;
    rejected?: Array<{ index: number; issues: Array<{ code: string }> }>;
  };
  check(`first batch → ${first.status}`, first.status === 202);
  check(
    `accepted 1, rejected index 1 project_mismatch (${JSON.stringify(firstBody)})`,
    firstBody.accepted === 1 &&
      firstBody.rejected?.[0]?.index === 1 &&
      firstBody.rejected[0].issues[0]?.code === 'project_mismatch',
  );

  const retry = (await (await post(batch)).json()) as { accepted?: number; duplicates?: number };
  check(
    `retry → accepted 0, duplicates 1 (${JSON.stringify(retry)})`,
    retry.accepted === 0 && retry.duplicates === 1,
  );

  const [row] = await db
    .execute<{ events: number; signal: boolean; used: boolean }>(
      sql`select (select count(*)::int from events where project_id = ${project.id}) as events,
                 (select last_signal_at is not null from projects where id = ${project.id}) as signal,
                 (select bool_and(last_used_at is not null) from ingest_tokens where project_id = ${project.id}) as used`,
    )
    .then((r) => r.rows);
  check(`stored events = ${row?.events}`, row?.events === 1);
  check('last_signal_at and last_used_at set', row?.signal === true && row?.used === true);
} finally {
  await db.delete(workspaces).where(eq(workspaces.id, ws.id));
  const [left] = await db
    .execute<{ n: number }>(
      sql`select count(*)::int as n from events where workspace_id = ${ws.id}`,
    )
    .then((r) => r.rows);
  check('cleanup cascaded', left?.n === 0);
}
