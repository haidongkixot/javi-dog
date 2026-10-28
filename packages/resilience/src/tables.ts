import { projects } from '@javis-dog/projects';
import { sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

// JD-M12 tables (ADR-0014). Composed into the JD-M06 schema; migrations live there.

/** One optional monthly USD budget per project. */
export const projectBudgets = pgTable(
  'project_budgets',
  {
    projectId: uuid('project_id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    monthlyLimitUsd: numeric('monthly_limit_usd', { precision: 12, scale: 2 }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** The user who last set it (no FK: users may be deleted, the budget stays). */
    updatedBy: uuid('updated_by'),
  },
  (t) => [
    // A budget can only belong to a project inside its own workspace (as events, ADR-0008).
    foreignKey({
      name: 'project_budgets_project_workspace_fk',
      columns: [t.projectId, t.workspaceId],
      foreignColumns: [projects.id, projects.workspaceId],
    }).onDelete('cascade'),
    check(
      'project_budgets_limit_check',
      sql`${t.monthlyLimitUsd} > 0 and ${t.monthlyLimitUsd} <= 1000000`,
    ),
    index('project_budgets_workspace_idx').on(t.workspaceId),
  ],
);

/** One row per (project, UTC month, threshold): claimed before sending, exactly once. */
export const budgetAlerts = pgTable(
  'budget_alerts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** First day of the UTC month. */
    month: date('month', { mode: 'string' }).notNull(),
    threshold: smallint('threshold').notNull(),
    /** pending (claimed, sending) · sent · failed (retry later) · covered (a higher one was sent). */
    status: text('status').notNull().default('pending'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(1),
  },
  (t) => [
    unique('budget_alerts_project_month_threshold_key').on(t.projectId, t.month, t.threshold),
    check('budget_alerts_threshold_check', sql`${t.threshold} in (80, 100)`),
    check(
      'budget_alerts_status_check',
      sql`${t.status} in ('pending', 'sent', 'failed', 'covered')`,
    ),
  ],
);

export const budgetTables = { projectBudgets, budgetAlerts };
