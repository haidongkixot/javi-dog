import { and, count, eq, isNull } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { ingestTokens, projects, projectTables, workspaces } from './db/tables.ts';
import { normalizeProjectInput, normalizeWorkspaceInput } from './schema.ts';
import { displayPrefix, generateIngestToken, hashIngestToken, parseIngestToken } from './tokens.ts';

/** Any Drizzle Postgres handle that knows the JD-M04 tables (neon-http in the app, PGlite in tests). */
export type ProjectsDb = PgDatabase<PgQueryResultHKT, typeof projectTables>;

export const MAX_ACTIVE_TOKENS_PER_PROJECT = 5;

export type ProjectRepositoryErrorCode = 'slug_taken' | 'not_found' | 'token_limit';

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

    /** Returns the plaintext token once. Callers must show it and then drop it. */
    async issueToken(workspaceId: string, projectId: string, name: string) {
      const project = await findProject(workspaceId, projectId);
      if (!project) throw new ProjectRepositoryError('not_found');
      // Soft limit: a concurrent issue may briefly exceed it (no transactions on neon-http).
      const [active] = await db
        .select({ n: count() })
        .from(ingestTokens)
        .where(and(eq(ingestTokens.projectId, projectId), isNull(ingestTokens.revokedAt)));
      if ((active?.n ?? 0) >= MAX_ACTIVE_TOKENS_PER_PROJECT) {
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

    /** Written only by the verified ingest path after a stored event (ADR-0005, ADR-0008). */
    async markTokenUsed(tokenId: string, at: Date) {
      await db.update(ingestTokens).set({ lastUsedAt: at }).where(eq(ingestTokens.id, tokenId));
    },
  };
};

export type ProjectRepository = ReturnType<typeof createProjectRepository>;
