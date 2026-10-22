---
name: tenant-isolation-by-construction
description: Keep multi-tenant data (workspaces, organizations, teams, accounts) isolated by construction rather than by remembering to filter — one function resolves the tenant from the authenticated session plus a membership check and never from request input, every repository method requires the tenant id and no unscoped read exists, foreign or malformed ids answer "not found", and the database itself refuses cross-tenant references through composite foreign keys on denormalized tenant columns. Includes forged-id and raw-SQL negative tests and a review step for generated schema SQL. Use when adding workspaces/organizations/teams to an app, writing server actions or API handlers that take an id, designing tables that carry both a parent id and a tenant id, reviewing an ORM-generated migration, or auditing for IDOR / broken object-level authorization.
metadata:
  version: "0.1.0"
  origin: "javis-dog G2-prep"
  confidence: medium
---

# Tenant isolation by construction

Cross-tenant leaks rarely come from a missing login. They come from an id taken from a form or URL, a list query someone forgot to scope, or a row whose parent lives in another tenant. Code review catches some of these; structure catches more. The goal is that the *easy* way to write a handler is also the isolated way, and that the database rejects what slipped through.

The rule: **the tenant comes from the session, every data call requires it, and the schema cannot represent a cross-tenant link.**

## Forces

- **Convenience vs. trust.** Passing `workspaceId` in a form is easy and wrong: any client can change it.
- **Denormalization vs. integrity.** Copying the tenant id onto child rows makes scoped lookups cheap, and creates a second source of truth that can disagree with the parent.
- **Defense in depth vs. duplication.** Checks in both the application and the database cost a little duplication; each catches what the other misses.

## 1. Resolve the tenant in exactly one function

Write one resolver, for example `resolveTenant(db, userId, sessionActiveTenantId)`:

- Accept the session's "active tenant" **only if** a membership row for (user, tenant) exists; return the tenant id and the member's role.
- Otherwise fall back to a tenant the user does belong to (or deny — choose and document).
- Never read the tenant from request bodies, query strings or path parameters.

Every page, server action and API handler calls a thin wrapper (`getViewer()` → `{ user, tenantId, role, repositories }`) and passes `viewer.tenantId` on. Handlers stay short, and an auditor checks one function instead of every route.

Test it against a real database: a session that claims another user's tenant must *not* get it (forged-id test); a user without an active tenant gets their own.

## 2. Make every data call require the tenant

- Repository methods take `tenantId` as the first argument: `listProjects(tenantId)`, `getProject(tenantId, id)`, `issueToken(tenantId, projectId, …)`, `revokeToken(tenantId, tokenId)`. There is no `getProjectById(id)`.
- Mutations through an id from another tenant behave like "not found" (`null`, `false`, a typed `not_found` error), not like "forbidden" — do not confirm that the id exists.
- Validate id format before querying. Postgres raises on a malformed UUID instead of returning no rows; map malformed ids to the same "not found" response (404 for pages).
- Pages for a foreign id return the framework's not-found response, identical to a non-existent id.

## 3. Let the database refuse cross-tenant links

When a child row carries both `parent_id` and a denormalized `tenant_id`, two independent foreign keys (`parent_id → parent.id`, `tenant_id → tenant.id`) are both satisfied by a row whose parent belongs to **another** tenant. Replace them with a **composite foreign key** `(parent_id, tenant_id) → parent(id, tenant_id)`, backed by a unique constraint on the parent pair. Cascades still flow through the parent. Template with the negative test: [`templates/composite-tenant-fk.sql`](templates/composite-tenant-fk.sql) (verified on PGlite at G2-prep: the cross-tenant insert is rejected with the constraint name; deleting the tenant cascades to the child).

Test it with raw SQL that bypasses the repository: insert a child with a foreign tenant id and expect the constraint name in the error. That proves the guard exists independently of application code.

## 4. Review generated schema SQL for tenancy

ORMs generate migrations from table definitions; read the SQL diff anyway, with one question per table: *can a row here point at something in another tenant?* In the origin, that review — not a test — found the hole in section 3, before any data existed.

## 5. Test matrix (lowest cost first, all on a real SQL engine)

| Case | Expected |
|---|---|
| Same slug/name in two tenants | Both allowed |
| Same slug twice in one tenant | Typed conflict error |
| Tenant B reads or lists tenant A's object by id | `null` / empty |
| Tenant B issues or revokes on A's object | `not_found` / `false`, and A's object unchanged |
| Raw insert of a cross-tenant child | Rejected by the composite FK |
| Session claims a tenant the user is not a member of | Resolver returns the user's own tenant (or denies) |
| Malformed id in URL or form | Same response as unknown id |
| Tenant deleted | Children cascade |

Component tests of pages can mock the viewer; the isolation guarantees themselves belong in integration tests against the database.

## Pitfalls

- **Tenant id in hidden form fields.** Even when the UI never changes it, the client can.
- **"Forbidden" for foreign ids.** It confirms existence; answer "not found".
- **Two FKs instead of one composite.** Each FK is valid alone; together they allow the cross-tenant row.
- **Racing personal-tenant creation.** Creating a default tenant on first session can run twice for simultaneous first sessions; the origin accepted this (rare, visible, harmless) and made creation idempotent for sequential sessions. Decide explicitly.
- **Signed-in flows only testable by a human.** If OAuth cannot run in CI or the agent sandbox, the end-to-end check depends on a person; keep the isolation logic in functions that integration tests reach directly.

## Evidence from origin project

Javi's Dog, Sprints 2a–2c (2026-10-22). Confidence **medium**: implemented and tested once; the owner exercised the signed-in flow on production once; no real multi-tenant traffic yet.

- Composite FK: found by reviewing the generated SQL in S2a (`docs/sprints/SPRINT-02a.md` Log; ADR-0005 *Changes*). Code `packages/projects/src/db/tables.ts` (`ingest_tokens_project_workspace_fk`, `projects_id_workspace_key`), migration `packages/event-store/migrations/0000_*.sql`, raw-SQL test "enforces the cross-workspace rule in the database too" in `packages/event-store/test/repository.test.ts` (`dc6ef61`).
- Scoped repository and isolation tests (read, list, issue, revoke across workspaces; cascade): `packages/projects/src/repository.ts`, `packages/event-store/test/repository.test.ts`.
- Resolver: `resolveWorkspace` in `packages/identity/src/workspace.ts`, forged active-id test in `packages/event-store/test/identity.test.ts`; wrapper `getViewer` and `isUuid` in `apps/web/src/lib/viewer.ts`; server actions in `apps/web/src/app/projects/actions.ts` (`93cc254`). Rule recorded in ADR-0006 and ADR-0007.
- Recorded results: workspace `pnpm test` exit 0, 203 passed (`docs/sprints/SPRINT-02c.md`); CI green on `93cc254`. Owner flow on production (create project, issue token, revoke) and an agent DB check (token in the same workspace as its project) passed (`SPRINT-02c.md`, `2d6b87d`).
- Retro: "the authorization rule lived in one function with a forged-id test, so pages and actions stayed thin" (`SPRINT-02c.md`).
- Hypothesis: that the single-resolver pattern prevents future leaks as handlers multiply — only a handful of handlers exist.
