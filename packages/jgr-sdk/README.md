# JD-M02 · `@javis-dog/jgr-sdk` — JGR client SDK

Status: **in-progress**. S3b: event builder, spools, batching, retry (ADR-0009). Request signing (JGR v0.2) and L2 encryption (JD-M11) come later.

```ts
import { createFileSpool, createJgrClient } from '@javis-dog/jgr-sdk';

const jgr = createJgrClient({
  endpoint: 'https://javisdog.vercel.app/api/v1/events',
  token: process.env.JAVI_INGEST_TOKEN!, // never spooled or logged
  producerId: 'prod_claude-code_7f3a',
  spool: createFileSpool(`${os.homedir()}/.javi/spool`),
});

await jgr.record({ project_ref: 'web-app', thread_ref: 'sess_2b9c', type: 'heartbeat', status: 'working' });
const result = await jgr.flush(); // { status, accepted, duplicates, rejected, dropped, remaining }
```

## Public contract

| Export | Description |
|---|---|
| `createJgrClient(options)` | `record(input)` fills `jgr`, a monotonic ULID `event_id`, `producer_id`, `occurred_at`, a per-thread `sequence`, validates with JD-M01 and spools valid events; `flush()` delivers the spool |
| `createFileSpool(dir, { maxEvents })` | One file per event (mode 0600, dir 0700), temp + rename writes, oldest-first eviction (default 10 000); safe for concurrent hook processes |
| `createMemorySpool({ maxEvents })` | Same semantics in memory |
| `createUlid(randomBytes?)` | Monotonic ULID generator |

## Delivery rules (JGR §8)

| Receiver answer | SDK behaviour |
|---|---|
| `202` | Batch removed; rejected events passed to `onRejected` |
| `429`, `5xx`, network error | Up to 5 attempts per flush, full jitter (base 1 s, cap 60 s) or `Retry-After`; then `retry_later`, spool kept |
| `401`, `403` | Stop immediately (`unauthorized`), spool kept |
| `413` | Batch halved and resent; a single event still too large is dropped (`dropped`) |
| `400` | Batch dropped and counted in `dropped` (never retried unchanged) |
| `415` | Stop (`failed`, `httpStatus: 415`), spool kept — a configuration problem, not a bad batch (S3d) |
| Other (e.g. `404`) | Stop (`failed`), spool kept |

Batches hold at most 100 events and 256 KB; bodies above 1 KB are gzip-compressed.

A caller may pass its own `event_id` (ULID or UUID, canonicalized by JD-M01) to `record()` — derive it from the source record so a re-sent record dedupes on the receiver (ADR-0011). Without one the SDK generates a monotonic ULID. The spool orders by `event_id`, so caller UUIDs do not sort by time among ULIDs: with a backlog, their delivery order and oldest-first eviction are approximate (S3e review).
