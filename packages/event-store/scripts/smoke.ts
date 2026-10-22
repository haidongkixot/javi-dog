// Manual smoke test against a real Neon branch (dev-agent only). Not part of `pnpm test`.
// Creates a throwaway workspace, exercises the repository, then deletes it (cascade).
// Usage: NODE_USE_ENV_PROXY=1 pnpm --filter @javis-dog/event-store db:smoke
import { createProjectRepository } from '@javis-dog/projects';
import { eq, sql } from 'drizzle-orm';
import { createDb, pingDb, workspaces } from '../src/index.ts';

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
check(`tables: ${names}`, names === 'ingest_tokens, projects, workspaces');

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
} finally {
  await db.delete(workspaces).where(eq(workspaces.id, ws.id));
  const [left] = await db
    .execute<{ n: number }>(
      sql`select count(*)::int as n from projects where workspace_id = ${ws.id}`,
    )
    .then((r) => r.rows);
  check('cleanup cascaded', left?.n === 0);
}
