import { createDb } from '@javis-dog/event-store';
import { createIngestDeps, createIngestHandler } from '@javis-dog/ingest';

type Env = Readonly<Record<string, string | undefined>>;
type Handler = (request: Request) => Promise<Response>;

let cached: Handler | null | undefined;

/** The JD-M05 handler, or `null` when this deployment has no database. Independent of sign-in. */
export const getIngestHandler = (env: Env = process.env): Handler | null => {
  if (cached !== undefined) return cached;
  cached = env.DATABASE_URL
    ? createIngestHandler(createIngestDeps(createDb(env.DATABASE_URL)))
    : null;
  return cached;
};

/** Test hook: forget the cached handler. */
export const resetIngestForTests = () => {
  cached = undefined;
};
