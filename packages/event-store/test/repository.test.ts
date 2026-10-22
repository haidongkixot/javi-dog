import {
  createProjectRepository,
  MAX_ACTIVE_TOKENS_PER_PROJECT,
  ProjectRepositoryError,
} from '@javis-dog/projects';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { freshDb } from './helpers.ts';

let ctx: Awaited<ReturnType<typeof freshDb>>;
let repo: ReturnType<typeof createProjectRepository>;

// One in-process Postgres per file; tables are emptied between tests.
beforeAll(async () => {
  ctx = await freshDb();
  repo = createProjectRepository(ctx.db);
});
beforeEach(async () => {
  await ctx.client.exec('truncate workspaces cascade');
});

const project = { name: "Javi's Dog Web", platforms: ['claude-code'] };
const errorCode = (p: Promise<unknown>) =>
  p.then(
    () => 'resolved',
    (e: unknown) => (e instanceof ProjectRepositoryError ? e.code : String(e)),
  );

describe('workspaces and projects', () => {
  it('derives slugs and defaults privacy to L0', async () => {
    const ws = await repo.createWorkspace({ name: 'Eagodi Lab' });
    const p = await repo.createProject(ws.id, project);
    expect(ws.slug).toBe('eagodi-lab');
    expect(p).toMatchObject({ slug: 'javis-dog-web', privacyClass: 'L0', lastSignalAt: null });
  });

  it('rejects a duplicate workspace slug', async () => {
    await repo.createWorkspace({ name: 'Lab' });
    expect(await errorCode(repo.createWorkspace({ name: 'Lab' }))).toBe('slug_taken');
  });

  it('allows the same project slug in two workspaces but not twice in one', async () => {
    const a = await repo.createWorkspace({ name: 'A team' });
    const b = await repo.createWorkspace({ name: 'B team' });
    await repo.createProject(a.id, project);
    await expect(repo.createProject(b.id, project)).resolves.toBeTruthy();
    expect(await errorCode(repo.createProject(a.id, project))).toBe('slug_taken');
  });

  it('isolates workspaces: B cannot read or list A’s project', async () => {
    const a = await repo.createWorkspace({ name: 'A team' });
    const b = await repo.createWorkspace({ name: 'B team' });
    const p = await repo.createProject(a.id, project);
    expect(await repo.getProject(b.id, p.id)).toBeNull();
    expect(await repo.listProjects(b.id)).toEqual([]);
    expect((await repo.listProjects(a.id)).map((x) => x.id)).toEqual([p.id]);
  });

  it('cascades workspace deletion to projects and tokens', async () => {
    const ws = await repo.createWorkspace({ name: 'Doomed' });
    const p = await repo.createProject(ws.id, project);
    await repo.issueToken(ws.id, p.id, 'ci');
    await ctx.client.query('delete from workspaces where id = $1', [ws.id]);
    const counts = await ctx.client.query<{ p: number; t: number }>(
      'select (select count(*)::int from projects) as p, (select count(*)::int from ingest_tokens) as t',
    );
    expect(counts.rows[0]).toEqual({ p: 0, t: 0 });
  });
});

describe('ingest tokens', () => {
  const setup = async () => {
    const ws = await repo.createWorkspace({ name: 'Token team' });
    const p = await repo.createProject(ws.id, project);
    return { ws, p };
  };

  it('stores only the SHA-256 hash and returns the plaintext once', async () => {
    const { ws, p } = await setup();
    const { token, record } = await repo.issueToken(ws.id, p.id, 'laptop');
    const rows = await ctx.client.query<Record<string, unknown>>('select * from ingest_tokens');
    const stored = rows.rows[0]!;
    expect(Object.values(stored)).not.toContain(token);
    expect(stored.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(await repo.listTokens(ws.id, p.id))).not.toContain(token.slice(6));
    expect(record.displayPrefix).toBe(token.slice(6, 14));
  });

  it('verifies an active token to its scope and rejects it after revoke', async () => {
    const { ws, p } = await setup();
    const { token, record } = await repo.issueToken(ws.id, p.id, 'laptop');
    expect(await repo.verifyToken(token)).toEqual({
      tokenId: record.id,
      projectId: p.id,
      workspaceId: ws.id,
    });
    expect(await repo.revokeToken(ws.id, record.id)).toBe(true);
    expect(await repo.revokeToken(ws.id, record.id)).toBe(true);
    expect(await repo.verifyToken(token)).toBeNull();
  });

  it('returns null for unknown and malformed tokens', async () => {
    await setup();
    expect(await repo.verifyToken(`jd_it_${'A'.repeat(43)}`)).toBeNull();
    expect(await repo.verifyToken('not-a-token')).toBeNull();
    expect(await repo.verifyToken(undefined)).toBeNull();
  });

  it('refuses to issue or revoke across workspaces', async () => {
    const { ws, p } = await setup();
    const other = await repo.createWorkspace({ name: 'Other team' });
    expect(await errorCode(repo.issueToken(other.id, p.id, 'x'))).toBe('not_found');
    const { token, record } = await repo.issueToken(ws.id, p.id, 'mine');
    expect(await repo.revokeToken(other.id, record.id)).toBe(false);
    expect(await repo.verifyToken(token)).not.toBeNull();
  });

  it('enforces the cross-workspace rule in the database too', async () => {
    const { p } = await setup();
    const other = await repo.createWorkspace({ name: 'Other team' });
    await expect(
      ctx.client.query(
        `insert into ingest_tokens (project_id, workspace_id, name, token_hash, display_prefix)
         values ($1, $2, 'forged', repeat('a', 64), 'aaaaaaaa')`,
        [p.id, other.id],
      ),
    ).rejects.toThrow(/ingest_tokens_project_workspace_fk/);
  });

  it(`limits a project to ${MAX_ACTIVE_TOKENS_PER_PROJECT} active tokens`, async () => {
    const { ws, p } = await setup();
    const issued = [];
    for (let i = 0; i < MAX_ACTIVE_TOKENS_PER_PROJECT; i++) {
      issued.push(await repo.issueToken(ws.id, p.id, `t${i}`));
    }
    expect(await errorCode(repo.issueToken(ws.id, p.id, 'one too many'))).toBe('token_limit');
    await repo.revokeToken(ws.id, issued[0]!.record.id);
    await expect(repo.issueToken(ws.id, p.id, 'after revoke')).resolves.toBeTruthy();
  });
});
