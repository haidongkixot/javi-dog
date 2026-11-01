import { createDb, createEventRepository } from '@javis-dog/event-store';
import {
  createGithubRepository,
  createGithubWebhookHandler,
  githubWebhookNotConfigured,
  type GithubWebhookDeps,
} from '@javis-dog/github-bridge';

type Env = Readonly<Record<string, string | undefined>>;
type Handler = (request: Request) => Promise<Response>;

/** The parts of the JD-M10 deps that hold the database; secrets are read per request. */
type StoreDeps = Pick<GithubWebhookDeps, 'store' | 'insertEvents' | 'touchSignal'>;

/** Per-process database wiring; `null` when this deployment has no database. */
let cached: StoreDeps | null | undefined;

/**
 * The JD-M10 webhook handler (ADR-0019 §3) wired to JD-M06 and the JD-M10 repository. Without a
 * database it answers 503 `not_configured`; without `GITHUB_APP_WEBHOOK_SECRET` the handler
 * itself answers 503, even when only the previous secret is set (G13). The secrets are read from
 * `env` on every call, so a rotation needs no new process. `overrides` are for tests only (clock,
 * log capture); production uses the defaults.
 */
export const getGithubWebhookHandler = (
  env: Env = process.env,
  overrides: Pick<GithubWebhookDeps, 'now' | 'log'> = {},
): Handler => {
  if (cached === undefined) {
    if (env.DATABASE_URL) {
      const db = createDb(env.DATABASE_URL);
      const events = createEventRepository(db);
      cached = {
        store: createGithubRepository(db),
        insertEvents: (rows) => events.insertEvents(rows),
        touchSignal: (scope, at) => events.touchSignal(scope, at),
      };
    } else {
      cached = null;
    }
  }
  if (!cached) return async () => githubWebhookNotConfigured();
  return createGithubWebhookHandler({
    ...cached,
    ...overrides,
    secrets: {
      current: env.GITHUB_APP_WEBHOOK_SECRET,
      previous: env.GITHUB_APP_WEBHOOK_SECRET_PREVIOUS,
    },
  });
};

/** Test hook: forget the cached dependencies. */
export const resetGithubWebhookForTests = () => {
  cached = undefined;
};
