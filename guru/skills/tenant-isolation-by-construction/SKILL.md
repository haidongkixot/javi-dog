---
name: tenant-isolation-by-construction
description: Keep multi-tenant data (workspaces, organizations, teams, accounts) isolated by construction rather than by remembering to filter — one function resolves the tenant from the authenticated session plus a membership check and never from request input, every repository method requires the tenant id and no unscoped read exists, foreign or malformed ids answer "not found", and the database itself refuses cross-tenant references through composite foreign keys on denormalized tenant columns. Includes forged-id and raw-SQL negative tests and a review step for generated schema SQL. Use when adding workspaces/organizations/teams to an app, writing server actions or API handlers that take an id, designing tables that carry both a parent id and a tenant id, reviewing an ORM-generated migration, adding a read model, analytics query or notification fan-out over tenant data, deciding where database tests live when modules own tables, or auditing for IDOR / broken object-level authorization.
metadata:
  version: "0.2.0"
  origin: "javis-dog G2-prep; updated G3"
  confidence: "medium (resolver, scoped repositories and composite keys applied in five modules; tenant-filter mutations fail exactly the isolation vectors in two suites); low (real multi-tenant traffic: none yet)"
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

Apply it to **every new table that carries both a parent id and a tenant id** — the rule does not transfer by itself. In the origin a later iteration's first draft of a new tenant-scoped table again used a plain FK and was caught at design time. A child table that carries only the parent id (no denormalized tenant column) is safe with a plain FK to the parent; the tenant is reached through the parent.

## 4. Review generated schema SQL for tenancy

ORMs generate migrations from table definitions; read the SQL diff anyway, with one question per table: *can a row here point at something in another tenant?* In the origin, that review — not a test — found the hole in section 3, before any data existed.

## 5. Read models, analytics and fan-out

- Every query of a read model filters by the tenant, including the clock and count queries. Prove it with a **mutation**: remove the tenant filters and expect exactly the isolation vectors to fail (see `independent-conformance-vectors`).
- A filter id from input (`projectId` in a query string) that is malformed or belongs to another tenant yields an empty result **without a query** — the same response as an unknown id.
- Notification recipients come from the tenant's verified owners at send time, never from input; one message per recipient so addresses are not shared.
- Write paths behind server actions check the role (owner/admin) inside the action, not only by hiding the form.

## 6. Where database tests live when modules own tables

If a store module composes tables owned by other modules, those modules cannot depend on the store without a cycle. Keep the table-owning module's unit tests pure and put its database integration tests in the store module, which already depends on it. Read-only modules that only query the store may depend on it and keep their own database tests.

## 7. Test matrix (lowest cost first, all on a real SQL engine)

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
- **A rule learned once, not applied to the next table.** Review every new tenant-scoped table with the section 3 question.
- **Signed-in flows only testable by a human.** If OAuth cannot run in CI or the agent sandbox, the end-to-end check depends on a person; keep the isolation logic in functions that integration tests reach directly.

## Evidence from origin project

Javi's Dog, Sprints 2a–2c (2026-10-22). Confidence **medium**: implemented and tested once; the owner exercised the signed-in flow on production once; no real multi-tenant traffic yet.

- Composite FK: found by reviewing the generated SQL in S2a (`docs/sprints/SPRINT-02a.md` Log; ADR-0005 *Changes*). Code `packages/projects/src/db/tables.ts` (`ingest_tokens_project_workspace_fk`, `projects_id_workspace_key`), migration `packages/event-store/migrations/0000_*.sql`, raw-SQL test "enforces the cross-workspace rule in the database too" in `packages/event-store/test/repository.test.ts` (`dc6ef61`).
- Scoped repository and isolation tests (read, list, issue, revoke across workspaces; cascade): `packages/projects/src/repository.ts`, `packages/event-store/test/repository.test.ts`.
- Resolver: `resolveWorkspace` in `packages/identity/src/workspace.ts`, forged active-id test in `packages/event-store/test/identity.test.ts`; wrapper `getViewer` and `isUuid` in `apps/web/src/lib/viewer.ts`; server actions in `apps/web/src/app/projects/actions.ts` (`93cc254`). Rule recorded in ADR-0006 and ADR-0007.
- Recorded results: workspace `pnpm test` exit 0, 203 passed (`docs/sprints/SPRINT-02c.md`); CI green on `93cc254`. Owner flow on production (create project, issue token, revoke) and an agent DB check (token in the same workspace as its project) passed (`SPRINT-02c.md`, `2d6b87d`).
- Retro: "the authorization rule lived in one function with a forged-id test, so pages and actions stayed thin" (`SPRINT-02c.md`).
- Hypothesis: that the single-resolver pattern prevents future leaks as handlers multiply — only a handful of handlers exist.

### Update at G3 (Sprints 4a–4c, 2026-10-28)

- Read models: the dashboard reader (3 workspace-scoped queries + DB clock) and the analytics reader (3 queries + DB clock) both take the workspace from the session-resolved viewer. Mutations "workspace filters removed" failed exactly state vectors 17, 20, 21 and analytics vectors 19, 20, 23 (`docs/sprints/SPRINT-04a.md`, `SPRINT-04b.md` Test evidence). A malformed or foreign `projectId` yields all zeros without a query (ADR-0013 *Changes*).
- Composite FK again: `project_budgets (project_id, workspace_id) → projects (id, workspace_id)` "after catching that a plain FK allowed a cross-workspace budget row" (`SPRINT-04c.md` Team log); migration `0005` (`025e35d`), PGlite refusal test (event-store 48). `budget_alerts` has no workspace column and a plain FK to the project.
- Fan-out: alert recipients = verified owners of the job's workspace (budget vector 21; invariant I6 in `docs/jgr/conformance/budgets/README.md`); reviewer verified recipient scoping and server-action authorization (owners/admins edit, members read-only) (`SPRINT-04c.md`).
- Test placement: ADR-0005 put JD-M04's repository tests in JD-M06 "to avoid a JD-M04 → JD-M06 dependency cycle"; S4c did the same for the budget module (`packages/event-store/test/budgets.test.ts`), because the store depends on it (`packages/event-store/package.json`), while the two read-only modules depend on the store and keep their own PGlite tests.
- Still a hypothesis: that the pattern prevents leaks under real multi-tenant traffic (no second real tenant yet).
