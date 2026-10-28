---
name: privacy-first-agent-telemetry-protocol
description: Design a small, strict, privacy-first event protocol for telemetry from AI coding agents, CLIs, hooks, SDKs or any producer you do not fully control — a minimal envelope with unknown fields rejected, privacy classes enforced at the envelope by allowlist (reject, do not strip), token/cost usage as deltas, per-event IDs for deduplication, per-thread sequence numbers for gap detection, receiver-derived "stale" status, stable error codes, partial batch acceptance, normative rule IDs, shared JSON conformance vectors, canonical event IDs, delivery status codes that tell producers whether to keep or drop data, liveness that survives retries, and translating tool-native OpenTelemetry (OTLP) into the envelope where the data is born (a local receiver) so identity and content never cross the network. Use when defining an ingest API or webhook contract, an observability or analytics event schema, an agent heartbeat/status protocol, a telemetry SDK, when deciding between OTLP, CloudEvents or a custom envelope, when building an ingest endpoint, collector, SDK spool or OTLP receiver for agent telemetry, or when payloads might carry prompts, code, paths, emails or secrets.
metadata:
  version: "0.2.0"
  origin: "javis-dog G1; updated G2-prep, G2"
  confidence: "medium (envelope, vectors, ingest delivery, local OTLP translation); low (gap detection, stale derivation, latency and size targets)"
---

# Privacy-first agent telemetry protocol

Coding agents and their tooling can emit a lot: prompts, tool inputs, file paths, account emails, token counts, costs. An observability product needs only a fraction of that, and every extra field it accepts becomes data it must protect. The protocol is where that boundary is cheapest to hold: if the contract cannot carry a prompt, no downstream bug can leak one.

The core move: **make the envelope small and strict, make privacy a validation rule rather than a cleanup step, and ship the rules as executable test vectors.**

Confidence is split. The envelope, validator and vectors (sections 1–6), the ingest and delivery path (section 7) and the local OTLP translator (section 8) are built, tested and — for ingest — smoke-tested against production in the origin (**medium**). Sequence-gap detection, receiver-derived stale status and the latency/size targets are still unbuilt or unmeasured (**low**), and the OTLP path has not yet run inside a real host-tool session.

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

**Cover every free-form string, not only the attribute map.** In the origin, the allowlist guarded `attributes`, but the "opaque" reference fields used a permissive charset that allows `/`, `.` and `@`. A G1 probe showed a file path in `thread_ref` and an email in `agent_ref` were both accepted, although the spec says refs are "never a path". Give opaque fields a shape that cannot carry content — a prefix plus a fixed-length random or hashed token — and add invalid vectors for path- and email-shaped refs. (The origin restricted refs to `[A-Za-z0-9_:-]` after G1, `c80e548`.)

## 4. Make usage additive and deliveries idempotent

- **Usage as deltas** since the producer's previous report for the same thread; at least one counter required; an `estimated` flag when the producer cannot read exact counts. Include a `reasoning_tokens` counter: the origin's research found coding CLIs reporting reasoning/"thought" tokens as a separate kind (for example a `thought` token type in one CLI's documented metrics).
- **Deduplicate on (`producer_id`, `event_id`)** — the CloudEvents `source` + `id` rule. Report duplicates in the response.
- **Strictly increasing `sequence` per (producer, thread)**; surface gaps as *possible signal loss* instead of hiding them.
- **Per-event IDs are the idempotency mechanism.** A batch-level `Idempotency-Key` header is at most informative: in the origin's research it was an IETF draft, not an RFC.
- **Canonicalize IDs before deduplicating.** ULIDs are case-insensitive and UUIDs have upper/lower-case spellings; if the dedupe key compares strings, `01jbz…` and `01JBZ…` are two events. Normalize in the validator (ULID upper-case, UUID lower-case, strict UUID shape), normalize again in the store, and add a database check constraint so nothing non-canonical is stored. Echo the producer's own spelling in rejections so it can match them.
- **Scope the dedupe key by tenant.** Unique (`project`, `producer_id`, `event_id`): a globally unique key lets one tenant pre-claim another tenant's IDs.
- **Derive IDs deterministically when you translate.** When one upstream export becomes your events, compute `event_id` from a keyed hash of the grouping key (for example HMAC-SHA-256 with a per-installation salt, formatted as a canonical UUID with fixed version and variant bits). The upstream tool's retry of the same export then produces the same IDs, and the receiver's dedupe drops it.

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

## 7. Transport and delivery

HTTPS `POST` of `{ "events": [...] }`, optional gzip, explicit batch/event limits, bearer token scoped to one project and hashed at rest (storage design and proof: the `prove-secrets-and-pii-minimization` and `tenant-isolation-by-construction` skills). Request signing (HMAC over `timestamp.body` with a replay window; RFC 9421 later) remains a design (low).

**Status codes are instructions to the producer's spool.** Choose them by what the producer should do with the data:

| Situation | Status | Producer action |
|---|---|---|
| Stored (some events may be rejected individually) | `202` + `{accepted, duplicates, rejected[]}` | Remove the batch; report rejections |
| Malformed JSON or batch shape | `400` | Drop and report — retrying never fixes it |
| Missing/unknown/revoked token | `401` + `WWW-Authenticate` | Stop, **keep** the spool |
| Body or event count over the limit (after decompression) | `413` | Halve the batch and resend; drop a single event that is still too large |
| Wrong `Content-Type` or `Content-Encoding` (for example a proxy rewrote it) | `415` | Stop, **keep** the spool — a configuration problem, not bad data |
| Rate limit | `429` + `Retry-After` | Retry after the given time |
| Database or upstream failure | `503` | Retry with full-jitter backoff |

In the origin, wrong media types first answered `400`, which tells a well-behaved producer to *drop* good events; the hardening pass moved them to `415`.

Receiver rules that the origin's audit and review turned into fixes:

- **Tenant from the token only.** Each event's project reference must name the token's project, else a per-event `project_mismatch`; the project's privacy class is the ceiling (`privacy_class_not_allowed`).
- **Liveness survives retries.** Update "last signal" whenever a batch contains at least one *valid* event, accepted **or duplicate**: a producer retrying after a failed bookkeeping write otherwise never refreshes the signal. Move it forward only, and cap it by the database clock so a producer clock cannot set it in the future.
- **Use the database clock for shared windows.** Rate-limit windows keyed by `date_trunc('minute', now())` in the database, not by each serverless instance's clock; compute `Retry-After` from the same clock.
- **Insert in a fixed order.** Sort rows by the unique key before a multi-row insert so concurrent overlapping batches take locks in one order.
- **Bound destructive jobs.** Retention purges delete in batches within a time budget and report `{deleted, batches, complete}`; the next run continues. Answer `401` before revealing "not configured".
- Producers spool unsent events locally (bounded, oldest-first eviction), never the token. Latency and size targets stay **hypotheses** until a load test records them.

## 8. Translate tool-native telemetry where it is born

Many tools already export OTLP. Translate it into your envelope, then validate. Prefer translating **on the user's machine** (a local receiver in your collector) over a public server endpoint: a server edge receives identity attributes over the network before it can drop them, and needs a new public endpoint. Because you cannot fix a third-party tool's configuration, the translator **reads by allowlist** — it never copies anything else:

- Read only the metric names you map and, from their attributes, only the keys you need (the origin: session id, model, token type). Identity (`user.email`, account/organization IDs), terminal and resource attributes are never copied. Put canary values for them in your test vectors and scan the output.
- Turn only the signals you need on (metrics), never logs or traces that can carry prompt or tool content; turn off optional identity attributes where the tool allows.
- Hash session identifiers with a per-installation salt — the same function your hooks use, so both sources land on one thread.
- **Temporality:** use delta points as-is; turn cumulative points into deltas against a per-series baseline where the first point only sets the baseline (it can under-count once after a restart; it never double-counts) and a counter going backwards starts a new baseline.
- **Attribution:** telemetry is often machine-wide. Forward only sessions you can attribute to an opted-in project (a local session → project map written by your hooks); drop the rest **locally** and count them in a status command.
- **Label approximations.** If the tool calls its cost figures approximations, mark cost as estimated wherever you display it, even when token counts are exact.
- Pin semantic-convention versions per collector release while conventions are experimental.

The receiver itself is a localhost listener; harden it with the `local-companion-process-hardening` skill. Write conformance vectors for the translator — mapping tables are not evidence. Dated tool facts with sources: [`references/envelope-checklist.md`](references/envelope-checklist.md#tool-native-telemetry-facts-dated).

## Pitfalls

- **Stripping at the envelope.** It feels safer and makes producer bugs invisible.
- **Totals instead of deltas.** Retries and replays then need ordering guarantees you do not have.
- **Producer-asserted liveness.** Let the receiver derive stale from silence.
- **A privacy boundary that covers only one map.** Every string field is a channel.
- **Mapping tables as proof.** A documented mapping of hooks or metrics is a plan until a translator test runs it.
- **Case-sensitive dedupe on case-insensitive IDs.** One event, two rows.
- **`400` for configuration errors.** Producers drop good data.
- **Liveness only on newly stored events.** A retry after a partial failure leaves the signal stale forever.
- **Server-side stripping of data you could have never sent.** Translate locally when you control the collector.

## Evidence from origin project

Javi's Dog, Sprint 1b (2026-10-20); at G1 confidence was **medium** for sections 1–6 and **low** for 7–8 (raised at G2, last bullet).

- Decision: ADR-0004 (`docs/adr/0004-jgr-v0.1-envelope-and-transport.md`, `77579d9`) — three options, own envelope chosen, OTLP accepted at the edge, privacy enforced at the envelope, rejected-not-stripped.
- Spec: `docs/jgr/spec/v0.1.md` (`77579d9`, `a789674`) — rules JGR-R01…R13, privacy classes L0–L2, transport, error codes, edge rules §12.
- Implementation: `packages/jgr-spec/src/schema.ts` (strict Zod objects), `packages/jgr-spec/src/validate.ts` (allowlists, stable codes, `validateBatch` with partial acceptance).
- Vectors: 20 files in `docs/jgr/conformance/vectors/` (7 valid, 13 invalid); runner `packages/jgr-spec/test/conformance.test.ts` checks filename prefixes and code sets.
- Recorded result: `pnpm --filter @javis-dog/jgr-spec test` exit 0, 27 passed (21 conformance cases incl. a structure check + 6 unit tests); full workspace checks exit 0 (`docs/sprints/SPRINT-01b.md`). GitHub Actions CI succeeded on `77579d9` and `a789674` (`gh run list`, read at G1).
- Research-driven changes (`a789674`): `reasoning_tokens` added; dedupe aligned with CloudEvents; identity and content drop at the OTLP edge; Idempotency-Key informative only; signing design for v0.2.
- G1 probes (read-only, 2026-10-20): `validateEvent` accepted `thread_ref` set to a file path and `agent_ref` set to an email address. The spec's §3/R11 versus §11 contradiction and the "spec §7" comment in `validate.ts` (codes are in §13) were found by reading.
- Not verified: deduplication, gap detection, stale derivation, retry/backoff, spooling, OTLP translation and stripping — the gateway and collectors do not exist yet (tests owed in S3, `docs/sprints/SPRINT-01b.md` Review focus). The claim that shared vectors keep *several* implementations consistent is a hypothesis: one implementation exists.
- G2-prep update (2026-10-22): ingest-token storage implemented in Sprint 2a (`packages/projects/src/tokens.ts`, `packages/projects/src/repository.ts`, ADR-0005, `dc6ef61`) and checked on the development database after the owner issued and revoked a token in production (`docs/sprints/SPRINT-02c.md`, `2d6b87d`). The ingest gateway, deduplication, gap detection and OTLP edge are still unbuilt (planned for Sprint 3), so sections 7–8 stay **low**.
- G2 update (2026-10-28, Sprints 3a–3e): sections 7–8 raised from **low** to **medium**.
  - Ingest built (`8fd567c`, ADR-0008): token-scoped project, `project_mismatch`, privacy ceiling, per-project dedupe, 256 KB after gzip, 60 batches/min/token. Live smoke against production 7/7: unknown token 401, `project_mismatch` at index 1, retry → `duplicates: 1`, one row stored, signal set, cleanup cascaded (`docs/sprints/SPRINT-03a.md`); re-run 7/7 after hardening (`SPRINT-03d.md`).
  - SDK delivery built (`07dfa99`, ADR-0009): batches, gzip, full jitter + `Retry-After`, keep on 401/403, halve on 413, drop on 400, file spool; SDK → real handler on an embedded Postgres: 120 events, one network failure retried, resend deduplicated (`SPRINT-03b.md`).
  - Hardening after an adversarial audit (`b710bee`, `048dad1`, `98c7974`; ADR-0008/0009 *Changes*): canonical IDs + check constraint (migration `0003`), signal on accepted-or-duplicate with database-clock cap (`packages/event-store/src/events.ts` l. 201), DB-clock rate window (l. 124), sorted inserts (l. 102), bounded purge, `415` with the SDK keeping its spool, more than 100 events → `413`. 43 independent HTTP vectors; mutation 415 → 400 failed exactly vectors 32–34.
  - Local OTLP translation (ADR-0011, `385e6af`, `37ac271`, `95a4b5a`): allowlist parser, delta/cumulative handling, deterministic UUIDv8-layout IDs (`collectors/claude-code/src/usage.ts` l. 67–74), session attribution with local drops. 40 independent vectors incl. identity canaries; mutation "random event ids" failed exactly vectors 39–40; retried export → `duplicates: 1` end to end on an embedded Postgres (`SPRINT-03e.md`).
  - Still not verified: sequence-gap detection and stale derivation (dashboard work not yet built); latency and size targets; the OTLP path inside a real host-tool session, including whether the telemetry session id equals the hook session id (UNVERIFIED; unmatched usage is dropped, never misattributed).
