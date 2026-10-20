# Javi's Dog — Feasibility Study

- Version: 1.0 (2026-10-20) · Approved by the project owner as part of the S0 plan
- Method: Orcasus project discovery (see `docs/agent-ops/DISCOVERY_SUMMARY.md`) + brand Concept 0.1 review

## 1. Scope under assessment

| Ambition | Description |
|---|---|
| Observe | Vibe coders register, manage projects and see a live dashboard of project health, active agents and token burn — regardless of the coding tool |
| Understand | Analytics that evaluate the effectiveness of the vibe-coding models and workflows they use |
| Javi Grande Rules (JGR) | A researched, versioned protocol + API for fast, reliable, optionally encrypted signal delivery from coding threads/agents to the platform |
| Keep the flow | Prevent tasks from failing mid-run because tokens or resources run out |
| Pack Pool ("BitTorrent for vibe coding") | Peer-to-peer lending of tokens/capacity between users |
| Engineering principles | Modular services with IDs, GitHub as collaboration/storage backbone, docs as a second memory, a Guru agent that packages reusable skills |

## 2. Feasibility matrix

| # | Capability | Feasibility | Main risks / limits | Mitigation |
|---|---|---|---|---|
| 1 | Sign-up, project management, GitHub/Google SSO | **High** | Real OAuth apps required | Better Auth + Drizzle/Neon (ADR-0002); owner creates OAuth apps (B3, B4) |
| 2 | Live dashboard on Vercel | **High** | Serverless functions do not hold long-lived WebSockets | Server-Sent Events on Fluid compute reading a Neon cursor; pub/sub (e.g. Upstash/Ably) only via a future ADR if load requires |
| 3 | Signals "from any platform" | **Medium** | Only CLI tools expose hooks/OpenTelemetry; hosted builders (Lovable, Bolt, v0, Replit) do not | Three collector layers: OTLP (Claude Code, Codex, Gemini CLI); hooks + MCP self-report; GitHub App fallback (commits/PRs/CI). The UI states the signal level available per platform |
| 4 | Counting running agents | **Medium–High** | Agents can die without a final event | Session/subagent lifecycle events + heartbeat TTL → explicit `stale` state ("Live means verified") |
| 5 | Token burn and cost | **High** for OTel-capable CLIs | Metric names differ by tool | Normalize to OpenTelemetry GenAI semantic conventions; label estimates `estimated` |
| 6 | JGR speed and reliability | **High** | Network loss, cold starts, duplicates | Batching + gzip; at-least-once delivery with `event_id` + `sequence` dedupe; client spool; exponential backoff + jitter; `429` + `Retry-After`. p95 < 2s and payload < 4 KB are **hypotheses** until measured (S5) |
| 7 | Signal encryption / privacy | **Medium–High** | End-to-end encrypted fields cannot be aggregated server-side; lost keys mean lost data | Default payload = operational metadata only; `privacy_class` L0 (plain) / L1 (hashed) / L2 (E2E AES-GCM, user-held key); HMAC + nonce replay protection. Never claim "encrypted" without runtime evidence |
| 8 | Model-effectiveness analytics | **Medium** | Needs outcome signals; attribution is noisy | Link sessions ↔ PRs/CI via GitHub; metrics: tokens per merged PR, cost per task, success and retry rates, with confidence labels |
| 9 | Pluggable modules with IDs | **High** | Coupling creeps in over time | Modular monolith, `JD-Mxx` packages, lint-enforced boundaries (ADR-0001) |
| 10 | GitHub as storage/communication backbone | **Medium** | API rate limits make it unsuitable for hot event data | Neon for hot data; GitHub for docs, specs, configuration, signals and opt-in archives |
| 11 | Docs as second memory | **High** | Docs drift from code | Docs-as-code (Diátaxis + MADR ADRs), memory files, CI doc-drift and registry checks |
| 12 | Javi's Guru | **High** | Over-specific "wisdom" that does not transfer | Collect → Synthesize → Generalize → Package with a quality bar and owner review |
| 13 | Keep-the-flow resilience layer | **High** | Tools differ in pause/resume support | Budget forecasting, early exhaustion alerts, checkpoint guidance, failover across the user's **own** keys/providers (BYOK) |
| 14 | Pack Pool / P2P token lending | **Low (gated)** | Provider terms generally forbid sharing or reselling account access/quota; possible financial regulation; prompt leakage through another person's key; abuse and trust | Research track only (S6): ToS/legal review (B7), threat model, compliant alternatives (team/org plans, authorized resellers). Never lend raw keys |
| 15 | Infrastructure cost | **High** | Vercel Hobby is non-commercial; free tiers of Neon/Resend are limited | Free/Hobby for development; owner approves paid plans before commercial beta |
| 16 | Brand → production UI | **High** | Template text colors fail WCAG AA; no dark theme; logo not trademark-cleared | AA text tokens with unchanged hues (ADR-0003, decision D1); light-only MVP with theme-scoped tokens; logo marked concept 0.1 |

## 3. Verdict

- **Phase 1–2 (Observe, Understand, JGR, privacy classes, Keep-the-flow v1/v2): feasible** on the mandated stack.
- **Pack Pool: not feasible today.** It stays a gated research track; the product shows it as *CONCEPT ONLY* and builds no credential or token transfer.

## 4. Preconditions (owner-provided resources)

See `docs/agent-ops/READINESS_MATRIX.md` items B0–B7 and decisions D1–D2.
