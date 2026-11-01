import { projects, workspaces } from '@javis-dog/projects';
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

// JD-M10 tables (ADR-0019 §4, D0 H2/H3/M4/M5). Composed into the JD-M06 schema; migration 0006
// lives there. Rows come only from signed `installation*` deliveries and owner actions.

/** One row per GitHub App installation. `account_*` are GitHub numeric ids, never logins. */
export const githubInstallations = pgTable(
  'github_installations',
  {
    installationId: bigint('installation_id', { mode: 'number' }).primaryKey(),
    accountId: bigint('account_id', { mode: 'number' }).notNull(),
    accountType: text('account_type').notNull(),
    /** The workspace that claimed it (first claim wins, D0 M5); cleared with the workspace. */
    claimedWorkspaceId: uuid('claimed_workspace_id').references(() => workspaces.id, {
      onDelete: 'set null',
    }),
    suspendedAt: timestamp('suspended_at', { withTimezone: true }),
    /** Evidence for "Connected" (D0 M4): the last verified delivery stored for it. */
    lastVerifiedDeliveryAt: timestamp('last_verified_delivery_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Target of the composite FK that pins a repository link to the claiming workspace (D0 H3).
    unique('github_installations_installation_workspace_key').on(
      t.installationId,
      t.claimedWorkspaceId,
    ),
    check(
      'github_installations_account_type_check',
      sql`${t.accountType} in ('User', 'Organization')`,
    ),
    index('github_installations_workspace_idx').on(t.claimedWorkspaceId),
  ],
);

/**
 * One row per repository an installation can see. `full_name` lives only here (never in events).
 * The link is (`project_id`, `workspace_id`): both set or both null.
 */
export const githubRepositories = pgTable(
  'github_repositories',
  {
    repoId: bigint('repo_id', { mode: 'number' }).primaryKey(),
    installationId: bigint('installation_id', { mode: 'number' })
      .notNull()
      .references(() => githubInstallations.installationId, { onDelete: 'cascade' }),
    fullName: text('full_name').notNull(),
    workspaceId: uuid('workspace_id'),
    projectId: uuid('project_id'),
    /** When and by whom the current link was made; meaningful only while `project_id` is set. */
    linkedAt: timestamp('linked_at', { withTimezone: true }),
    /** The linking user (no FK: users may be deleted, the link stays). */
    linkedBy: uuid('linked_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // A link can only name a project of its own workspace; deleting the project (or its
    // workspace) clears the link and keeps the repository row (D0 H3).
    foreignKey({
      name: 'github_repositories_project_workspace_fk',
      columns: [t.projectId, t.workspaceId],
      foreignColumns: [projects.id, projects.workspaceId],
    }).onDelete('set null'),
    // ...and only inside the workspace that claimed the installation (D0 H3).
    foreignKey({
      name: 'github_repositories_installation_workspace_fk',
      columns: [t.installationId, t.workspaceId],
      foreignColumns: [githubInstallations.installationId, githubInstallations.claimedWorkspaceId],
    }),
    check(
      'github_repositories_link_check',
      sql`(${t.projectId} is null) = (${t.workspaceId} is null)`,
    ),
    index('github_repositories_installation_idx').on(t.installationId),
    index('github_repositories_project_workspace_idx').on(t.projectId, t.workspaceId),
  ],
);

/**
 * Raw-body SHA-256 of every verified delivery: replay and redelivery dedupe (D0 H2).
 * `activity` hashes (runs, suites, PRs) are purged after 3 days: older bodies are refused by the
 * 3-day rule anyway (D0 H4). `installation` hashes (`installation*`, exempt from that rule) are
 * kept for good, so a captured `removed` / `suspend` / `created` body can never be replayed;
 * they are not deleted with their installation either, or an old `created` body could
 * resurrect it.
 */
export const githubDeliveries = pgTable(
  'github_deliveries',
  {
    bodySha256: text('body_sha256').primaryKey(),
    kind: text('kind').notNull().default('activity'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('github_deliveries_body_sha256_check', sql`${t.bodySha256} ~ '^[0-9a-f]{64}$'`),
    check('github_deliveries_kind_check', sql`${t.kind} in ('activity', 'installation')`),
    // Only activity hashes are ever purged by age.
    index('github_deliveries_activity_received_idx')
      .on(t.receivedAt)
      .where(sql`${t.kind} = 'activity'`),
  ],
);

/** Every JD-M10 table, for composition by JD-M06. */
export const githubTables = { githubInstallations, githubRepositories, githubDeliveries };
