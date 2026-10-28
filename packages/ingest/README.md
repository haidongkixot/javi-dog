# JD-M05 · `@javis-dog/ingest` — JGR ingress

Status: **in-progress**. S3a: `POST /api/v1/events` logic (JGR v0.1 §8, ADR-0008). OTLP/HTTP receiver: S3c.

## Public contract

| Export | Description |
|---|---|
| `createIngestHandler(deps)` | `(Request) => Promise<Response>`: bearer token → rate limit → bounded body → JD-M01 validation → project scope + privacy ceiling → idempotent insert → verified signal → optional `onStored` hook |
| `IngestDeps.onStored?(scope, { usageReports })` | ADR-0014 budget alerts. Called once per request, after the insert and signal writes succeeded, when the batch had ≥ 1 valid `usage.reported` for the token's project — **stored or duplicate**, so a retry after a 503 still triggers it (the consumer, `claimAlert`, is idempotent). Not awaited; a throw or rejection is logged by class name and never changes the response. The app schedules work with Next.js `after()` |
| `createIngestDeps(db)` | Wires JD-M04 `verifyToken` / `markTokenUsed` and JD-M06 event repository onto a Drizzle handle |
| `readBoundedBody(request, maxBytes)` | Streams the body, inflating gzip, and stops as soon as `maxBytes` is passed |
| `INGEST_RATE_LIMIT_PER_MINUTE` | 60 batches per token per UTC minute |
| `MAX_JSON_DEPTH`, `exceedsJsonDepth(text)` | 32 nested arrays/objects; a deeper body is `400 malformed` before parsing (S5a review L3) |

## Responses

| Status | When |
|---|---|
| `202` | `{ accepted, duplicates, rejected: [{ index, event_id, issues }] }` — partial acceptance |
| `400` | Bad JSON or batch shape |
| `415` | `Content-Type` not `application/json`, or `Content-Encoding` not absent/`identity`/`gzip` (S3d) |
| `401` | Missing, malformed, unknown or revoked token (`WWW-Authenticate: Bearer`) |
| `413` | Over 256 KB after decompression, or more than 100 events |
| `429` | Over the rate limit (`Retry-After`) |
| `503` | Database failure (logged as error class only) or no database (`not_configured`, from the route) |

Live check of a deployment: `pnpm --filter @javis-dog/ingest smoke:live` with `DATABASE_URL` set to that deployment's database (optional `INGEST_URL`, default production). It creates a throwaway workspace, posts real batches, checks the rows and deletes everything.

Receiver-side issue codes: `project_mismatch`, `privacy_class_not_allowed` (spec §13). Tests run on PGlite with JD-M06's committed migrations.
