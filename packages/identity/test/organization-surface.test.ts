// In-process Better Auth on PGlite: the organization plugin's HTTP surface must be closed
// (S5a review M2, ADR-0006). Personal workspaces are created by ensurePersonalWorkspace only.
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { projectTables, type ProjectsDb } from '@javis-dog/projects';
import { makeSignature } from 'better-auth/crypto';
import { organization } from 'better-auth/plugins/organization';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAuth } from '../src/index.ts';
import { identityTables } from '../src/db/tables.ts';

// The committed migrations live in JD-M06 (which depends on this package, so it cannot be
// imported here); the SQL files are read from disk.
const migrationsFolder = fileURLToPath(new URL('../../event-store/migrations', import.meta.url));
const BASE = 'https://javisdog.example';
const env = {
  BETTER_AUTH_SECRET: 'test-secret-test-secret-test-secret-0123',
  BETTER_AUTH_URL: BASE,
};

let client: PGlite;
let auth: ReturnType<typeof createAuth>;

// PGlite boots a WASM Postgres; under a parallel `pnpm test` a cold start exceeded the 10 s
// default hook timeout (same 30 s allowance as the JD-M05/JD-M06 suites' vitest configs).
const PGLITE_TIMEOUT = 30_000;

beforeAll(async () => {
  client = new PGlite();
  const db = drizzle(client, { schema: { ...projectTables, ...identityTables } });
  await migrate(db, { migrationsFolder });
  auth = createAuth({ db: db as unknown as ProjectsDb, env });
}, PGLITE_TIMEOUT);
beforeEach(async () => {
  await client.exec('truncate users, workspaces cascade');
});

/** A user, their first session (which creates the personal workspace) and its cookie. */
const signIn = async (name: string, email: string) => {
  const ctx = await auth.$context;
  const { user } = await ctx.internalAdapter.createOAuthUser(
    { name, email, emailVerified: true },
    { providerId: 'github', accountId: `gh-${email}` },
  );
  const session = (await ctx.internalAdapter.createSession(user.id)) as {
    token: string;
    activeOrganizationId?: string | null;
  };
  const signed = `${session.token}.${await makeSignature(session.token, ctx.secret)}`;
  const cookie = `${ctx.authCookies.sessionToken.name}=${encodeURIComponent(signed)}`;
  const [member] = (
    await client.query<{ id: string }>('select id from workspace_members where user_id = $1', [
      user.id,
    ])
  ).rows;
  return { user, cookie, workspaceId: session.activeOrganizationId!, memberId: member!.id };
};

const call = (cookie: string, method: 'GET' | 'POST', path: string, body?: unknown) =>
  auth.handler(
    new Request(`${BASE}/api/auth${path}`, {
      method,
      headers: {
        cookie,
        origin: BASE,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    }),
  );

const counts = async () =>
  (
    await client.query<{ w: number; m: number; i: number }>(
      `select (select count(*)::int from workspaces) as w,
              (select count(*)::int from workspace_members) as m,
              (select count(*)::int from invitations) as i`,
    )
  ).rows[0];

describe('organization plugin HTTP surface (M2)', { timeout: PGLITE_TIMEOUT }, () => {
  it('still creates exactly one owned personal workspace on first sign-in', async () => {
    const ada = await signIn('Ada Lovelace', 'ada@example.com');
    const rows = await client.query<{ role: string; workspace_id: string }>(
      'select role, workspace_id from workspace_members where user_id = $1',
      [ada.user.id],
    );
    expect(rows.rows).toEqual([{ role: 'owner', workspace_id: ada.workspaceId }]);
    expect(await counts()).toEqual({ w: 1, m: 1, i: 0 });
  });

  it('keeps get-session working over HTTP', async () => {
    const ada = await signIn('Ada Lovelace', 'ada@example.com');
    const res = await call(ada.cookie, 'GET', '/get-session');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { user: { email: string } }).user.email).toBe('ada@example.com');
  });

  it('refuses every review-listed endpoint for a signed-in owner and changes nothing', async () => {
    const ada = await signIn('Ada Lovelace', 'ada@example.com');
    const bob = await signIn('Bob Byte', 'bob@example.com');
    // An invitation for Bob to Ada's workspace, as if one had been sent earlier.
    const [inv] = (
      await client.query<{ id: string }>(
        `insert into invitations (workspace_id, email, role, status, expires_at, inviter_id)
         values ($1, 'bob@example.com', 'admin', 'pending', now() + interval '1 day', $2)
         returning id`,
        [ada.workspaceId, ada.user.id],
      )
    ).rows;
    const before = await counts();
    const org = ada.workspaceId;
    const attempts = [
      [ada.cookie, 'POST', '/organization/create', { name: 'Second', slug: 'second-ws' }],
      [
        ada.cookie,
        'POST',
        '/organization/invite-member',
        { email: 'c@x.io', role: 'admin', organizationId: org },
      ],
      [bob.cookie, 'POST', '/organization/accept-invitation', { invitationId: inv!.id }],
      [
        ada.cookie,
        'POST',
        '/organization/update-member-role',
        { memberId: ada.memberId, role: 'member', organizationId: org },
      ],
      [
        ada.cookie,
        'POST',
        '/organization/remove-member',
        { memberIdOrEmail: ada.memberId, organizationId: org },
      ],
      [
        ada.cookie,
        'POST',
        '/organization/update',
        { data: { metadata: { x: 1 }, name: 'Pwned' }, organizationId: org },
      ],
      [ada.cookie, 'POST', '/organization/delete', { organizationId: org }],
      [ada.cookie, 'GET', `/organization/list-members?organizationId=${org}`, undefined],
      [ada.cookie, 'POST', '/organization/check-slug', { slug: 'anything' }],
      [ada.cookie, 'POST', '/organization/set-active', { organizationId: bob.workspaceId }],
      [ada.cookie, 'POST', '/organization/leave', { organizationId: org }],
    ] as const;
    const statuses = [];
    for (const [cookie, method, path, body] of attempts) {
      statuses.push([path.split('?')[0], (await call(cookie, method, path, body)).status]);
    }
    expect(statuses).toEqual(attempts.map(([, , path]) => [path.split('?')[0], 404]));
    expect(await counts()).toEqual(before);
    const ws = await client.query<{ name: string; metadata: unknown }>(
      'select name, metadata from workspaces where id = $1',
      [org],
    );
    expect(ws.rows[0]!.name).toBe("Ada's workspace");
    const roles = await client.query<{ role: string }>(
      'select role from workspace_members where user_id = $1',
      [ada.user.id],
    );
    expect(roles.rows).toEqual([{ role: 'owner' }]);
  });

  it('refuses every path the plugin version ships (including future additions)', async () => {
    const ada = await signIn('Ada Lovelace', 'ada@example.com');
    const paths = Object.values(organization().endpoints).map((e) => ({
      path: e.path,
      method: ([e.options.method].flat()[0] === 'GET' ? 'GET' : 'POST') as 'GET' | 'POST',
    }));
    expect(paths.length).toBeGreaterThan(20);
    for (const { path, method } of paths) {
      const res = await call(ada.cookie, method, path, method === 'POST' ? {} : undefined);
      expect([path, res.status]).toEqual([path, 404]);
    }
  });

  it.each([
    '/organization/create/',
    '/Organization/create',
    '/organization/%63reate',
    '//organization/create',
  ])('does not route the variant %s to organization create', async (path) => {
    const ada = await signIn('Ada Lovelace', 'ada@example.com');
    const res = await call(ada.cookie, 'POST', path, { name: 'Variant', slug: 'variant-ws' });
    expect(res.status).toBe(404);
    expect((await counts())!.w).toBe(1);
  });
});
