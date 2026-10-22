# JD-M03 · `@javis-dog/identity` — Sign-in, users and workspace membership

Status: **in-progress**. S2b: Better Auth 1.7 with GitHub and Google, organization plugin mapped onto JD-M04 `workspaces`, personal workspace on first sign-in (ADR-0006).

## Public contract

| Export | Description |
|---|---|
| `createAuth({ db, env })` | Better Auth instance (server only). Throws `AuthConfigError` without a ≥ 32-char secret or a base URL |
| `configuredProviders(env)` | `github` / `google` when both id and secret are set |
| `ensurePersonalWorkspace(db, userId)` | Returns the user's first workspace, creating `<name>'s workspace` with role `owner` if none |
| `personalWorkspaceName(name)` | Workspace name rule |
| `users`, `sessions`, `accounts`, `verifications`, `workspaceMembers`, `invitations`, `identityTables` | Drizzle tables, composed into migrations by JD-M06 |
| `Auth`, `AuthEnv`, `SocialProvider`, `WorkspaceRole` | Types |

## Design notes

- Telemetry off; OAuth tokens encrypted at rest; scopes at provider defaults (name, email, avatar).
- Integration tests (PGlite, real migrations) live in `packages/event-store/test/identity.test.ts`.
