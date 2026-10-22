# ADR-0008: JGR ingress — events table, retention, rate limiting and tenant rules

- Status: **Accepted** 2026-10-23 (owner answered Q1–Q3 in `docs/agent-ops/DISCOVERY_SUMMARY.md` §Delta S3)
- Date: 2026-10-23
- Deciders: Project owner (Hai), Claude (implementer)
- Modules: JD-M05 (new), JD-M06, JD-M04, JD-M01, JD-APP

## Context and problem statement

S3 proves the signal path: collectors send JGR batches (spec v0.1 §8) to `POST /api/v1/events`. We need a place to store events, a retention rule, rate limiting on a serverless host with no Redis, and rules that keep one tenant's events out of another's. Constraints: Neon over HTTP (one round trip per query, no interactive transactions), Vercel functions, Hobby cron at most daily, Neon free tier assumed (0.5 GB, plan UNKNOWN).

## Considered options

### Storage

1. **One `events` table owned by JD-M06**, plain (no partitions), indexed for dedupe, per-thread reads and purge.
2. Monthly declarative partitions (cheap `DROP PARTITION` purge, but partitions must be created ahead of time by a job).
3. Raw events only in a log drain / object storage; aggregates in Postgres.

### Retention

1. 7 days · 2. **30 days** · 3. 90 days — raw events; longer history from daily aggregates (S4).

### Rate limiting

1. **Postgres fixed window per ingest token** (`ingest_rate_windows`, atomic upsert).
2. Vercel Firewall rate-limit rule (owner must configure; plan limits unverified).
3. Upstash Redis (new service, account and env vars).

## Decision outcome

- **Storage: option 1.** `events(id uuid pk, workspace_id, project_id, producer_id, event_id, thread_ref, agent_ref, sequence bigint, type, status, privacy_class, occurred_at, received_at default now(), usage_delta jsonb, attributes jsonb, encrypted jsonb)`. `(project_id, workspace_id)` references `projects(id, workspace_id)` on delete cascade (same pattern as `ingest_tokens`). Indexes: unique `(project_id, producer_id, event_id)`, `(project_id, thread_ref, received_at)` for live state (S4), `(received_at)` for purge. Revisit partitioning (option 2) above ~10 M rows or when purge runs exceed 10 s.
- **Dedupe key is scoped by project.** The spec's key is (`producer_id`, `event_id`); scoping it by `project_id` stops one tenant from pre-claiming another tenant's ids. `INSERT … ON CONFLICT DO NOTHING` also collapses duplicates inside one batch.
- **Retention: 30 days of raw events** (owner Q1), by `received_at`. `purgeEventsBefore(cutoff)` ships now; the daily Vercel Cron route protected by `CRON_SECRET` ships in S3b (needs the owner to add the secret). Until then nothing is purged — recorded, not hidden.
- **Rate limit: option 1** (owner Q2). 60 batches per token per UTC minute (≈ 6 000 events/min at 100 per batch). Over the limit → `429` with `Retry-After` = seconds to the next window. Windows older than 1 hour are purged with events.
- **Tenant rules (new spec codes):** the token fixes the project. Each event's `project_ref` must equal the project's slug or id, else the event is rejected with `project_mismatch`. The project's `privacy_class` is the opt-in ceiling (product rule 3): an event with a higher class is rejected with `privacy_class_not_allowed`. Both are per-event rejections inside a `202`, like other validation issues.
- **Transport handling:** body read as a stream with a hard limit of 256 KB *after* decompression (`Content-Encoding: gzip` via `DecompressionStream`, aborting as soon as the limit is passed) → `413`. Missing/malformed/unknown/revoked token → `401` with `WWW-Authenticate: Bearer`. Bad JSON or batch shape → `400`. DB failure → `503` (producers retry). No database → `503 not_configured`.
- **Side effects:** after ≥ 1 stored event, `projects.last_signal_at` and `ingest_tokens.last_used_at` are set to the receipt time (product rule 2). Duplicates alone do not refresh the signal.
- **Ownership:** tables and the event repository live in JD-M06 (it owns migrations; ADR-0005). JD-M05 owns HTTP/protocol logic and depends on JD-M01, JD-M04 and JD-M06 through their public indexes.

## Consequences

- Positive: no new service or dependency; dedupe and tenant isolation are enforced by Postgres; retention keeps storage within the free tier at today's volume.
- Negative: ~5 HTTP round trips per batch (auth, rate window, insert, two updates) — measure against the p95 < 2 s hypothesis in S5; the rate window adds write load per batch; until S3b no purge runs.
- Follow-up: S3b cron purge + `CRON_SECRET`; S4 derives `stale` and sequence gaps from `events`; S5 load test and partitioning review.
