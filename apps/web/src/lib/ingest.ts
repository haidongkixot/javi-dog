import { createDb } from '@javis-dog/event-store';
import { createIngestDeps, createIngestHandler } from '@javis-dog/ingest';
import { createBudgetAlertDeps, processBudgetAlert } from './budget-alerts';

type Env = Readonly<Record<string, string | undefined>>;
type Handler = (request: Request) => Promise<Response>;
/** Runs work after the response is sent — Next.js `after()` in the route. */
export type Schedule = (task: () => Promise<unknown>) => void;

let cached: Handler | null | undefined;

/**
 * The JD-M05 handler, or `null` when this deployment has no database. Independent of sign-in.
 * Budget alerts (ADR-0014) are wired only when email is configured; they are scheduled with
 * `schedule` so the ingest response never waits for them. The handler is cached, so the first
 * caller's `schedule` is kept (the route always passes `after`).
 */
export const getIngestHandler = (env: Env = process.env, schedule?: Schedule): Handler | null => {
  if (cached !== undefined) return cached;
  if (!env.DATABASE_URL) {
    cached = null;
    return cached;
  }
  const db = createDb(env.DATABASE_URL);
  const alerts = schedule ? createBudgetAlertDeps(db, env) : null;
  cached = createIngestHandler({
    ...createIngestDeps(db),
    ...(alerts &&
      schedule && {
        onStored: (scope) => schedule(() => processBudgetAlert(alerts, scope)),
      }),
  });
  return cached;
};

/** Test hook: forget the cached handler. */
export const resetIngestForTests = () => {
  cached = undefined;
};
