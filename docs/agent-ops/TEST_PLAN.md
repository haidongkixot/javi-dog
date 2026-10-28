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

## S2b — Sign-in (2026-10-22)

Risk: **HIGH** (authentication, first personal data). Screenshot budget: **0**.

| Requirement | Layer | Test | Result |
|---|---|---|---|
| Auth refuses weak/missing secret or base URL | Integration (PGlite) + unit | `identity.test.ts`, `apps/web/test/auth.test.tsx` | see SPRINT-02b |
| Providers enabled only with id + secret | Unit | `packages/identity/test/auth.test.ts`, web `auth.test.tsx` | see SPRINT-02b |
| GitHub/Google redirect to the provider with our callback URL and client id | Integration (Better Auth API, offline) | `identity.test.ts` | see SPRINT-02b |
| First sign-in → one owned personal workspace, active on the session; idempotent; per-user isolation; cascades | Integration (PGlite, OAuth-callback internals) | `identity.test.ts` | see SPRINT-02b |
| Migrations 0000–0001 up / down / re-apply | Integration (PGlite) | `migrations.test.ts` | see SPRINT-02b |
| UI: checking / signed-out / signed-in / sign-out; sign-in errors explained; not-configured state + 503 | Component (jsdom) + route | `apps/web/test/auth.test.tsx` | see SPRINT-02b |
| Real provider round trip, account row (encrypted token), workspace + owner row | Manual E2E on production by the owner + agent DB check | SPRINT-02b task 7 | pending |

## S2c — Projects, tokens, welcome email (2026-10-22)

Risk: **HIGH** (authorization boundary, secret display, outbound email). Screenshot budget: **0**.

| Requirement | Layer | Test | Result |
|---|---|---|---|
| Workspace = session's active one only with membership; forged id falls back to own | Integration (PGlite) | `identity.test.ts` | see SPRINT-02c |
| Actions use the viewer's workspace, ignore form workspace fields, reject malformed ids | Unit (mocked viewer) | `apps/web/test/projects.test.tsx` | see SPRINT-02c |
| Foreign / malformed project id → 404 without querying | Unit | `projects.test.tsx` | see SPRINT-02c |
| Validation and slug clash → field messages | Unit | `projects.test.tsx` | see SPRINT-02c |
| Token shown once; limit and not-found messages | Unit | `projects.test.tsx` | see SPRINT-02c |
| Welcome email content, HTML escaping, Resend request, error without PII | Unit | `packages/notify/test/welcome.test.ts` | see SPRINT-02c |
| `onUserCreated` once per user; failure logged without PII and sign-in continues | Integration (PGlite) | `identity.test.ts` | see SPRINT-02c |
| Redaction of emails and token-like strings | Unit | `packages/identity/test/auth.test.ts` | see SPRINT-02c |
| Sign-in error codes → readable, sanitized message | Component | `apps/web/test/auth.test.tsx` | see SPRINT-02c |
| Real welcome email accepted by Resend | Smoke (sink) | `email:smoke` | see SPRINT-02c |
| Signed-in create project / issue / revoke on production | Manual (owner) + DB check | SPRINT-02c | pending |

## S3a — JGR ingress endpoint (2026-10-23)

Risk: **HIGH** (public write endpoint, secret-bearing requests, tenant boundary, data integrity). Screenshot budget: **0** (no UI). Stack reused: Vitest + PGlite; no new dependency (PGlite added as a dev dependency of JD-M05 at the existing pinned version).

| Requirement | Risk | Layer | Test | Result |
|---|---|---|---|---|
| Migration 0002 up / down (newest first) / re-apply | Medium | Integration (PGlite) | `event-store/test/migrations.test.ts` | see SPRINT-03a |
| Insert stores once: retry and in-batch duplicates skipped; scoped by project | High | Integration (PGlite) | `event-store/test/events.test.ts` | see SPRINT-03a |
| Event row cannot point at a project of another workspace (composite FK) | High | Integration (PGlite) | `events.test.ts` | see SPRINT-03a |
| Rate window counts atomically per token and minute | Medium | Integration (PGlite) | `events.test.ts` | see SPRINT-03a |
| Purge deletes only rows before the cutoff | Medium | Integration (PGlite) | `events.test.ts` | see SPRINT-03a |
| `verifyToken` returns project slug + privacy class; revoked → null | High | Integration (PGlite) | `event-store/test/repository.test.ts` | see SPRINT-03a |
| Auth: missing / malformed / unknown / revoked → 401, no DB write | High | Integration (PGlite) through the handler | `ingest/test/handler.test.ts` | see SPRINT-03a |
| Body > 256 KB, gzip bomb, bad gzip, bad JSON, bad batch shape → 413 / 400 | High | Unit (handler with fake deps) | `ingest/test/body.test.ts`, `handler.test.ts` | see SPRINT-03a |
| Partial acceptance; `project_mismatch`; `privacy_class_not_allowed`; JD-M01 codes passed through | High | Integration (PGlite) | `handler.test.ts` | see SPRINT-03a |
| Duplicate batch → `accepted 0, duplicates n`; `last_signal_at` / `last_used_at` set only after a stored event | High | Integration (PGlite) | `handler.test.ts` | see SPRINT-03a |
| 61st batch in a minute → 429 + `Retry-After` | Medium | Integration (PGlite, injected clock) | `handler.test.ts` | see SPRINT-03a |
| DB failure → 503 without driver text | Medium | Unit (fake deps) | `handler.test.ts` | see SPRINT-03a |
| Route: Node runtime, `no-store`, 503 `not_configured` without DB | Low | Unit | `apps/web/test/ingest-route.test.ts` | see SPRINT-03a |
| Migration 0002 on Neon PG 18 | Medium | Manual (owner runs `db:migrate`; agent cannot — no `DATABASE_URL` locally) | SPRINT-03a | pending owner |
| Live POST with a real token on production | High | Manual smoke after migration | SPRINT-03a | pending owner |

## S3b — JGR SDK and retention purge (2026-10-23)

Risk: **MEDIUM-HIGH** (data loss on the producer side, secret handling, destructive scheduled job). Screenshot budget: **0**. No new dependency.

| Requirement | Risk | Layer | Test | Result |
|---|---|---|---|---|
| ULIDs monotonic and valid for JD-M01; sequence per thread | Medium | Unit | `jgr-sdk/test/ulid.test.ts`, `client.test.ts` | see SPRINT-03b |
| `record` validates; invalid input never spooled | High | Unit | `client.test.ts` | see SPRINT-03b |
| Spools FIFO, bounded, oldest-first eviction; file writes atomic; corrupt file skipped | High | Unit (temp dir) | `spool.test.ts` | see SPRINT-03b |
| Batching ≤ 100 events and ≤ 256 KB; gzip above threshold | Medium | Unit (fake fetch) | `client.test.ts` | see SPRINT-03b |
| Retry 429/5xx/network with full jitter, `Retry-After`, attempt cap; keep spool after exhaustion | High | Unit (fake fetch, fake sleep, seeded random) | `client.test.ts` | see SPRINT-03b |
| 401/403 stop and keep; 413 halves then drops a lone event; 400 drops and reports; rejected events reported | High | Unit | `client.test.ts` | see SPRINT-03b |
| Token never in spool files or errors | High | Unit | `client.test.ts`, `spool.test.ts` | see SPRINT-03b |
| SDK against the real handler (PGlite) | High | Integration | `client.test.ts` (fetch → `createIngestHandler`) | see SPRINT-03b |
| Purge: 503 without secret, 401 wrong secret, 200 deletes only expired rows | High | Unit + integration (PGlite) | `apps/web/test/purge.test.ts` | see SPRINT-03b |
| Cron registered on Vercel | Low | Manual (deployment config) | SPRINT-03b | pending |
| Purge on production with the real secret | Medium | Manual (owner sets `CRON_SECRET`) | SPRINT-03b | pending owner |

## S3c — Claude Code collector (2026-10-23)

Risk: **HIGH** (runs inside the developer's agent loop; handles prompts/tool data on stdin; stores a secret locally). Screenshot budget: **0**. No new dependency.

| Requirement | Risk | Layer | Test | Result |
|---|---|---|---|---|
| Each hook maps to a valid JGR L0 event; content fields never in the output; salted refs | High | Unit | `collectors/claude-code/test/mapping.test.ts` | see SPRINT-03c |
| Settings merge keeps foreign hooks/keys, idempotent, never overwrites unparsable files; uninstall removes only ours | High | Unit (temp dir) | `settings.test.ts` | see SPRINT-03c |
| Sequence unique under concurrency; installation stable; one flusher per project | Medium | Unit (temp dir) | `state.test.ts` | see SPRINT-03c |
| init/hook/flush/status/uninstall against the real handler; token never printed or in the repo; revoked token keeps the spool | High | Integration (PGlite) | `cli.test.ts` | see SPRINT-03c |
| Real hook process: exit 0, empty stdout/stderr, detached flush delivers | High | Process (local HTTP receiver) | `process.test.ts` | see SPRINT-03c |
| Hung network request aborted and retried | Medium | Unit | `jgr-sdk/test/client.test.ts` | see SPRINT-03c |
| Real Claude Code session → production | High | Manual (owner, own token) | SPRINT-03c | pending owner |

## S3d — Ingest hardening + reconciliation ports (2026-10-28)

> **Deviation:** this section was written after implementation (flagged by the Reviewer). The tests below were written with each fix; the plan records them retroactively and truthfully.

Risk: **HIGH** (dedupe integrity, data loss in the SDK, production migration). Screenshot budget: **0**.

| Requirement | Layer | Test | Result |
|---|---|---|---|
| H1 canonical ids (validator, store, DB check), strict UUID | Unit + integration (PGlite) | `jgr-spec/test/validate.test.ts`, `event-store/test/events.test.ts` | see SPRINT-03d |
| H1 migration 0003 up / rollback (constraint gone) / refuses non-canonical rows | Integration (PGlite) | `event-store/test/migrations.test.ts` | see SPRINT-03d |
| H2 signal on accepted-or-duplicate retry, forward-only, DB-clock cap, token throttle | Integration (PGlite) + handler | `events.test.ts`, `ingest/test/handler.test.ts` | see SPRINT-03d |
| H3 bounded purge + route matrix | Integration + unit | `events.test.ts`, `web/test/purge.test.ts` | see SPRINT-03d |
| H4 415 media type/encoding, SDK keeps spool, > 100 → 413 | Handler + SDK unit | `handler.test.ts`, `jgr-sdk/test/client.test.ts` | see SPRINT-03d |
| H5 sorted insert, first occurrence wins | Integration (PGlite) | `events.test.ts` | see SPRINT-03d |
| H6 DB-clock window, Retry-After from DB clock | Integration (PGlite) | `events.test.ts` | see SPRINT-03d |
| Black-box HTTP behaviour (43 QA vectors) | Conformance (real handler, PGlite) | `ingest/test/conformance.test.ts` + mutation check | see SPRINT-03d |
| Migration 0003 on Neon PG 18 | Smoke (dev-agent) | pre-check query, `db:migrate`, `db:smoke` | see SPRINT-03d |
| Production behaviour | Live smoke | `pnpm --filter @javis-dog/ingest smoke:live` after READY | see SPRINT-03d |

## S3e — Token usage via a local OTLP receiver (2026-10-28)

Written before the lanes start. Risk: **HIGH** — a localhost listener (local injection, DNS rebinding), a machine-wide settings edit, privacy (identity attributes arrive on every data point), usage counting integrity. Screenshot budget: **0**. Stack reused: Vitest per package, PGlite + real ingest handler for e2e (as in `cli.test.ts`), real child processes (as in `process.test.ts`). No new dependency.

| Requirement | Risk | Lowest reliable layer | Test / assertion | Higher layer? |
|---|---|---|---|---|
| U0 caller `event_id`: kept, canonicalized, invalid rejected, default ULID unchanged | Medium | Unit (SDK) | `jgr-sdk/test/client.test.ts` | No |
| U1 only `session.id`/`model`/`type` read; identity/resource attrs never in output | High | Unit | serialized output contains no `user.email`/`organization.id`/`terminal.type` values | e2e spool check (U3) |
| U1 type → counter mapping; cost → `cost_usd`; other metrics ignored | High | Unit | table cases incl. `claude_code.session.count`, unknown `type` | QA vectors |
| U1 `asInt` as string and number, `asDouble`, unknown fields ignored, malformed → error | Medium | Unit | table cases | QA vectors |
| U1 delta used as-is; cumulative → delta via baseline; first cumulative point only sets baseline; backwards → new baseline | High | Unit | sequences of exports | No |
| U1 grouping per (session, model, start, end); all-zero groups skipped; deterministic canonical UUID id; same input → same id | High | Unit | | e2e duplicate (U3) |
| U2 backup once; merge keeps other keys; refuses on parse error / foreign `OTEL_*` or telemetry key in file or shell; `off` removes only unchanged own keys | High | Unit (temp dir) | file contents before/after; refusal leaves bytes identical | No |
| U3 401 without/with wrong bearer, 403 foreign `Host`, 415 protobuf / unknown encoding, 413 > 1 MiB, 400 malformed, 405 wrong method, 404 other path, 200 `{}` | High | Integration (real HTTP server, ephemeral port) | status + nothing spooled on refusals | QA vectors |
| U3 attributed session → `usage.reported` in that project's spool with the hook `thread_ref`; unknown session dropped and counted | High | Integration | spool contents, `javi status` line | owner real run |
| U3 export retried → server dedupes | High | E2E (receiver → SDK → real ingest handler on PGlite) | second delivery `duplicates: 1`, one row | No |
| U3 hooks start the receiver when usage is on; second instance exits on taken port; idle exit; hooks stay silent | Medium | Process (real `node cli.ts` children, short idle via env) | pid file, port, exit codes, empty stdout/stderr | No |
| OTel `session.id` = hook `session_id` | High | **Runtime only** (owner's first real Claude Code run) | `javi status`: matched vs dropped sessions | — (UNKNOWN until then) |
| Docs, registry, changeset | Low | Static | `pnpm docs:check` | No |

Execution: changed packages first (`pnpm --filter @javis-dog/collector-claude-code test`, `--filter @javis-dog/jgr-sdk test`), then the full gate in CI order. Failure policy as §6: diagnose before retry; no skipped tests; no softened assertions.

## S3f — `npx` packaging (2026-10-28)

Written before implementation. Risk: **MEDIUM** — a broken install path silently stops all signals (hooks are neutral by design, so failures are invisible). Screenshot budget: **0**. No new external package (esbuild is in the lockfile).

| Requirement | Risk | Lowest reliable layer | Test / assertion | Higher layer? |
|---|---|---|---|---|
| Bundle is self-contained (no `@javis-dog/*`, `zod` imports left; shebang; ESM) | High | Build + static check | build, then scan the bundle for bare imports other than `node:` | Tarball install |
| Tarball installs offline and the `javi` bin runs through the `.bin` symlink | High | Process (npm install from the tarball into a temp prefix, `--offline`) | `javi status --project x` prints "not configured", exit 1 (CLI ran) | No |
| `init` from the bundle copies itself to `~/.javi/bin/javi.mjs` and hooks point there | High | Process (temp `JAVI_HOME`, temp project dir, `--no-verify`) | settings `args[0]` = the stable copy; deleting the install prefix leaves a working hook (`hook` exits 0, event spooled) | No |
| Repo-checkout `init` unchanged | Medium | Existing `cli.test.ts` | unchanged assertions | No |
| CI builds the bundle | Low | `pnpm build` in CI | exit 0 | No |

Tests: `collectors/claude-code/test/pack.test.ts`, `install-self.test.ts`, `pack-scripts.test.ts` (build scan, offline tarball install via the `.bin` symlink, stable `~/.javi/bin` copy surviving removal of the install prefix).

## S4a — Live state: read model, freshness, dashboard (2026-10-28)

Written before the lanes start. Risk: **HIGH** — tenant isolation on a new read path, truthfulness of "live"/stale (product rule 2), first data-driven UI. Screenshot budget: **0** (behaviour and semantics are asserted with jsdom queries; no visual question is open). Stack reused: Vitest, PGlite (as JD-M06), Testing Library + jsdom (as `apps/web/test`).

| Requirement | Risk | Lowest reliable layer | Test / assertion | Higher layer? |
|---|---|---|---|---|
| Freshness: fresh ≤ 180 s (inclusive), stale after, `ended` after `session.ended` | High | Unit | boundary table (179.999 / 180 / 180.001 s) | QA state vectors |
| Thread state: last status, attention (latest status-bearing event `waiting`), agents, tasks, tokens | High | Integration (PGlite) | seeded event sequences | QA state vectors |
| Overview counters + activity (25, newest first) + project health incl. `never` | High | Integration (PGlite) | seeded workspace | No |
| Workspace isolation | High | Integration (PGlite) | two workspaces; snapshot of A contains nothing of B (ids, slugs, refs) | Route test |
| 24 h window and DB clock (`generatedAt` from `now()`) | Medium | Integration (PGlite) | event at 25 h excluded; pinned `now` | No |
| Route: 401 signed out, 503 no DB, `no-store`, workspace from session only | High | Unit (route handler with injected deps) | status + headers; query params ignored | No |
| Hook: 10 s while visible, paused when hidden, failure keeps data + notice | Medium | Component (jsdom, fake timers) | fetch call count; visibilitychange; notice text | No |
| Pages: values with last-signal time and stale/ended labels; empty states; attention visible; no "live" wording | High | Component (jsdom) | role/name queries; `not.toMatch(/\blive\b/i)` on values | No |
| Real data on production | — | Runtime (owner's first real run) | dashboard shows the session | NOT RUN until then |

## S4b — Usage analytics (2026-10-28)

Written before the lanes start. Risk: **MEDIUM-HIGH** — money-like numbers (estimated cost), tenant isolation on a new read path, a production index migration. Screenshot budget: **0**.

| Requirement | Risk | Lowest reliable layer | Test / assertion | Higher layer? |
|---|---|---|---|---|
| UTC day bucketing incl. 23:59:59.999 / 00:00:00.000, zero-filled range, clamp 1–30 | High | Integration (PGlite) | seeded events, pinned `now` | QA vectors |
| Sums: tokens exact, cost summed (float tolerance), reports count, only `usage.reported`; tasks completed/failed per day | High | Integration (PGlite) | seeded events | QA vectors |
| By model (null model bucket) / by project; sort | Medium | Integration (PGlite) | seeded events | QA vectors |
| Isolation incl. foreign `projectId` | High | Integration (PGlite) | two workspaces; JSON has nothing of B | QA vectors |
| Migration 0004 up/down + drift | Medium | Integration (PGlite) + static | `migrations.test.ts`, `db:generate` | `dev-agent` apply + `db:smoke` |
| Chart + table equivalent, estimated label, empty state, UTC label | High | Component (jsdom) | role/name queries; every cost text has "estimated" | No |
| Project page shows only its project's usage | Medium | Component + lib unit (injected reader) | projectId passed from the scoped project | No |

## S4c — Budgets, forecast and alerts (2026-10-28)

Written before the lanes start. Risk: **HIGH** — money-like figures, outbound email to real people (duplicates or misses), authorization on a write path, a production migration. Screenshot budget: **0**.

| Requirement | Risk | Lowest reliable layer | Test / assertion | Higher layer? |
|---|---|---|---|---|
| `utcMonth`, `forecastSpend` (null < 24 h; linear), `crossedThreshold` boundaries (79.99 / 80 / 99.99 / 100 %) | High | Unit | tables incl. Feb, 31-day months, leap year | QA vectors |
| Month-to-date spend: current UTC month only, received time, only `usage.reported` | High | Integration (PGlite, `event-store/test/budgets.test.ts`) | seeded events around month boundaries | QA vectors |
| Exactly-once claim; concurrent claims; covered lower threshold; retry failed / stale pending ≤ 5; raised limit does not re-alert | High | Integration (PGlite) | parallel `claimAlert` → one job | No |
| Isolation: status/set/clear only within the workspace; composite FK | High | Integration (PGlite) | foreign project → null / refused | No |
| Retention cutoff keeps the current month | Medium | Unit + integration | day 31 keeps day 1 | No |
| Email: L0 content, "estimated", owners only, no address logged | High | Unit (fake fetch) | body/recipients; logs | No |
| Ingest hook runs only when usage was stored; never fails ingest; runs after the response | High | Unit (handler with fakes) + route test | hook calls; 202 unchanged when hook throws | No |
| Budget UI: owners/admins edit, members read-only, validation, percent text, forecast/"too early" | High | Component (jsdom) + server action unit | role matrix; invalid values refused | No |
| Real email to the owner on production | — | Runtime (owner's first real run with a budget) | inbox | NOT RUN until then |

## S5a — Production readiness (2026-10-28)

Written before the lanes start. Risk: **HIGH**. This sprint covers the first production database, tenant isolation on every entry point, and load on the shared free-tier database. Screenshot budget: **0**. No product code changes; the new tests target behaviour that already exists.

| Requirement | Risk | Lowest reliable layer | Test / assertion | Higher layer? |
|---|---|---|---|---|
| `main` schema = committed migrations | High | Static + DB metadata (Neon MCP) | ledger hashes and `created_at` equal to `dev-agent`; schema diff empty; 13 tables | Post-cutover `/api/health` (6 migrations) |
| Production reads `main` after cutover | High | Runtime (count query) | `users` on `main` 0 → ≥ 1 after the owner signs in | No |
| Route handlers refuse signed-out, wrong bearer, wrong cron secret; no data or existence leak | High | Unit (route handlers with injected deps) | status codes + bodies; `no-store` where required | No |
| Pages and server actions scope every id to the session's workspace (projects, tokens, budgets) | High | Unit/component (injected deps, two workspaces) | foreign project id → not found / refused; nothing of B rendered; member cannot set a budget | No |
| Load script honours its caps; percentile maths; payload ≤ 256 KB gzip | Medium | Unit + local HTTP server | caps cannot be exceeded; p95 on a known sample; payload size | One bounded production run (ADR-0015 budget) |
| Ingest p95 < 2 s (JGR hypothesis) | Medium | Runtime (production, once) | client-side p50/p95/max incl. sandbox proxy | No |
| End-to-end: packed `javi` → ingest → stored | High | Process + local recording server | `init`, hook events, `flush` exit 0, spool empty, batches received | One production run; rows confirmed by count on `main` |
| Rollback plan executable | Medium | Docs review + one dry check (migration down files on PGlite already in `migrations.test.ts`) | every path names its command and its limit | NOT RUN: real Vercel rollback (owner action if needed) |
