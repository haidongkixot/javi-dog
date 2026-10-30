import { and, count, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { ingestTokens, projects, projectTables, workspaces } from './db/tables.ts';
import { normalizeProjectInput, normalizeWorkspaceInput, PrivacyClass } from './schema.ts';
import { displayPrefix, generateIngestToken, hashIngestToken, parseIngestToken } from './tokens.ts';

/** Any Drizzle Postgres handle that knows the JD-M04 tables (neon-http in the app, PGlite in tests). */
export type ProjectsDb = PgDatabase<PgQueryResultHKT, typeof projectTables>;

export const MAX_ACTIVE_TOKENS_PER_PROJECT = 5;
/** Projects one workspace may hold (S5a M1, owner decision 2026-10-28). */
export const MAX_PROJECTS_PER_WORKSPACE = 20;
/**
 * Ingest tokens one project may issue per rolling 24 h by the database clock, revoked ones
 * included, so issue-then-revoke cannot loop (S5a M1). The active cap above still applies.
 */
export const MAX_TOKENS_ISSUED_PER_PROJECT_PER_DAY = 10;

export type ProjectRepositoryErrorCode =
  'slug_taken' | 'not_found' | 'token_limit' | 'project_limit' | 'token_issue_limit';

export class ProjectRepositoryError extends Error {
  readonly code: ProjectRepositoryErrorCode;
  constructor(code: ProjectRepositoryErrorCode) {
    super(code);
    this.code = code;
    this.name = 'ProjectRepositoryError';
  }
}

// Drizzle wraps driver errors; walk the cause chain for the Postgres SQLSTATE.
const isUniqueViolation = (error: unknown): boolean => {
  let e: unknown = error;
  for (let depth = 0; e && typeof e === 'object' && depth < 5; depth++) {
    if ((e as { code?: unknown }).code === '23505') return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
};

const tokenView = {
  id: ingestTokens.id,
  projectId: ingestTokens.projectId,
  name: ingestTokens.name,
  displayPrefix: ingestTokens.displayPrefix,
  createdAt: ingestTokens.createdAt,
  lastUsedAt: ingestTokens.lastUsedAt,
  revokedAt: ingestTokens.revokedAt,
};

/**
 * JD-M04 persistence. Every method is scoped by `workspaceId`; there is no unscoped read.
 * Uses single statements only (neon-http has no interactive transactions).
 */
export const createProjectRepository = (db: ProjectsDb) => {
  const findProject = async (workspaceId: string, projectId: string) => {
    const [row] = await db
      .select()
      .from(projects)
      .where(and(eq(projects.workspaceId, workspaceId), eq(projects.id, projectId)));
    return row ?? null;
  };

  return {
    async createWorkspace(raw: unknown) {
      const input = normalizeWorkspaceInput(raw);
      try {
        const [row] = await db.insert(workspaces).values(input).returning();
        return row!;
      } catch (error) {
        if (isUniqueViolation(error)) throw new ProjectRepositoryError('slug_taken');
        throw error;
      }
    },

    async createProject(workspaceId: string, raw: unknown) {
      const input = normalizeProjectInput(raw);
      // Soft cap like the token caps: a concurrent create may briefly exceed it (no
      // transactions on neon-http).
      const [held] = await db
        .select({ n: count() })
        .from(projects)
        .where(eq(projects.workspaceId, workspaceId));
      if ((held?.n ?? 0) >= MAX_PROJECTS_PER_WORKSPACE) {
        throw new ProjectRepositoryError('project_limit');
      }
      try {
        const [row] = await db
          .insert(projects)
          .values({
            workspaceId,
            name: input.name,
            slug: input.slug,
            description: input.description ?? null,
            platforms: input.platforms,
            privacyClass: input.privacyClass,
            repositoryUrl: input.repositoryUrl ?? null,
          })
          .returning();
        return row!;
      } catch (error) {
        if (isUniqueViolation(error)) throw new ProjectRepositoryError('slug_taken');
        throw error;
      }
    },

    listProjects: (workspaceId: string) =>
      db
        .select()
        .from(projects)
        .where(eq(projects.workspaceId, workspaceId))
        .orderBy(projects.createdAt, projects.id),

    getProject: findProject,

    /**
     * Sets a project's privacy class (ADR-0018 §7): one existing column, no migration. Scoped by
     * `workspaceId`; returns the updated `{ id, privacyClass }` or `null` when the project is
     * not in this workspace. Throws a ZodError for a value outside `L0`, `L1`, `L2`.
     * Callers decide who may change it (owners and admins) and how a raise is confirmed (the
     * browser key setup flow); this method never sees a key.
     */
    async setPrivacyClass(workspaceId: string, projectId: string, raw: unknown) {
      const privacyClass = PrivacyClass.parse(raw);
      const [row] = await db
        .update(projects)
        .set({ privacyClass })
        .where(and(eq(projects.workspaceId, workspaceId), eq(projects.id, projectId)))
        .returning({ id: projects.id, privacyClass: projects.privacyClass });
      return row ?? null;
    },

    /** Returns the plaintext token once. Callers must show it and then drop it. */
    async issueToken(workspaceId: string, projectId: string, name: string) {
      const project = await findProject(workspaceId, projectId);
      if (!project) throw new ProjectRepositoryError('not_found');
      // Soft limits: a concurrent issue may briefly exceed them (no transactions on neon-http).
      // One read for both; the 24 h window uses the database clock, not this instance's.
      const [used] = await db
        .select({
          active: sql<number>`count(*) filter (where ${ingestTokens.revokedAt} is null)`.mapWith(
            Number,
          ),
          issuedToday:
            sql<number>`count(*) filter (where ${ingestTokens.createdAt} > now() - interval '24 hours')`.mapWith(
              Number,
            ),
        })
        .from(ingestTokens)
        .where(eq(ingestTokens.projectId, projectId));
      // The daily cap first: revoking a token does not lift it, so its message is the useful one.
      if ((used?.issuedToday ?? 0) >= MAX_TOKENS_ISSUED_PER_PROJECT_PER_DAY) {
        throw new ProjectRepositoryError('token_issue_limit');
      }
      if ((used?.active ?? 0) >= MAX_ACTIVE_TOKENS_PER_PROJECT) {
        throw new ProjectRepositoryError('token_limit');
      }
      const token = generateIngestToken();
      const [row] = await db
        .insert(ingestTokens)
        .values({
          projectId,
          workspaceId,
          name: name.trim().slice(0, 80) || 'Ingest token',
          tokenHash: await hashIngestToken(token),
          displayPrefix: displayPrefix(token),
        })
        .returning(tokenView);
      return { token, record: row! };
    },

    listTokens: (workspaceId: string, projectId: string) =>
      db
        .select(tokenView)
        .from(ingestTokens)
        .where(
          and(eq(ingestTokens.workspaceId, workspaceId), eq(ingestTokens.projectId, projectId)),
        )
        .orderBy(ingestTokens.createdAt, ingestTokens.id),

    /** Idempotent; returns false when the token does not exist in this workspace. */
    async revokeToken(workspaceId: string, tokenId: string) {
      const [row] = await db
        .select({ revokedAt: ingestTokens.revokedAt })
        .from(ingestTokens)
        .where(and(eq(ingestTokens.workspaceId, workspaceId), eq(ingestTokens.id, tokenId)));
      if (!row) return false;
      if (!row.revokedAt) {
        await db
          .update(ingestTokens)
          .set({ revokedAt: new Date() })
          .where(and(eq(ingestTokens.workspaceId, workspaceId), eq(ingestTokens.id, tokenId)));
      }
      return true;
    },

    /**
     * Resolves a presented token to its scope, or `null` for malformed, unknown or revoked tokens.
     * The project's slug and privacy class let the ingest path check `project_ref` and the
     * opt-in privacy ceiling (ADR-0008).
     */
    async verifyToken(raw: unknown) {
      if (!parseIngestToken(raw)) return null;
      const [row] = await db
        .select({
          tokenId: ingestTokens.id,
          projectId: ingestTokens.projectId,
          workspaceId: ingestTokens.workspaceId,
          projectSlug: projects.slug,
          privacyClass: projects.privacyClass,
        })
        .from(ingestTokens)
        .innerJoin(
          projects,
          and(
            eq(projects.id, ingestTokens.projectId),
            eq(projects.workspaceId, ingestTokens.workspaceId),
          ),
        )
        .where(
          and(
            eq(ingestTokens.tokenHash, await hashIngestToken(raw as string)),
            isNull(ingestTokens.revokedAt),
          ),
        );
      return row ?? null;
    },

    /**
     * Written only by the verified ingest path (ADR-0005, ADR-0008). At most once a minute per
     * token (S3d H2): busy collectors do not rewrite the token row on every batch.
     */
    async markTokenUsed(tokenId: string, at: Date) {
      const minuteAgo = new Date(at.getTime() - 60_000);
      await db
        .update(ingestTokens)
        .set({ lastUsedAt: at })
        .where(
          and(
            eq(ingestTokens.id, tokenId),
            or(isNull(ingestTokens.lastUsedAt), lt(ingestTokens.lastUsedAt, minuteAgo)),
          ),
        );
    },
  };
};

export type ProjectRepository = ReturnType<typeof createProjectRepository>;
