import { createDb, type Db } from '@javis-dog/event-store';
import {
  authLog,
  configuredProviders,
  createAuth,
  type Auth,
  type OnUserCreated,
  type SocialProvider,
} from '@javis-dog/identity';
import { sendWelcomeEmail } from '@javis-dog/notify';

type Env = Readonly<Record<string, string | undefined>>;

let cached: { auth: Auth; db: Db } | null | undefined;

/** Welcome email (JD-M09) when Resend is configured; otherwise no email is attempted. */
const welcomeHook = (env: Env): OnUserCreated | undefined => {
  const { RESEND_API_KEY, EMAIL_FROM, BETTER_AUTH_URL } = env;
  if (!RESEND_API_KEY || !EMAIL_FROM || !BETTER_AUTH_URL) return undefined;
  return async (user) => {
    await sendWelcomeEmail(
      { apiKey: RESEND_API_KEY, from: EMAIL_FROM, appUrl: BETTER_AUTH_URL },
      { email: user.email, name: user.name },
    );
    authLog('info', 'welcome email sent');
  };
};

const init = (env: Env) => {
  if (cached !== undefined) return cached;
  try {
    if (!env.DATABASE_URL) {
      cached = null;
    } else {
      const db = createDb(env.DATABASE_URL);
      const onUserCreated = welcomeHook(env);
      cached = { db, auth: createAuth({ db, env, ...(onUserCreated && { onUserCreated }) }) };
    }
  } catch {
    // AuthConfigError: missing secret or base URL. The UI reports "not configured".
    cached = null;
  }
  return cached;
};

/** Server-side auth, or `null` when this deployment is not configured for sign-in. */
export const getAuth = (env: Env = process.env): Auth | null => init(env)?.auth ?? null;

/** The database handle shared with auth, or `null` when sign-in is not configured. */
export const getDb = (env: Env = process.env): Db | null => init(env)?.db ?? null;

/** Providers offered on /sign-in; empty when sign-in is not configured. */
export const signInProviders = (env: Env = process.env): SocialProvider[] =>
  getAuth(env) ? configuredProviders(env) : [];

/** Test hook: forget the cached instance. */
export const resetAuthForTests = () => {
  cached = undefined;
};
