import { createDb } from '@javis-dog/event-store';
import { createIngestDeps, createIngestHandler, type IngestDeps } from '@javis-dog/ingest';
import { createBudgetAlertDeps, processBudgetAlert, type BudgetAlertDeps } from './budget-alerts';

type Env = Readonly<Record<string, string | undefined>>;
type Handler = (request: Request) => Promise<Response>;
/** Runs work after the response is sent — Next.js `after()` in the route. */
export type Schedule = (task: () => Promise<unknown>) => void;

/** Per-process dependencies (database client, repositories, email config); null without a database. */
let cached: { ingest: IngestDeps; alerts: BudgetAlertDeps | null } | null | undefined;

/**
 * The JD-M05 handler, or `null` when this deployment has no database. Independent of sign-in.
 * Budget alerts (ADR-0014) are wired only when email is configured and the caller passes a
 * `schedule`, so the ingest response never waits for them. Only the dependencies are cached;
 * the handler is built per call with that call's `schedule` (it is a cheap, stateless closure).
 */
export const getIngestHandler = (env: Env = process.env, schedule?: Schedule): Handler | null => {
  if (cached === undefined) {
    if (env.DATABASE_URL) {
      const db = createDb(env.DATABASE_URL);
      cached = { ingest: createIngestDeps(db), alerts: createBudgetAlertDeps(db, env) };
    } else {
      cached = null;
    }
  }
  if (!cached) return null;
  const { ingest, alerts } = cached;
  return createIngestHandler({
    ...ingest,
    ...(alerts &&
      schedule && {
        onStored: (scope) => schedule(() => processBudgetAlert(alerts, scope)),
      }),
  });
};

/** Test hook: forget the cached dependencies. */
export const resetIngestForTests = () => {
  cached = undefined;
};
