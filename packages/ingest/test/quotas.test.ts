// JD-M04 quotas (S5a M1, owner decision 2026-10-28 "Caps, no migration"), enforced in the
// repository so no caller can bypass them. PGlite with the committed migrations; lives here
// because this package already has PGlite and the JD-M06 migrations as dev dependencies.
import { PGlite } from '@electric-sql/pglite';
import { schema } from '@javis-dog/event-store';
import { getMigrationsFolder } from '@javis-dog/event-store/migrations';
import {
  createProjectRepository,
  MAX_ACTIVE_TOKENS_PER_PROJECT,
  MAX_PROJECTS_PER_WORKSPACE,
  MAX_TOKENS_ISSUED_PER_PROJECT_PER_DAY,
  ProjectRepositoryError,
} from '@javis-dog/projects';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

let client: PGlite;
let repo: ReturnType<typeof createProjectRepository>;

beforeAll(async () => {
  client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: getMigrationsFolder() });
  repo = createProjectRepository(db);
});
beforeEach(async () => {
  await client.exec('truncate workspaces cascade');
});

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (error) {
    if (error instanceof ProjectRepositoryError) return error.code;
    throw error;
  }
};
const count = async (sql: string, params: unknown[] = []) =>
  (await client.query<{ n: number }>(sql, params)).rows[0]!.n;
const newProject = (workspaceId: string, n: number) =>
  repo.createProject(workspaceId, { name: `Project ${n}`, platforms: ['claude-code'] });

describe('projects per workspace', () => {
  it('exports the caps', () => {
    expect(MAX_PROJECTS_PER_WORKSPACE).toBe(20);
    expect(MAX_TOKENS_ISSUED_PER_PROJECT_PER_DAY).toBe(10);
    expect(MAX_ACTIVE_TOKENS_PER_PROJECT).toBe(5);
  });

  it('creates 20 and refuses the 21st without writing it', async () => {
    const ws = await repo.createWorkspace({ name: 'Busy' });
    for (let n = 1; n <= 20; n++) expect(await code(newProject(ws.id, n))).toBe('ok');
    expect(await code(newProject(ws.id, 21))).toBe('project_limit');
    expect(
      await count('select count(*)::int as n from projects where workspace_id = $1', [ws.id]),
    ).toBe(20);
  });

  it('counts each workspace on its own', async () => {
    const a = await repo.createWorkspace({ name: 'Alpha' });
    const b = await repo.createWorkspace({ name: 'Beta' });
    for (let n = 1; n <= 20; n++) await newProject(a.id, n);
    expect(await code(newProject(a.id, 21))).toBe('project_limit');
    expect(await code(newProject(b.id, 1))).toBe('ok');
  });
});

describe('tokens issued per project per rolling 24 h', () => {
  const setup = async () => {
    const ws = await repo.createWorkspace({ name: 'Tokens' });
    const p = await newProject(ws.id, 1);
    return { ws, p };
  };

  it('issues 10 (revoked ones included) and refuses the 11th', async () => {
    const { ws, p } = await setup();
    // Issue then revoke must not loop past the cap.
    for (let n = 1; n <= 10; n++) {
      const { record } = await repo.issueToken(ws.id, p.id, `t${n}`);
      await repo.revokeToken(ws.id, record.id);
    }
    expect(await code(repo.issueToken(ws.id, p.id, 't11'))).toBe('token_issue_limit');
    expect(await count('select count(*)::int as n from ingest_tokens')).toBe(10);
  });

  it('keeps the 5-active cap below the daily cap', async () => {
    const { ws, p } = await setup();
    for (let n = 1; n <= 5; n++) await repo.issueToken(ws.id, p.id, `t${n}`);
    expect(await code(repo.issueToken(ws.id, p.id, 't6'))).toBe('token_limit');
  });

  it('stops counting a token issued 24 h + 1 ms ago (database clock)', async () => {
    const { ws, p } = await setup();
    for (let n = 1; n <= 10; n++) {
      const { record } = await repo.issueToken(ws.id, p.id, `t${n}`);
      await repo.revokeToken(ws.id, record.id);
    }
    await client.query(
      `update ingest_tokens set created_at = now() - interval '24 hours 1 millisecond'
       where id = (select id from ingest_tokens order by created_at, id limit 1)`,
    );
    expect(await code(repo.issueToken(ws.id, p.id, 'fresh'))).toBe('ok');
    expect(await code(repo.issueToken(ws.id, p.id, 'again'))).toBe('token_issue_limit');
  });

  it('counts each project on its own', async () => {
    const { ws, p } = await setup();
    const other = await newProject(ws.id, 2);
    for (let n = 1; n <= 10; n++) {
      const { record } = await repo.issueToken(ws.id, p.id, `t${n}`);
      await repo.revokeToken(ws.id, record.id);
    }
    expect(await code(repo.issueToken(ws.id, other.id, 'ok'))).toBe('ok');
  });

  it('still answers not_found for another workspace’s project before any quota', async () => {
    const { p } = await setup();
    const stranger = await repo.createWorkspace({ name: 'Stranger' });
    expect(await code(repo.issueToken(stranger.id, p.id, 'x'))).toBe('not_found');
  });
});
