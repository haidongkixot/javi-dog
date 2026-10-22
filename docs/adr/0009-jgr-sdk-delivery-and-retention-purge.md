# ADR-0009: JGR SDK delivery (batching, retry, spool) and the retention purge job

- Status: **Accepted** 2026-10-23 (owner asked for "batching, retry with jitter, spool" and the daily purge; ADR-0008 fixed retention at 30 days)
- Date: 2026-10-23
- Deciders: Project owner (Hai), Claude (implementer)
- Modules: JD-M02 (new), JD-M06, JD-APP; consumer JD-C01 (S3c)

## Context and problem statement

Collectors need one library that turns tool signals into valid JGR events and delivers them per spec §8: batches of ≤ 100 events / 256 KB, retry `429`/`5xx` with full-jitter backoff (base 1 s, cap 60 s) honouring `Retry-After`, never retry `400/401/403/413` unchanged, and spool unsent events locally (bounded, oldest-first eviction). Claude Code hooks (S3c) run as **short-lived processes**, one per hook, often concurrently — so delivery state cannot live only in memory. Separately, ADR-0008 left the 30-day purge unscheduled.

## Considered options

### Spool storage

1. **One file per event** in a private directory (`<event_id>.json`, written to a temp name then renamed). ULIDs sort by time, so a directory listing is the queue.
2. A single append-only JSONL file (needs locking and compaction across concurrent processes).
3. SQLite (native dependency).

### Purge scheduling

1. **Vercel Cron (daily) → `GET /api/cron/purge-events`** authenticated with `CRON_SECRET`.
2. Neon `pg_cron` (extension availability on the plan unverified).
3. Purge opportunistically inside ingest requests (adds latency and work to the hot path).

## Decision outcome

- **SDK (`@javis-dog/jgr-sdk`):** `createJgrClient({ endpoint, token, producerId, spool })` with `record(input)` (fills `jgr`, a monotonic ULID `event_id`, `producer_id`, `occurred_at`, a per-thread `sequence`; validates with JD-M01 and spools only valid events) and `flush()` (sends the spool in batches). No new dependency: `fetch`, `node:zlib` gzip above 1 KB, `node:fs`.
- **Delivery rules:** `202` → remove the batch from the spool; per-event rejections go to `onRejected`. `429`/`5xx`/network error → retry up to 5 attempts per flush with full jitter, or `Retry-After` when present (capped at 60 s), then keep the events for the next flush. `401`/`403` → stop and keep the spool (fix the token, nothing is lost). `413` → halve the batch and resend (a changed request); a single event that is still too large is dropped and reported. `400` → drop the batch and report (a malformed batch never becomes valid by retrying).
- **Spool: option 1.** `FileSpool(dir, { maxEvents: 10 000 })` evicts the oldest files beyond the limit and reports the count; `MemorySpool` for long-lived producers and tests. Two processes flushing at once may send the same events; the receiver deduplicates (ADR-0008), so this is safe by design. The spool holds L0 events only — never the token.
- **Sequence:** an in-memory counter per `thread_ref` (or a caller-provided value). Persisting it across short-lived hook processes is a collector concern (S3c).
- **Purge: option 1**, daily at 20:00 UTC (03:00 GMT+7). The route compares `Authorization: Bearer <CRON_SECRET>` in constant time; without `CRON_SECRET` it answers `503 not_configured` and deletes nothing. It deletes events received more than 30 days ago (`EVENT_RETENTION_DAYS`, JD-M06) and rate windows older than one hour, and returns the deleted count only.

## Consequences

- Positive: hook processes stay fast (append a file, optional flush); outages and restarts lose nothing until the spool limit; retries never inflate counters.
- Negative: one file per event costs inodes (bounded at 10 000); sequences from separate processes may interleave until S3c persists them; the purge only runs once the owner sets `CRON_SECRET` on Vercel.
- Follow-up: S3c persists sequences per thread and wires hooks to `record`/`flush`; S5 load-tests delivery and revisits the batch/flush policy.
