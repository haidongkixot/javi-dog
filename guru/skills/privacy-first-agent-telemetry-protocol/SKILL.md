---
name: privacy-first-agent-telemetry-protocol
description: Design a small, strict, privacy-first event protocol for telemetry from AI coding agents, CLIs, hooks, SDKs or any producer you do not fully control — a minimal envelope with unknown fields rejected, privacy classes enforced at the envelope by allowlist (reject, do not strip), token/cost usage as deltas, per-event IDs for deduplication, per-thread sequence numbers for gap detection, receiver-derived "stale" status, stable error codes, partial batch acceptance, normative rule IDs, shared JSON conformance vectors, and an edge translator that strips identity and content from tool-native OpenTelemetry (OTLP). Use when defining an ingest API or webhook contract, an observability or analytics event schema, an agent heartbeat/status protocol, a telemetry SDK, when deciding between OTLP, CloudEvents or a custom envelope, or when payloads might carry prompts, code, paths, emails or secrets.
metadata:
  version: "0.1.0"
  origin: "javis-dog G1"
  confidence: medium
---

# Privacy-first agent telemetry protocol

Coding agents and their tooling can emit a lot: prompts, tool inputs, file paths, account emails, token counts, costs. An observability product needs only a fraction of that, and every extra field it accepts becomes data it must protect. The protocol is where that boundary is cheapest to hold: if the contract cannot carry a prompt, no downstream bug can leak one.

The core move: **make the envelope small and strict, make privacy a validation rule rather than a cleanup step, and ship the rules as executable test vectors.**

Confidence is split. The envelope, validator and vectors (sections 1–6) were built and tested once (**medium**). Delivery semantics and the edge translator (sections 7–8) are specified but not yet implemented in the origin project (**low** — design with primary-source rationale, no runtime evidence).

## Forces

- **Privacy vs. usefulness.** Richer payloads enable richer analytics, and every extra field widens what can leak.
- **Strictness vs. forward compatibility.** Rejecting unknown fields stops silent data creep. It also means old receivers reject new producers.
- **Reliability vs. correctness.** At-least-once delivery means duplicates. Duplicates of *totals* are harmless; duplicates of *increments* inflate counters unless they are deduplicated.
- **Existing standards vs. fit.** OTLP and CloudEvents exist and are well supported, but neither carries a privacy class or "thread status" semantics.

## 1. Choose the envelope strategy explicitly

Write the options into a decision record. The origin compared three:

| Option | Good | Bad |
|---|---|---|
| Adopt OTLP as the only protocol | Tools that already export it need no code | Heavy for a 20-line hook script; spans/metrics/logs do not map 1:1 to status and attention; no privacy class |
| Adopt the CloudEvents envelope | Identity and type conventions, batch media type | Adds fields without usage, status or privacy guarantees |
| Own minimal envelope + translate OTLP at the edge | Tiny, testable contract; privacy by construction | Two inbound paths; the translator needs its own tests |

The origin chose the third option and borrowed CloudEvents' *identity rule* (dedupe on source + id) without its envelope, keeping a later CloudEvents wrapping possible. Your answer may differ; the point is to record which guarantees each option gives and which it lacks.

## 2. Keep the envelope minimal and strict

A field set that works for agent status and usage (full table: [`references/envelope-checklist.md`](references/envelope-checklist.md)):

- Identity: protocol version, `event_id` (ULID/UUID), `producer_id` (stable per installation), `sequence`.
- Scope: `project_ref`, `thread_ref` (one session in one tool), optional `agent_ref` (main agent or subagent).
- Meaning: `type` from a small core set plus a namespaced extension pattern (`x.<vendor>.<name>`), conditional `status`, `occurred_at` (RFC 3339 with offset), conditional `usage_delta`.
- Privacy: `privacy_class` (default lowest), a bounded `attributes` map, conditional `encrypted` object.

Rules that paid off:

- **Reject unknown top-level fields.** A receiver never silently stores data it did not agree to receive.
- **Conditional requirements by type.** A heartbeat without a status, or a usage report without a delta, is invalid — not "partially useful".
- **Bound everything:** event size, batch size and count, attribute key count, string lengths, reference length and charset.
- **Never let producers send derived states.** "Stale" is computed by the receiver from silence (for example 3 × the heartbeat interval). A producer that says it is live proves nothing.

## 3. Enforce privacy classes at the envelope

Define classes as allowlists, lowest by default:

| Class | Allowed | Typical rejection code |
|---|---|---|
| L0 (default) | Operational metadata only: platform, versions, model, tool name, task kind, durations, exit/error codes, retry counts, ratios | `privacy_forbidden_attribute` |
| L1 | L0 + identifiers only as salted hashes in a fixed format (`sha256:<64 hex>`) | `privacy_unhashed_identifier` |
| L2 | L1 + an encrypted blob produced with a key the receiver never sees | `privacy_encrypted_requires_l2` / `privacy_l2_requires_encrypted` |

**Reject, do not strip, at the envelope.** A producer that sends a forbidden field gets an error and learns; a receiver that silently drops it hides the bug and teaches nothing. (The *edge translator* in section 8 is the deliberate exception: it handles telemetry from tools you cannot fix.)

**Cover every free-form string, not only the attribute map.** In the origin, the allowlist guarded `attributes`, but the "opaque" reference fields used a permissive charset that allows `/`, `.` and `@`. A G1 probe showed a file path in `thread_ref` and an email in `agent_ref` were both accepted, although the spec says refs are "never a path". Give opaque fields a shape that cannot carry content — a prefix plus a fixed-length random or hashed token — and add invalid vectors for path- and email-shaped refs.

## 4. Make usage additive and deliveries idempotent

- **Usage as deltas** since the producer's previous report for the same thread; at least one counter required; an `estimated` flag when the producer cannot read exact counts. Include a `reasoning_tokens` counter: the origin's research found coding CLIs reporting reasoning/"thought" tokens as a separate kind (for example a `thought` token type in one CLI's documented metrics).
- **Deduplicate on (`producer_id`, `event_id`)** — the CloudEvents `source` + `id` rule. Report duplicates in the response.
- **Strictly increasing `sequence` per (producer, thread)**; surface gaps as *possible signal loss* instead of hiding them.
- **Per-event IDs are the idempotency mechanism.** A batch-level `Idempotency-Key` header is at most informative: in the origin's research it was an IETF draft, not an RFC.

## 5. Give errors stable codes and accept batches partially

- One small closed set of machine-readable codes (`schema`, `too_large`, `privacy_*`, `status_required`, `usage_required`, `clock_skew`). Clients branch on codes; messages may change.
- Batch response: valid events are stored, invalid ones come back with `index`, `event_id` and issues. One bad event must not drop a batch of good ones.
- Reject timestamps too far in the future (origin: 5 minutes) and record receipt time separately for ordering.

## 6. Write normative rules with IDs and ship conformance vectors

- Use RFC 2119 keywords and number every rule (`<PREFIX>-R01`…). Reference the IDs in code comments and tests so a reviewer can trace a check to its rule.
- Put **shared JSON vectors** in a language-neutral folder: one file per case with `description`, `receivedAt`, `event` and `expect` (`{ "ok": true }` or `{ "codes": [...] }`). Name files `valid-*` / `invalid-*` and let the runner assert the prefix matches the expectation. Example: [`templates/vector.example.json`](templates/vector.example.json).
- Pass the receive time into the validator so time-based rules are deterministic.
- Run the vectors in every implementation (SDK, collectors, gateway). A dependency-free runner: [`templates/run-vectors.mjs`](templates/run-vectors.mjs).
- Check fixtures against your own ID format. The origin's placeholder ULIDs first contained `I`/`O`, which Crockford base32 excludes; the strict ID pattern made that visible.
- Keep cross-references current. The origin's spec contradicts itself (one rule says unknown fields MUST be rejected; the versioning section says they are rejected only for unrecognized versions), and a code comment cites the wrong spec section for error codes. Decide the strictness/forward-compatibility rule explicitly — for example "reject unknown fields for the same MINOR; accept and ignore unknown optional fields from a higher MINOR" — and test both sides with vectors.

## 7. Transport and delivery (specified, not yet verified)

Low confidence: these are origin design decisions backed by RFCs and vendor docs, not runtime results.

- HTTPS `POST` of `{ "events": [...] }`, optional gzip, explicit batch/event limits, bearer token scoped to one project and hashed at rest.
- Status codes: `202` with a per-event report; `400`, `401/403`, `413` are not retried unchanged; `429` (with `Retry-After`) and `5xx` are retried with exponential backoff and full jitter.
- Producers spool unsent events locally (bounded, oldest-first eviction).
- Request signing: HMAC-SHA256 over `timestamp.body` with a `t=…,v1=…` header and a replay window (Stripe-style), RFC 9421 as the long-term path. GitHub-style body-only signatures have no replay window.
- Latency and size targets stay **hypotheses** until a load test records them.

## 8. Translate tool-native telemetry at the edge (specified, not yet verified)

Many tools already export OTLP. Accept it at the edge, translate it into your envelope, *then* validate. Because you cannot fix a third-party tool's configuration, the edge **strips** what the envelope would reject:

- Drop identity attributes (`user.email`, account/organization IDs, any `*.email`). The origin's research found one coding CLI attaches the user's email to telemetry "when available".
- Drop prompt and response content (prompt text, tool inputs/outputs, assistant messages) even if a tool was configured to send it. One CLI documented prompt logging as **on by default**; one hook system passes the raw prompt to every prompt-submit hook.
- Hash session identifiers with a per-installation salt before they become `thread_ref`.
- Make your setup tool turn content logging off explicitly in each tool.
- Pin semantic-convention versions per collector release when the conventions are still experimental; GenAI token metrics were renamed between versions.

Write conformance tests for the translator too — mapping tables are not evidence. Dated tool facts with sources: [`references/envelope-checklist.md`](references/envelope-checklist.md#tool-native-telemetry-facts-dated).

## Pitfalls

- **Stripping at the envelope.** It feels safer and makes producer bugs invisible.
- **Totals instead of deltas.** Retries and replays then need ordering guarantees you do not have.
- **Producer-asserted liveness.** Let the receiver derive stale from silence.
- **A privacy boundary that covers only one map.** Every string field is a channel.
- **Mapping tables as proof.** A documented mapping of hooks or metrics is a plan until a translator test runs it.

## Evidence from origin project

Javi's Dog, Sprint 1b (2026-10-20). Confidence **medium** for sections 1–6, **low** for 7–8.

- Decision: ADR-0004 (`docs/adr/0004-jgr-v0.1-envelope-and-transport.md`, `77579d9`) — three options, own envelope chosen, OTLP accepted at the edge, privacy enforced at the envelope, rejected-not-stripped.
- Spec: `docs/jgr/spec/v0.1.md` (`77579d9`, `a789674`) — rules JGR-R01…R13, privacy classes L0–L2, transport, error codes, edge rules §12.
- Implementation: `packages/jgr-spec/src/schema.ts` (strict Zod objects), `packages/jgr-spec/src/validate.ts` (allowlists, stable codes, `validateBatch` with partial acceptance).
- Vectors: 20 files in `docs/jgr/conformance/vectors/` (7 valid, 13 invalid); runner `packages/jgr-spec/test/conformance.test.ts` checks filename prefixes and code sets.
- Recorded result: `pnpm --filter @javis-dog/jgr-spec test` exit 0, 27 passed (21 conformance cases incl. a structure check + 6 unit tests); full workspace checks exit 0 (`docs/sprints/SPRINT-01b.md`). GitHub Actions CI succeeded on `77579d9` and `a789674` (`gh run list`, read at G1).
- Research-driven changes (`a789674`): `reasoning_tokens` added; dedupe aligned with CloudEvents; identity and content drop at the OTLP edge; Idempotency-Key informative only; signing design for v0.2.
- G1 probes (read-only, 2026-10-20): `validateEvent` accepted `thread_ref` set to a file path and `agent_ref` set to an email address. The spec's §3/R11 versus §11 contradiction and the "spec §7" comment in `validate.ts` (codes are in §13) were found by reading.
- Not verified: deduplication, gap detection, stale derivation, retry/backoff, spooling, OTLP translation and stripping — the gateway and collectors do not exist yet (tests owed in S3, `docs/sprints/SPRINT-01b.md` Review focus). The claim that shared vectors keep *several* implementations consistent is a hypothesis: one implementation exists.
