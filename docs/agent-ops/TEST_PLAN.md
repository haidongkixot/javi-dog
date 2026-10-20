# Risk-Based Test Plan — Sprint 2a (Data layer & health)

> Orcasus template v1.2.1. Default screenshot budget: **0**. Earlier plans: S0 in git history and `docs/sprints/SPRINT-00.md`; S1a/S1b evidence in their sprint files.

## 1. Change and acceptance criteria

- Change: JD-M06 Neon client + migrations, JD-M04 tables / repository / hashed ingest tokens, JD-APP `GET /api/health`. Acceptance criteria: `docs/sprints/SPRINT-02a.md` §Backlog.
- Owner: Hai; implementer: Claude.
- Risk level: **MEDIUM-HIGH** — first persistent data, first secret material (ingest tokens), first multi-tenant boundary, first public JSON route.
- Primary journeys: (developer) generate → apply migration on `dev-agent`; (operator) open `/api/health` and see env presence + DB status; (S3 consumer) verify an ingest token.
- In scope: Node 22 (CI `ubuntu-latest`), Neon `dev-agent`, Vercel deployment of `/api/health`.
- Out of scope: sign-in, UI, JGR events, production Neon branch.
- Existing stack reused: Vitest 5 per package, Turborepo, GitHub Actions. New test dependency proposed: `@electric-sql/pglite` (owner decision Q1).

## 2. Test selection matrix

| Requirement | Risk | Lowest reliable layer | Test case / assertion | Higher layer needed? |
|---|---|---|---|---|
| Token format: prefix, 43 base64url chars, 32 bytes of entropy, unique per call | High | Unit | regex + decoded length; 1 000 generations unique | No |
| Only the SHA-256 hash is stored; plaintext never returned after issue | High | Integration (PGlite) | row has `token_hash` = known SHA-256 vector; no column equals plaintext; `listTokens` exposes prefix only | No |
| `parseIngestToken` rejects malformed / whitespace / foreign tokens before the DB | Medium | Unit | table of bad inputs → `null`; spy proves no query | No |
| `verifyToken` returns scope for active token, `null` for unknown / revoked | High | Integration (PGlite) | issue → verify ok; revoke → verify null; revoke twice idempotent | No |
| Cross-workspace isolation | High | Integration (PGlite) | project of WS-A not returned by `getProject(WS-B, id)` / `listProjects(WS-B)`; token issue for foreign project rejected | E2E with real users in S2b |
| Slug rules: unique per workspace, allowed across workspaces | Medium | Integration (PGlite) | duplicate → `slug_taken`; other workspace ok | No |
| Max 5 active tokens per project | Low | Integration (PGlite) | 6th issue → `token_limit` error; after a revoke → ok | No |
| Cascades: deleting a workspace removes projects and tokens | Medium | Integration (PGlite) | counts drop to 0 | No |
| Committed migration SQL matches the Drizzle schema | Medium | Static | `drizzle-kit generate` in CI produces no new file (drift check) | No |
| Migration applies cleanly and rollback SQL undoes it | Medium | Integration (PGlite) | apply → tables exist; down → tables gone; apply again | Manual on `dev-agent` (task 5) |
| Migration applies on Neon PG 18 | Medium | Manual smoke (dev-agent) | `db:migrate` exit 0; tables + `__drizzle_migrations` row listed | — |
| Health: booleans only, no values leak | High | Unit (route handler with injected env + fake ping) | JSON values in `env` are all booleans; serialized body contains no env value; no error text | Live GET after deploy (task 8) |
| Health: DB states `ok` / `error` / `not_configured`, 200 vs 503, 3 s timeout | Medium | Unit (fake timers) | each branch; hung ping → `error` ≤ 3 s | Live GET after deploy |
| Health: not cached | Low | Unit | `Cache-Control: no-store` header | No |
| Lint boundaries: no deep imports between JD-M04 / JD-M06 / JD-APP | Low | Static | `pnpm lint` | No |
| Docs, registry, changeset in sync | Low | Static | `pnpm docs:check` | No |

## 3. Visual/screenshot authorization

- Visual verification needed? **NO** — no UI change. Maximum screenshots: **0**.

## 4. Resource and access check

| Resource | Required? | Available? | Evidence |
|---|---|---|---|
| Node 22 + pnpm 10 | Yes | Yes | `node v22.22.0` |
| npm registry | Yes | Yes | `npm view drizzle-orm` 2026-10-20 |
| Neon `dev-agent` over HTTPS | Yes (tasks 5, smoke) | Yes | probe 2026-10-20: PG 18.6, 0 tables, ~1.2 s |
| PGlite | Yes (integration layer) | Pending Q1 | — |
| Vercel production URL | Yes (task 8) | Yes | public alias HTTP 200 (S1) |
| Neon API key for throwaway branches | No (option B of Q1 only) | MISSING | — |

## 5. Execution sequence

1. Per changed package: `pnpm --filter <pkg> test`, then `lint`, `typecheck`.
2. Drift check: `pnpm --filter @javis-dog/event-store db:generate` → `git status` clean.
3. Manual: `db:migrate` on `dev-agent` + smoke script (record output, no values).
4. Workspace: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm docs:check`.
5. After push: `curl -s https://javisdog.vercel.app/api/health` (record booleans only).

## 6. Failure policy

Preserve the first failure output, diagnose before retrying, never weaken assertions or skip tests. A dev-agent failure is reported as BLOCKED/FAIL, never replaced by a PGlite pass.

## 7. Results and evidence

Recorded in `docs/sprints/SPRINT-02a.md` §Test evidence.
