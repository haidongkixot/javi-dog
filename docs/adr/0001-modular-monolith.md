# ADR-0001: Modular monolith with ID-tagged workspace packages

- Status: Accepted
- Date: 2026-10-20
- Deciders: Project owner (Hai), Claude (implementer)
- Modules: all

## Context and problem statement

The owner requires a system built from *pluggable modules*, each acting as a service to the others, each improvable without affecting the rest, and each carrying an ID for traceability. The target platform is Vercel + Neon. The team is one owner plus coding agents, so operational overhead must stay low.

## Decision drivers

- Independent evolution of modules with explicit contracts.
- Traceability: every module, decision and commit references a stable ID.
- Low operational cost and a single deploy target on Vercel.
- Agents must be able to reason about one module at a time (small context).

## Considered options

1. **Modular monolith** — one Next.js deployable composing workspace packages with enforced boundaries.
2. Microservices — separate deployables per module (multiple Vercel projects / functions) talking over HTTP/queues.
3. Single Next.js app with folders only (no package boundaries).

## Decision outcome

Chosen: **option 1, modular monolith** in a pnpm workspace orchestrated by Turborepo.

- Each module is a package under `packages/` or `collectors/` with a `module.json` manifest: `id`, `name`, `version`, `status` (`planned` | `in-progress` | `stable` | `deprecated`), `description`, `provides`, `consumes`, `owner`.
- IDs: `JD-APP` (web app), `JD-M01`…`JD-M13` (platform modules), `JD-C01`…`JD-C03` (collectors). IDs are never reused.
- A module exposes its contract only through `src/index.ts`; deep imports across modules are lint errors (`eslint-plugin-boundaries` / `no-restricted-imports`).
- Contract changes ship with a changeset (per-module SemVer + CHANGELOG via Changesets) and docs in the same commit.
- `docs/modules/REGISTRY.md` is generated from all `module.json` files; CI fails if it is stale.
- Packages are created when their sprint starts; the registry lists planned modules up front so IDs are stable from day one.

### Consequences

- Good: one deploy, one database connection pool strategy, cheap to run; boundaries still explicit and testable.
- Good: a module can later be extracted into its own service because its contract is already isolated (e.g. ingest gateway if load demands it — would be a new ADR).
- Bad: modules share a runtime; a crash or heavy CPU in one route can affect others. Mitigated by keeping ingest handlers small and measured (S5 load test).
- Bad: discipline must be enforced by tooling, not by network boundaries.

## Module map

| ID | Package | Purpose | Planned sprint |
|---|---|---|---|
| JD-APP | `apps/web` | Next.js App Router; composes modules | S0 |
| JD-M01 | `packages/jgr-spec` | JGR schemas, OpenAPI, test vectors | S1 |
| JD-M02 | `packages/jgr-sdk` | Client SDK: batching, spool, retry, signing, encryption | S3 |
| JD-M03 | `packages/identity` | Auth (GitHub, Google), users, workspaces | S2 |
| JD-M04 | `packages/projects` | Project registry, ingest tokens, privacy settings | S1–S2 |
| JD-M05 | `packages/ingest` | JGR + OTLP/HTTP ingress | S3 |
| JD-M06 | `packages/event-store` | Neon schema, rollups, retention | S2 |
| JD-M07 | `packages/realtime` | SSE streams, freshness/stale | S4 |
| JD-M08 | `packages/analytics` | Effectiveness and model comparison | S4 |
| JD-M09 | `packages/notify` | Email (Resend + React Email), alerts | S2 |
| JD-M10 | `packages/github-bridge` | GitHub App, archive opt-in | S5 |
| JD-M11 | `packages/crypto` | Envelope / end-to-end encryption | S5 |
| JD-M12 | `packages/resilience` | Budget forecast, exhaustion alerts, BYOK failover | S4–S6 |
| JD-M13 | `packages/ui` | Design system: tokens + components | S0–S1 |
| JD-C01 | `collectors/claude-code` | Claude Code hooks + OTel + `javi` CLI | S3 |
| JD-C02 | `collectors/otel-bridge` | Codex / Gemini CLI → OTLP | S5 |
| JD-C03 | `collectors/mcp-server` | Javi MCP server (agent self-report) | S5 |
