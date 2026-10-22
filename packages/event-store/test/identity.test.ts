import { configuredProviders, createAuth, AuthConfigError } from '@javis-dog/identity';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { freshDb } from './helpers.ts';

const env = {
  BETTER_AUTH_SECRET: 'test-secret-test-secret-test-secret-0123',
  BETTER_AUTH_URL: 'https://javisdog.example',
  GITHUB_CLIENT_ID: 'Ov23liTESTTESTTEST00',
  GITHUB_CLIENT_SECRET: '0'.repeat(40),
  GOOGLE_CLIENT_ID: '123-test.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'GOCSPX-test',
};

let ctx: Awaited<ReturnType<typeof freshDb>>;
let auth: ReturnType<typeof createAuth>;

beforeAll(async () => {
  ctx = await freshDb();
  auth = createAuth({ db: ctx.db, env });
});
beforeEach(async () => {
  await ctx.client.exec('truncate users, workspaces cascade');
});

type WorkspaceSession = { activeOrganizationId?: string | null };

/** Same internal calls the OAuth callback makes after the provider returns (user + account → session). */
const signUpAndSignIn = async (name: string, email: string) => {
  const { internalAdapter } = await auth.$context;
  const { user } = await internalAdapter.createOAuthUser(
    { name, email, emailVerified: true },
    { providerId: 'github', accountId: `gh-${email}` },
  );
  const session = (await internalAdapter.createSession(user.id)) as WorkspaceSession;
  return { user, session };
};

describe('createAuth configuration', () => {
  it('refuses to start without a strong secret or a base URL', () => {
    expect(() => createAuth({ db: ctx.db, env: { ...env, BETTER_AUTH_SECRET: 'short' } })).toThrow(
      AuthConfigError,
    );
    expect(() => createAuth({ db: ctx.db, env: { ...env, BETTER_AUTH_URL: '' } })).toThrow(
      AuthConfigError,
    );
  });

  it('enables only providers with both client id and secret', () => {
    expect(configuredProviders(env)).toEqual(['github', 'google']);
    expect(configuredProviders({ ...env, GITHUB_CLIENT_SECRET: ' ' })).toEqual(['google']);
  });

  it.each([
    ['github', 'https://github.com/login/oauth/authorize'],
    ['google', 'https://accounts.google.com/'],
  ] as const)('sends %s sign-in to the provider with our callback URL', async (provider, host) => {
    const res = await auth.api.signInSocial({ body: { provider, callbackURL: '/projects' } });
    const url = new URL(res.url!);
    expect(url.href.startsWith(host)).toBe(true);
    expect(url.searchParams.get('redirect_uri')).toBe(
      `https://javisdog.example/api/auth/callback/${provider}`,
    );
    expect(url.searchParams.get('client_id')).toBe(
      provider === 'github' ? env.GITHUB_CLIENT_ID : env.GOOGLE_CLIENT_ID,
    );
  });
});

describe('personal workspace on first sign-in', () => {
  it('creates one owned workspace and makes it the active one', async () => {
    const { user, session } = await signUpAndSignIn('Ada Lovelace', 'ada@example.com');
    const members = await ctx.client.query<{ role: string; workspace_id: string }>(
      'select role, workspace_id from workspace_members where user_id = $1',
      [user.id],
    );
    expect(members.rows).toHaveLength(1);
    expect(members.rows[0]!.role).toBe('owner');
    expect(session.activeOrganizationId).toBe(members.rows[0]!.workspace_id);
    const ws = await ctx.client.query<{ name: string; slug: string }>(
      'select name, slug from workspaces where id = $1',
      [members.rows[0]!.workspace_id],
    );
    expect(ws.rows[0]!.name).toBe("Ada's workspace");
    expect(ws.rows[0]!.slug).toMatch(/^ada-lovelace-[a-z0-9]{6}$/);
  });

  it('reuses the workspace on later sign-ins', async () => {
    const { user, session } = await signUpAndSignIn('Grace Hopper', 'grace@example.com');
    const { internalAdapter } = await auth.$context;
    const second = (await internalAdapter.createSession(user.id)) as WorkspaceSession;
    expect(second.activeOrganizationId).toBe(session.activeOrganizationId);
    const count = await ctx.client.query<{ n: number }>(
      'select count(*)::int as n from workspaces',
    );
    expect(count.rows[0]!.n).toBe(1);
  });

  it('gives two users two separate workspaces', async () => {
    const a = await signUpAndSignIn('A', 'a@example.com');
    const b = await signUpAndSignIn('B', 'b@example.com');
    expect(a.session.activeOrganizationId).not.toBe(b.session.activeOrganizationId);
  });

  it('removes the membership and sessions when the user is deleted', async () => {
    const { user } = await signUpAndSignIn('Temp User', 'temp@example.com');
    await ctx.client.query('delete from users where id = $1', [user.id]);
    const left = await ctx.client.query<{ m: number; s: number }>(
      'select (select count(*)::int from workspace_members) as m, (select count(*)::int from sessions) as s',
    );
    expect(left.rows[0]).toEqual({ m: 0, s: 0 });
  });
});

describe('stored provider data', () => {
  it('never stores the provider id_token (minimization)', async () => {
    const { internalAdapter } = await auth.$context;
    const { user } = await internalAdapter.createOAuthUser(
      { name: 'Id Token', email: 'idtoken@example.com', emailVerified: true },
      { providerId: 'google', accountId: 'g-1', idToken: 'eyJhbGciOiJSUzI1NiJ9.payload.sig' },
    );
    const row = await ctx.client.query<{ id_token: string | null }>(
      'select id_token from accounts where user_id = $1',
      [user.id],
    );
    expect(row.rows[0]!.id_token).toBeNull();
  });
});
