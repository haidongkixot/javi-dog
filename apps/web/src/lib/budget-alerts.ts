import { sendBudgetAlertEmail, type SendConfig } from '@javis-dog/notify';
import {
  createBudgetRepository,
  type BudgetDb,
  type BudgetRepository,
} from '@javis-dog/resilience';

type Env = Readonly<Record<string, string | undefined>>;
type Scope = { workspaceId: string; projectId: string };

export interface BudgetAlertDeps {
  budgets: Pick<BudgetRepository, 'claimAlert' | 'markAlert'>;
  mail: SendConfig;
}

export type BudgetAlertOutcome = 'none' | 'sent' | 'failed' | 'error';

/** Minimal structured log: never addresses, never amounts, never driver messages. */
const log = (
  level: 'info' | 'error',
  msg: string,
  fields: { threshold?: number; outcome: BudgetAlertOutcome; errors?: string[] },
) => console[level](JSON.stringify({ level, module: 'JD-APP', msg, ...fields }));

const errorName = (error: unknown) => (error instanceof Error ? error.name : typeof error);

/**
 * ADR-0014 alert on ingest: claim at most one alert for the project (exactly once per
 * project, UTC month and threshold), email each workspace owner separately, then record the
 * outcome. `sent` only when every owner's email was accepted; otherwise `failed`, so a later
 * usage report retries it (up to the repository's attempt limit). Never throws: it runs in
 * Next.js `after()`, outside the ingest response.
 */
export const processBudgetAlert = async (
  deps: BudgetAlertDeps,
  scope: Scope,
): Promise<BudgetAlertOutcome> => {
  let job;
  try {
    job = await deps.budgets.claimAlert(scope);
  } catch (error) {
    log('error', 'budget alert claim failed', { outcome: 'error', errors: [errorName(error)] });
    return 'error';
  }
  if (!job) return 'none';

  let errors: string[];
  if (job.recipients.length === 0) {
    errors = ['NoRecipients'];
  } else {
    try {
      errors = (await sendBudgetAlertEmail(deps.mail, job)).errors.map(errorName);
    } catch (error) {
      errors = [errorName(error)];
    }
  }
  const outcome = errors.length === 0 ? 'sent' : 'failed';

  try {
    await deps.budgets.markAlert(job.alertId, outcome);
  } catch (error) {
    log('error', 'budget alert mark failed', {
      threshold: job.threshold,
      outcome,
      errors: [...errors, errorName(error)],
    });
    return outcome;
  }
  log(outcome === 'sent' ? 'info' : 'error', `budget alert ${outcome}`, {
    threshold: job.threshold,
    outcome,
    ...(errors.length > 0 && { errors }),
  });
  return outcome;
};

/**
 * Production deps, or `null` when email is not configured (RESEND_API_KEY, EMAIL_FROM,
 * BETTER_AUTH_URL as the app URL). Without email nothing is claimed, so alerts still go out
 * once email is configured and the next usage report arrives.
 */
export const createBudgetAlertDeps = (db: BudgetDb, env: Env): BudgetAlertDeps | null => {
  const { RESEND_API_KEY, EMAIL_FROM, BETTER_AUTH_URL } = env;
  if (!RESEND_API_KEY || !EMAIL_FROM || !BETTER_AUTH_URL) return null;
  return {
    budgets: createBudgetRepository(db),
    mail: { apiKey: RESEND_API_KEY, from: EMAIL_FROM, appUrl: BETTER_AUTH_URL },
  };
};
