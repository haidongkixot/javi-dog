# Discovery Summary — Sprint 0

- Date: 2026-10-20 · Method: Orcasus `/project-discovery` v1.2.1
- Detail and evidence per item: [`READINESS_MATRIX.md`](READINESS_MATRIX.md)

## What exists

| Resource | Finding | Evidence |
|---|---|---|
| Application repository | `haidongkixot/javi-dog` existed with **no commits**; working branch `claude/clever-goldberg-wlurty` | `git status` → "No commits yet" |
| Engineering rules | Orcasus v1.2.1: two skills, operating contract, readiness and test-plan templates | `haidongkixot/orcasus@00b241b` |
| Brand | Creative proposal (14 slides) + interactive HTML prototype, Concept 0.1 | `docs/brand/source/` (SHA-256 in `PROVENANCE.md`) |
| Runtime | Node 22.22.0, pnpm 10.28.0, npm registry reachable | shell checks |
| Hosting | Vercel team `haidongkixots-projects`; no `javi*` project | Vercel MCP `list_teams`, `list_projects` |
| Browser for tests | Chromium pre-installed for Playwright | `/opt/pw-browsers` |

## What is missing or unknown

| ID | Item | Status | Needed by |
|---|---|---|---|
| B1 | Neon database / `DATABASE_URL` | UNKNOWN (403 on integration listing) | S2 |
| B2 | Vercel project for the repo | MISSING (owner confirmation to create) | S0 end / S1 |
| B3 | GitHub OAuth App | MISSING | S2 |
| B4 | Google OAuth client | MISSING | S2 |
| B5 | Resend API key + verified domain | MISSING | S2 |
| B6 | GitHub App for repository signals | MISSING | S5 |
| B7 | Legal/ToS review for Pack Pool | MISSING | S6 |
| D1 | Acceptance of AA-adjusted text tokens | UNKNOWN (default applied) | S1 |

## Notable findings

1. **Accessibility gap in the template.** Secondary text (`#7D7D97`, 4.00:1), all status-pill text colors (3.21–4.08:1) and white on Signal Violet (4.43:1) fail WCAG AA for normal text; the prototype also uses 9–10px text. Resolution proposed in ADR-0003 (decision D1).
2. **Auth library maturity.** `next-auth@5` is still beta; Better Auth 1.7 is stable → ADR-0002.
3. **Tooling compatibility.** TypeScript 7 is released but `typescript-eslint` supports `<6.1`; TypeScript 5.9 pinned.
4. **Pack Pool** is consistently framed by the owner's own brand material as *concept only* with four safety principles — aligned with the feasibility verdict.
5. **Brand roadmap alignment.** The proposal's roadmap (S0 discovery → S1 brand shell & registry → S2 identity → S3 JGR ingress → S4 live state & analytics → S5 adapter hardening → S6 Pack Pool research) is adopted as the sprint backbone.

## Architecture alternatives considered

See ADR-0001 (modular monolith vs. microservices vs. folders) and ADR-0002 (stack). Realtime transport (SSE vs. WebSocket vendor vs. polling) will get its own ADR in S4.

## Questions for the owner

Grouped in the readiness matrix: B1–B5 are needed before Sprint 2; B2 can be done now with confirmation; D1 confirmation needed during Sprint 1.

## Delta — S3c planning (2026-10-23)

- **Hook contract verified** (code.claude.com/docs/en/hooks and /settings, via a docs agent and a direct fetch; some tables only partially extracted — re-check on Claude Code upgrades): 33 events; common fields `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `agent_id`/`agent_type` inside subagents; `async: true` non-blocking; exec form (`command` + `args`) has no shell; Windows shell form = Git Bash or PowerShell; plain stdout of SessionStart/UserPromptSubmit enters Claude's context; exit 2 blocks some events; `.claude/settings.local.json` only auto-ignored when Claude Code created it.
- **Privacy finding:** prompt, tool input/response, error, assistant message and transcript path arrive on stdin → allowlist mapping (ADR-0010); HTTP hooks rejected.
- **Gap:** no ingest token on this machine → the first real Claude Code run is an owner step.

## Delta — S3b planning (2026-10-23)

- **Hosting:** Vercel project `javisdog` builds from Root Directory `apps/web` (provisioning how-to; deployments READY) → `vercel.json` with `crons` lives in `apps/web`. Hobby crons run at most daily; Vercel sends `Authorization: Bearer $CRON_SECRET` (Vercel docs, 2026-10-23). `CRON_SECRET` is MISSING and only the owner can add it (agent: 403 on env writes).
- **Collectors run as short-lived hook processes** (S3c) → delivery state must survive the process: file spool, receiver-side dedupe makes concurrent flushers safe (ADR-0009).
- **No new dependency needed:** Node 22 ships `fetch`, `node:zlib`, `node:fs`; ULIDs are generated in-house (26 Crockford chars, matches JD-M01's regex).

## Delta — S3 planning (2026-10-23)

- **Environment:** work now also runs on the owner's Windows machine (Node 22.23.4, pnpm 10.28.0, Git 2.55.0). It has **no `DATABASE_URL`** and no Vercel/GitHub tokens → migrations on `dev-agent` are run by the owner (Q3 below).
- **Reusable pieces:** JD-M01 `validateBatch` (partial acceptance, error codes), JD-M04 `verifyToken` (hash lookup, revoked → `null`), `projects.last_signal_at` / `ingest_tokens.last_used_at` reserved for the ingest path (ADR-0005), PGlite test layer, `/api/health` pattern (no secrets in responses).
- **Gaps found:** the spec has no error code for an event whose `project_ref` is not the token's project, nor for a privacy class above the project's opt-in → two new codes (ADR-0008). Dedupe on (`producer_id`, `event_id`) alone would let one tenant block another's event ids → key is scoped by project. Vercel does not decompress gzip request bodies for us → bounded streaming decompression.
- **Platform limits:** no Redis/KV in the stack; Vercel Hobby cron is daily at most (enough for a retention purge); Neon plan size UNKNOWN (free tier 0.5 GB assumed).
- **Scope split (timebox ≤ 30 min):** S3a ingest endpoint + `events`; S3b JD-M02 SDK + retention purge job; S3c JD-C01 Claude Code collector (`javi init`). The OTLP/HTTP receiver moves to S3c (needs a protobuf decision).
- **Owner answers (2026-10-23):** Q1 retention **30 days**; Q2 rate limit **Postgres fixed window per token**; Q3 migration **run by the owner** with one command. Recorded in ADR-0008.

## Delta — S2a planning (2026-10-20)

- **Resources:** all S2a resources AVAILABLE — Neon `dev-agent` over HTTPS (PG 18.6, empty), npm packages at ADR-0002 pins (`drizzle-orm` 0.45.4, `drizzle-kit` 0.31.11, `@neondatabase/serverless` 1.2.0). B3/B4 now hold well-formed secrets (Google proven by an `invalid_grant` probe; GitHub not checkable from the sandbox).
- **Constraint found:** raw TCP to Postgres times out from the sandbox; only the HTTP driver works → migrations use the neon-http migrator, not `drizzle-kit migrate` (ADR-0005).
- **Boundary finding:** JD-M04 owns `workspaces` in S2a while the registry places workspaces under JD-M03; tables are module-owned and composed by JD-M06 to keep ADR-0001 boundaries without import cycles (ADR-0005).
- **Better Auth interplay:** its organization plugin would create its own `organization` table; `workspaces` is shaped to be mapped instead (hypothesis, verify in S2b).
- **Unknowns:** Vercel env vars per environment (403 → `/api/health` will answer), Neon branch for Vercel Preview/Production (Q3). `neondb_owner` rotation deferred by owner (B1-rotate). Resend domain verified by a sink send (B5 done).
- **Owner questions:** Q1–Q4 in `docs/sprints/SPRINT-02a.md`.
