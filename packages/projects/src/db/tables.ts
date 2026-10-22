import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// JD-M04 tables (ADR-0005). JD-M06 composes them into the migration schema.
// `workspaces` is shaped so Better Auth's organization plugin can map onto it in S2b.

export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  logo: text('logo'),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description'),
    platforms: text('platforms').array().notNull(),
    privacyClass: text('privacy_class').notNull().default('L0'),
    repositoryUrl: text('repository_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Written only by the verified ingest path (S3), never from user input. */
    lastSignalAt: timestamp('last_signal_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('projects_workspace_slug_key').on(t.workspaceId, t.slug),
    // Target of the composite FK that pins a token to its project's own workspace.
    unique('projects_id_workspace_key').on(t.id, t.workspaceId),
    check('projects_privacy_class_check', sql`${t.privacyClass} in ('L0', 'L1', 'L2')`),
  ],
);

export const ingestTokens = pgTable(
  'ingest_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    name: text('name').notNull(),
    /** SHA-256 hex of the full token. The plaintext is never stored. */
    tokenHash: text('token_hash').notNull().unique(),
    displayPrefix: text('display_prefix').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    // A token can only reference a project inside its own workspace.
    foreignKey({
      name: 'ingest_tokens_project_workspace_fk',
      columns: [t.projectId, t.workspaceId],
      foreignColumns: [projects.id, projects.workspaceId],
    }).onDelete('cascade'),
    index('ingest_tokens_active_project_idx')
      .on(t.projectId)
      .where(sql`${t.revokedAt} is null`),
    check('ingest_tokens_hash_check', sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

/** Every JD-M04 table, for composition by JD-M06. */
export const projectTables = { workspaces, projects, ingestTokens };
