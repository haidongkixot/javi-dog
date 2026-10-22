import { projectTables, type ProjectsDb } from '@javis-dog/projects';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { organization } from 'better-auth/plugins/organization';
import { identityTables } from './db/tables.ts';
import { ensurePersonalWorkspace } from './workspace.ts';

export interface AuthEnv {
  BETTER_AUTH_SECRET?: string | undefined;
  BETTER_AUTH_URL?: string | undefined;
  GITHUB_CLIENT_ID?: string | undefined;
  GITHUB_CLIENT_SECRET?: string | undefined;
  GOOGLE_CLIENT_ID?: string | undefined;
  GOOGLE_CLIENT_SECRET?: string | undefined;
}

export type SocialProvider = 'github' | 'google';

/** Called once after a new user row exists. Failures are logged and never block sign-in. */
export type OnUserCreated = (user: { id: string; email: string; name: string }) => Promise<void>;

const EMAIL = /[^\s@"'<>]+@[^\s@"'<>]+\.[^\s@"'<>]+/g;
const SECRETISH = /\b(gh[opsu]_[A-Za-z0-9]+|ya29\.[\w.-]+|eyJ[\w-]+\.[\w-]+\.[\w-]+|jd_it_[\w-]+)/g;

/** Removes emails and token-like strings before anything reaches the logs. */
export const redact = (text: string) =>
  text.replace(EMAIL, '[email]').replace(SECRETISH, '[secret]');

/** One JSON line per auth event; extra arguments are dropped because they may hold PII. */
export const authLog = (level: string, message: string) => {
  const line = JSON.stringify({ event: 'auth', level, message: redact(message).slice(0, 300) });
  if (level === 'error') console.error(line);
  else console.warn(line);
};

export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthConfigError';
  }
}

const has = (v: string | undefined): v is string => typeof v === 'string' && v.trim() !== '';

/** Providers whose client id and secret are both present. */
export const configuredProviders = (env: AuthEnv): SocialProvider[] => [
  ...(has(env.GITHUB_CLIENT_ID) && has(env.GITHUB_CLIENT_SECRET) ? (['github'] as const) : []),
  ...(has(env.GOOGLE_CLIENT_ID) && has(env.GOOGLE_CLIENT_SECRET) ? (['google'] as const) : []),
];

/** Better Auth model names → Drizzle tables (organization = workspace, ADR-0006). */
const authSchema = {
  user: identityTables.users,
  session: identityTables.sessions,
  account: identityTables.accounts,
  verification: identityTables.verifications,
  organization: projectTables.workspaces,
  member: identityTables.workspaceMembers,
  invitation: identityTables.invitations,
};

/** Server-side auth for JD-APP. `db` is any Drizzle Postgres handle with the composed schema. */
export const createAuth = ({
  db,
  env,
  onUserCreated,
}: {
  db: ProjectsDb;
  env: AuthEnv;
  onUserCreated?: OnUserCreated;
}) => {
  if (!has(env.BETTER_AUTH_SECRET) || env.BETTER_AUTH_SECRET.length < 32) {
    throw new AuthConfigError('BETTER_AUTH_SECRET must be set (at least 32 characters).');
  }
  if (!has(env.BETTER_AUTH_URL)) throw new AuthConfigError('BETTER_AUTH_URL must be set.');
  const providers = configuredProviders(env);

  return betterAuth({
    appName: "Javi's Dog",
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, { provider: 'pg', schema: authSchema, transaction: false }),
    advanced: { database: { generateId: 'uuid' } },
    telemetry: { enabled: false },
    logger: { level: 'warn', log: (level, message) => authLog(level, message) },
    // Failed OAuth callbacks land on our sign-in page with `?error=<code>` (S2c).
    onAPIError: { errorURL: '/sign-in' },
    account: { encryptOAuthTokens: true },
    socialProviders: {
      ...(providers.includes('github') && {
        github: { clientId: env.GITHUB_CLIENT_ID!, clientSecret: env.GITHUB_CLIENT_SECRET! },
      }),
      ...(providers.includes('google') && {
        google: { clientId: env.GOOGLE_CLIENT_ID!, clientSecret: env.GOOGLE_CLIENT_SECRET! },
      }),
    },
    plugins: [organization()],
    databaseHooks: {
      // Minimization (ADR-0006): the provider id_token carries name/email/avatar in plain
      // text and is never used; encryptOAuthTokens does not cover it, so it is not stored.
      account: {
        create: { before: async (account) => ({ data: { ...account, idToken: null } }) },
        update: { before: async (account) => ({ data: { ...account, idToken: null } }) },
      },
      user: {
        create: {
          after: async (user) => {
            if (!onUserCreated) return;
            try {
              await onUserCreated({ id: user.id, email: user.email, name: user.name });
            } catch (error) {
              authLog('error', `onUserCreated failed: ${(error as Error).name}`);
            }
          },
        },
      },
      session: {
        create: {
          before: async (session) => ({
            data: {
              ...session,
              activeOrganizationId: await ensurePersonalWorkspace(db, session.userId),
            },
          }),
        },
      },
    },
  });
};

export type Auth = ReturnType<typeof createAuth>;
