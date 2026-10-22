# JD-M04 · `@javis-dog/projects` — Project registry

Status: **in-progress**. S1a: draft project model. S2a: Drizzle tables, workspace-scoped repository and hashed ingest tokens (ADR-0005). S2b: ownership and membership (JD-M03).

## Public contract

| Export | Description |
|---|---|
| `ProjectInput` | Zod schema for registration input: `name` (2–80), optional `slug`, `description` (≤ 280), `platforms` (≥ 1), `privacyClass` (default `L0`), optional `repositoryUrl` (https GitHub only) |
| `Project` | Stored project: input + `id`, `slug`, `workspaceId`, `createdAt`, `lastSignalAt` (nullable; set only by a verified JGR signal) |
| `normalizeProjectInput(raw)` | Validate and derive the slug |
| `toSlug(name)` | URL-safe slug (handles Vietnamese diacritics, ≤ 48 chars) |
| `Platform`, `platforms`, `PrivacyClass` | Enums shared with JGR (JD-M01) |
| `WorkspaceInput`, `normalizeWorkspaceInput(raw)` | Workspace name (2–80) and optional slug |
| `workspaces`, `projects`, `ingestTokens`, `projectTables` | Drizzle tables, composed into migrations by JD-M06 |
| `createProjectRepository(db)` | Workspace-scoped persistence: `createWorkspace`, `createProject`, `listProjects`, `getProject`, `issueToken`, `listTokens`, `revokeToken`, `verifyToken` |
| `ProjectRepositoryError` | `code`: `slug_taken`, `not_found`, `token_limit` |
| `MAX_ACTIVE_TOKENS_PER_PROJECT` | 5 (soft limit — no transactions on neon-http) |
| `generateIngestToken()`, `parseIngestToken()`, `hashIngestToken()`, `displayPrefix()`, `INGEST_TOKEN_PREFIX` | Token primitives: `jd_it_` + 43 base64url chars; SHA-256 hex stored |
| `ProjectsDb` | Type of any Drizzle Postgres handle that knows these tables |

## Design notes

- `privacyClass` defaults to **L0** — operational metadata only (product rule 3).
- `lastSignalAt` is never client-writable: freshness must come from the signal path ("Live means verified").
- Ingest tokens: the plaintext is returned once by `issueToken`; only `sha256(token)` and an 8-char display prefix are stored. A composite FK keeps every token inside its project's workspace.
- Every repository method takes `workspaceId`; there is no unscoped read.
