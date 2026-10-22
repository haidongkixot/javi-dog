import { createDb } from '@javis-dog/event-store';
import {
  configuredProviders,
  createAuth,
  type Auth,
  type SocialProvider,
} from '@javis-dog/identity';

type Env = Readonly<Record<string, string | undefined>>;

let cached: Auth | null | undefined;

/** Server-side auth, or `null` when this deployment is not configured for sign-in. */
export const getAuth = (env: Env = process.env): Auth | null => {
  if (cached !== undefined) return cached;
  try {
    cached = env.DATABASE_URL ? createAuth({ db: createDb(env.DATABASE_URL), env }) : null;
  } catch {
    // AuthConfigError: missing secret or base URL. The UI reports "not configured".
    cached = null;
  }
  return cached;
};

/** Providers offered on /sign-in; empty when sign-in is not configured. */
export const signInProviders = (env: Env = process.env): SocialProvider[] =>
  getAuth(env) ? configuredProviders(env) : [];

/** Test hook: forget the cached instance. */
export const resetAuthForTests = () => {
  cached = undefined;
};
