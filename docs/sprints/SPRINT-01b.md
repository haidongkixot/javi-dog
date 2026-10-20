# Sprint 01b — JGR research & spec v0.1

- Dates: 2026-10-20, 19:00 → 19:08 UTC (timebox 30 min) · Status: **CLOSED**
- Goal: research the standards and tool telemetry JGR must interoperate with, then ship a small, testable v0.1 draft.
- Modules touched: JD-M01 (new)

## Global constraints

- Privacy by minimization (L0 default); violations rejected, not stripped.
- Every research fact carries a primary-source URL or is marked NOT VERIFIED.
- Delivery targets (p95 < 2 s, < 4 KB) stay hypotheses until S5 load tests.

## Backlog

| # | Task | Module | Acceptance criteria | Status |
|---|---|---|---|---|
| 1 | Primary-source research (8 questions) | docs | Sources per fact; blocked sites noted; orchestrator spot-check | Done — `docs/jgr/research/2026-10-20-sources.md` |
| 2 | Envelope + batch schemas, validator | JD-M01 | Strict schema, stable issue codes, partial batch acceptance | Done |
| 3 | Conformance vectors | docs/JD-M01 | Valid + invalid JSON vectors run by tests | Done — 20 vectors |
| 4 | Normative spec v0.1 + ADR-0004 | docs | Rules JGR-R01…R13, privacy classes, transport, mappings | Done |
| 5 | Apply research findings | JD-M01, spec | `reasoning_tokens`; (producer_id, event_id) dedupe; PII drop at OTLP edge; prompt-off collector setup; v0.2 signing plan | Done |

## Review focus

- A misconfigured Gemini CLI (default `logPrompts=true`) sends prompts → spec §12 requires the edge to drop content in L0; conformance tests for the OTLP translator are owed in S3 (JD-M05).
- Claude Code OTel attaches `user.email` when available → edge MUST drop identity attributes; test owed in S3.
- A producer retries a batch after a timeout → duplicates detected by (`producer_id`, `event_id`); gateway test owed in S3.

## Log

- 19:00 — Sprint start; research agent launched in parallel.
- JD-M01 schemas, validator, 20 vectors, 27 tests; spec + ADR-0004 committed (`77579d9`).
- Research returned; Claude Code privacy/protocol facts spot-checked by direct fetch of the official page.
- Found and fixed before running tests: placeholder ULIDs contained `I`/`O`, which Crockford base32 excludes.
- 19:08 — Sprint closed (≈ 8 minutes).
- Post-sprint (G1 review): refs tightened to opaque IDs (2 new vectors → 22), spec §11 aligned with JGR-R11; see ADR-0004 "Changes".

## Test evidence

| Command | Exit | PASS | FAIL | Notes |
|---|---:|---:|---:|---|
| `pnpm --filter @javis-dog/jgr-spec test` | 0 | 27 | 0 | 21 conformance cases (incl. structure check) + 6 unit tests |
| `pnpm format:check`, `lint`, `typecheck`, `test`, `docs:check` | 0 | all | 0 | full workspace |

Screenshots: 0. NOT RUN: gateway/OTLP translation tests (JD-M05 not built yet — S3).

## Decisions and deviations

- ADR-0004: own minimal envelope over HTTPS batches; OTLP/HTTP accepted at the edge and translated; CloudEvents mapping kept possible.
- Research agent's suggestion to build JGR directly *on* the CloudEvents envelope was not adopted for v0.1 (ADR-0004 rationale); the dedupe rule was aligned with CloudEvents instead.
- Request signing deferred to v0.2 with a concrete Stripe-style design.

## Retro

- Went well: running research in parallel with schema work kept the sprint short; shared vectors make the protocol testable by any implementation.
- Hurt: several official sites were blocked by the sandbox proxy; GitHub sources were used and marked.
- Change next: S2 needs B1, B3, B4, B5 from the owner before identity work can be verified end-to-end.

## Guru checkpoint

G1 (protocol decision) — see `guru/WISDOM_LOG.md`.
