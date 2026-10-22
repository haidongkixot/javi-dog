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
export const createAuth = ({ db, env }: { db: ProjectsDb; env: AuthEnv }) => {
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
