import type { Db } from '@javis-dog/event-store';
import {
  createBudgetRepository,
  MAX_MONTHLY_LIMIT_USD,
  type BudgetStatus,
} from '@javis-dog/resilience';
import { z } from 'zod';
import { getDb } from './auth';
import { canManageProject } from './permissions';
import { getViewer } from './viewer';

/** The part of the JD-M12 repository the web app uses (ADR-0014). */
export interface BudgetStore {
  status: (workspaceId: string, projectId: string) => Promise<BudgetStatus | null>;
  statuses: (workspaceId: string) => Promise<BudgetStatus[]>;
  setBudget: (
    workspaceId: string,
    projectId: string,
    limitUsd: number,
    userId: string,
  ) => Promise<void>;
  clearBudget: (workspaceId: string, projectId: string) => Promise<void>;
}

/**
 * Injectable dependencies, mirroring `AnalyticsDeps` (lib/analytics.ts). The workspace comes
 * from `getViewer` (session + membership) only; nothing here reads request input.
 */
export interface BudgetDeps<D> {
  getViewer: () => Promise<{ workspaceId: string } | null>;
  getDb: () => D | null;
  repository: (db: D) => BudgetStore;
}

/** Production wiring: session + membership, the shared database handle and the JD-M12 repository. */
export const budgetDeps: BudgetDeps<Db> = {
  getViewer,
  getDb: () => getDb(),
  repository: (db) => createBudgetRepository(db),
};

/**
 * A monthly limit in US dollars as typed in the form: digits with at most 2 decimals ("12",
 * "12.5", "12.50"), more than 0 and at most 1 000 000. Exponents ("1e3"), signs, separators
 * and currency symbols are refused rather than guessed.
 */
export const budgetLimitSchema = z
  .string()
  .trim()
  .min(1, 'Enter a monthly limit in US dollars.')
  .regex(/^\d+(\.\d{1,2})?$/, 'Use a plain amount like 25 or 25.50 (at most 2 decimals).')
  .transform(Number)
  .pipe(
    z
      .number()
      .gt(0, 'The limit must be more than 0.')
      .lte(MAX_MONTHLY_LIMIT_USD, 'The limit can be at most 1,000,000.'),
  );

/** Workspace roles that may set or clear a budget (ADR-0014); same rule as projects. */
export const canManageBudget = canManageProject;

export type BudgetLoad =
  | { kind: 'not_configured' }
  | { kind: 'signed_out' }
  | { kind: 'ready'; status: BudgetStatus }
  | { kind: 'unavailable' };

export type BudgetsLoad =
  | { kind: 'not_configured' }
  | { kind: 'signed_out' }
  | { kind: 'ready'; statuses: BudgetStatus[] }
  | { kind: 'unavailable' };

const logFailure = (msg: string, error: unknown) =>
  console.error(
    JSON.stringify({
      level: 'error',
      module: 'JD-APP',
      msg,
      // The name only: driver messages can echo hosts or credentials.
      error: error instanceof Error ? error.name : typeof error,
    }),
  );

/**
 * The budget status of one project for the signed-in viewer. Callers pass `projectId` only
 * from a project they already loaded scoped to the viewer's workspace; the repository checks
 * the workspace again and answers null for a project outside it, shown as "unavailable".
 * Without a database "not configured" is decided first and the session is never looked up.
 */
export const loadBudget = async <D>(
  deps: BudgetDeps<D>,
  projectId: string,
): Promise<BudgetLoad> => {
  const db = deps.getDb();
  if (!db) return { kind: 'not_configured' };
  try {
    // The session lookup reads the database too: its failure is "unavailable", not a crash.
    const viewer = await deps.getViewer();
    if (!viewer) return { kind: 'signed_out' };
    const status = await deps.repository(db).status(viewer.workspaceId, projectId);
    return status ? { kind: 'ready', status } : { kind: 'unavailable' };
  } catch (error) {
    logFailure('budget status failed', error);
    return { kind: 'unavailable' };
  }
};

/** Budget status of every project with a budget in the viewer's workspace (projects list). */
export const loadBudgets = async <D>(deps: BudgetDeps<D>): Promise<BudgetsLoad> => {
  const db = deps.getDb();
  if (!db) return { kind: 'not_configured' };
  try {
    const viewer = await deps.getViewer();
    if (!viewer) return { kind: 'signed_out' };
    return { kind: 'ready', statuses: await deps.repository(db).statuses(viewer.workspaceId) };
  } catch (error) {
    logFailure('budget statuses failed', error);
    return { kind: 'unavailable' };
  }
};
