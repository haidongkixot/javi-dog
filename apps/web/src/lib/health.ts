import type { DbPing } from '@javis-dog/event-store';

/** Env vars whose presence the health route reports. Names only — values never leave the server. */
export const HEALTH_ENV_NAMES = [
  'DATABASE_URL',
  'BETTER_AUTH_SECRET',
  'BETTER_AUTH_URL',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'RESEND_API_KEY',
  'EMAIL_FROM',
] as const;

export const DB_TIMEOUT_MS = 3_000;

type DbStatus =
  | { status: 'ok'; latencyMs: number; migrationsApplied: number }
  | { status: 'error' | 'not_configured'; latencyMs: null; migrationsApplied: null };

export interface HealthBody {
  status: 'ok' | 'degraded';
  checkedAt: string;
  deployment: { env: string; commit: string | null };
  env: Record<(typeof HEALTH_ENV_NAMES)[number], boolean>;
  db: DbStatus;
}

export interface HealthDeps {
  env: Readonly<Record<string, string | undefined>>;
  ping: (databaseUrl: string) => Promise<DbPing>;
  now?: () => Date;
  timeoutMs?: number;
}

const present = (value: string | undefined) => typeof value === 'string' && value.trim() !== '';

const withTimeout = <T>(work: Promise<T>, ms: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
};

const checkDb = async (deps: HealthDeps): Promise<DbStatus> => {
  const url = deps.env.DATABASE_URL;
  if (!present(url)) return { status: 'not_configured', latencyMs: null, migrationsApplied: null };
  try {
    const ping = await withTimeout(deps.ping(url!), deps.timeoutMs ?? DB_TIMEOUT_MS);
    return { status: 'ok', ...ping };
  } catch {
    // Driver errors can echo hosts or credentials; report the state only.
    return { status: 'error', latencyMs: null, migrationsApplied: null };
  }
};

/** Builds the `/api/health` response: booleans and status words only (Sprint 2a, Q2). */
export const checkHealth = async (deps: HealthDeps) => {
  const db = await checkDb(deps);
  const env = Object.fromEntries(
    HEALTH_ENV_NAMES.map((name) => [name, present(deps.env[name])]),
  ) as HealthBody['env'];
  const body: HealthBody = {
    status: db.status === 'ok' ? 'ok' : 'degraded',
    checkedAt: (deps.now?.() ?? new Date()).toISOString(),
    deployment: {
      env: deps.env.VERCEL_ENV ?? 'local',
      commit: deps.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
    },
    env,
    db,
  };
  return { httpStatus: db.status === 'ok' ? 200 : 503, body };
};
