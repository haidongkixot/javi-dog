# ADR-0006: Identity — Better Auth on JD-M04 workspaces, personal workspace on first sign-in

- Status: Accepted 2026-10-22 (implemented in S2b)
- Date: 2026-10-22
- Deciders: Project owner (Hai), Claude (implementer)
- Modules: JD-M03 (new), JD-M04, JD-M06, JD-APP

## Context and problem statement

S2b adds sign-in with GitHub and Google (ADR-0002: Better Auth). Workspaces already exist as a JD-M04 table (ADR-0005). We need users, sessions, memberships and roles without a second workspace model, on Neon's HTTP driver (no interactive transactions), with privacy by minimization.

## Considered options

1. Better Auth organization plugin with its own `organization` table, synced to `workspaces`.
2. **Better Auth organization plugin mapped directly onto `workspaces`** via the drizzle adapter schema (`organization: workspaces`, `member: workspaceMembers`).
3. Own membership tables outside Better Auth.

## Decision outcome

Chosen: **option 2**.

- **Tables (JD-M03):** `users`, `sessions`, `accounts`, `verifications`, `workspace_members`, `invitations`. JS property names follow Better Auth field names (`organizationId` → SQL `workspace_id`, `activeOrganizationId` → `active_workspace_id`), so no field mapping is configured. `workspaces.updated_at` added for the plugin. JD-M06 composes the tables; migration `0001`.
- **Better Auth 1.7.7** (newest 1.7.x older than two weeks; npm advisory DB had no entries for 1.7.7 or 1.7.12 on 2026-10-22). `advanced.database.generateId: "uuid"`, drizzle adapter `transaction: false`.
- **Personal workspace:** a `session.create.before` hook calls `ensurePersonalWorkspace`: if the user has no membership it creates `<first name>'s workspace` and an `owner` membership, then sets the session's active workspace. Running on every session (not only on user creation) makes it self-healing when a first attempt fails; two simultaneous first sessions could create two workspaces (accepted, rare, visible).
- **Roles:** the plugin's `owner` / `admin` / `member`. In S2b every user owns exactly one personal workspace; invitations and role management UI are later work. JD-M04 repository calls take `workspaceId`; JD-APP must derive it from the session's active workspace **and** a membership check, never from client input alone (S2c).
- **Privacy and security:** provider scopes stay at defaults (GitHub `read:user user:email`; Google `openid email profile`). OAuth access/refresh tokens are stored with `account.encryptOAuthTokens: true` (confirmed on the first real rows: hex ciphertext, no `gho_`/`ya29.` prefixes). The provider `id_token` is **not stored** — encryption does not cover it and it carries name/email/avatar; account hooks set it to `null` (found on the first Google row, fixed 2026-10-22). Better Auth telemetry is **off**. IP tracking stays **on** because Better Auth's rate limiting keys on it; sessions keep `ip_address` / `user_agent` as security metadata.
- **Sign-up is open** to any GitHub/Google account. Production reads the `dev-agent` branch until S5 (Q5 = A), so accounts created now are development data.
- **Not configured → honest UI:** without `DATABASE_URL`, a ≥ 32-char `BETTER_AUTH_SECRET` or `BETTER_AUTH_URL`, `/api/auth/*` returns 503 `auth_not_configured` and `/sign-in` says sign-in is not configured. Providers appear only when both id and secret exist.

## Consequences

- Positive: one workspace model; membership and roles come from a maintained library; tests cover redirect URLs, workspace creation, idempotency, isolation and cascades on PGlite.
- Negative: the session hook adds one or two queries to each sign-in; Better Auth upgrades must be checked against the mapped columns (CI drift check + tests).
- Follow-up: S2c uses the active workspace for project CRUD and ingest-token UI, and sends the JD-M09 welcome email; an allowlist or invite-only mode can be added if open sign-up becomes a problem.
