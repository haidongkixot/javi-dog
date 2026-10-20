# Roadmap

> Approved by the project owner on 2026-10-20. Backbone follows the brand proposal's delivery roadmap (slide 11): *prove the signal path before expanding the network.* Sprints are gated by evidence, not calendar promises. **Timebox: each sprint is at most 30 minutes of agent work** (owner decision, 2026-10-20). A roadmap sprint too large for one timebox is split (S1a, S1b…); unfinished items roll over and are recorded truthfully in the sprint file.

| Sprint | Goal | Key deliverables | Guru checkpoint |
|---|---|---|---|
| **S0 — Discovery & readiness** | Adopt Orcasus, lay foundations | CLAUDE.md, skills, readiness/discovery records, feasibility, brand guide, ADR-0001…0003, monorepo scaffold, CI, design tokens, project memory, Guru agent | G0 |
| **S1 — Brand shell & registry** (+ JGR research) | A brand-true app shell | JD-M13 components, five-space shell, states (empty / loading / stale / not-connected / demo), project registry (UI + draft schema); in parallel `docs/jgr/research/` and **JGR v0.1 draft** + JD-M01 | G1 (protocol) |
| **S2 — Identity & projects** | Sign-up and project management | JD-M03 GitHub/Google SSO, workspace membership, authorization; JD-M04 project CRUD + ingest tokens (hashed, rotatable); JD-M06 migrations; JD-M09 branded welcome email | — |
| **S3 — JGR ingress** (+ first adapter) | Prove the signal path | JD-M05 `POST /api/v1/events` + OTLP receiver (scoped auth, validate, dedupe, rate limit); JD-M02 SDK; JD-C01 Claude Code (`javi init`); conformance tests | G2 (+ Orcasus PR proposal) |
| **S4 — Live state & analytics** (+ Resilience v1) | The real dashboard | JD-M07 SSE + freshness; real data in Overview / Projects / Live agents; JD-M08 analytics; JD-M12 exhaustion alerts + budget forecast; email alerts | G3 |
| **S5 — Adapter hardening** (+ privacy) | Reliability and coverage | JD-C02 Codex/Gemini CLI; JD-M10 GitHub App; JD-C03 MCP server; JD-M11 privacy classes L1/L2; retry/backpressure; load test of p95/payload; runbooks; release docs → **release gate** | G4 (+ Orcasus PR proposal) |
| **S6 — Pack Pool research** (+ Resilience v2) | Controlled research | BYOK failover; ADRs on provider terms, economics, abuse controls, revocation (needs B7). Token network stays CONCEPT ONLY | G5 |

**Release gate (end of S5):** working end-to-end telemetry + verified access boundaries + test evidence + rollback plan.

**Per-sprint loop:** discovery delta → readiness matrix → ADRs → test plan → small slices → layered tests → evidence in `docs/sprints/SPRINT-NN.md` → `PROJECT_MEMORY.md` → commit + push → Guru checkpoint.
