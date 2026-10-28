# JGR v0.1 HTTP conformance vectors (ADR-0008 ingress)

Black-box HTTP cases for the JD-M05 ingest gateway endpoint `POST /api/v1/events`.

- **Oracle independence.** Every expectation is derived only from contract text: [ADR-0008](../../../adr/0008-events-retention-and-ingress.md) including its **Changes** section dated 2026-10-28 (normative; it overrides older lines of the same ADR), [ADR-0009](../../../adr/0009-jgr-sdk-delivery-and-retention-purge.md) where it states receiver behaviour, and [JGR spec v0.1](../../spec/v0.1.md). Event shapes follow the single-event vectors in [`../vectors/`](../vectors/). No implementation code or test was read to write them (QA role, [`TEAM.md`](../../../agent-ops/TEAM.md)).
- **Format.** One JSON file per case, `<NN>-<kebab-name>.json`, valid against [`schema.json`](schema.json) (JSON Schema draft-07).
- **Status.** Written 2026-10-28 for S3d task P2. The runner is `packages/ingest/test/conformance.test.ts` (Developer lane, planned). Cases where the contract can be read more than one way are marked `AMBIGUOUS` in their `description` and listed under [Ambiguities](#ambiguities).
- **Lineage.** The file format is adapted from a superseded attempt on branch `backup/s3a-parallel`, which targeted a different contract. None of its expectations were reused.

## Vector file format

```json
{
  "$schema": "./schema.json",
  "description": "What the case proves",
  "contract": "ADR-0008 <section> / spec §N",
  "setup": {
    "token": "valid",
    "project": { "slug": "demo-app", "privacy_class": "L0" },
    "preload": [],
    "otherProjects": [],
    "requestsAlreadyInWindow": 0
  },
  "request": {
    "method": "POST",
    "path": "/api/v1/events",
    "headers": { "content-type": "application/json" },
    "gzip": false,
    "body": { "events": [] },
    "rawBody": null,
    "bodyPadBytes": null
  },
  "expect": {
    "status": 202,
    "headers": {},
    "errorCode": null,
    "accepted": 1,
    "duplicates": 0,
    "rejected": [],
    "lastSignal": null,
    "equivalenceGroup": null
  }
}
```

All keys are always present (unused ones are `null`, `[]` or `{}`), so a runner never has to guess a default.

### `setup`

| Field | Meaning |
|---|---|
| `token` | How the runner obtains `$TOKEN` for the setup project (see [Tokens](#tokens)). |
| `project.slug` | Slug of the project the token belongs to (`$PROJECT_SLUG`). |
| `project.privacy_class` | The project's opted-in class, the ceiling for its events (`L0` < `L1` < `L2`). |
| `preload` | Events stored for the setup project before the probe request (see [Preload](#preload)). |
| `otherProjects` | Extra projects in the **same workspace**, each with its own valid token and its own `preload`. Their events use the literal slug as `project_ref`. |
| `requestsAlreadyInWindow` | Number of [rate-limit filler](#rate-limit-filler) requests sent with `$TOKEN` in the probe's UTC minute, immediately before the probe. |

### `request`

| Field | Meaning |
|---|---|
| `method`, `path` | Always `POST /api/v1/events`, relative to the deployment base URL (or passed to the handler in process). |
| `headers` | Request headers, lower-case names, sent **exactly** (no header is added except by the two rules below). `$TOKEN` inside a value is replaced by the token. |
| `gzip` | `true`: gzip the final body bytes and send `Content-Encoding: gzip` unless `headers` sets `content-encoding`. |
| `body` | JSON value, serialized compactly (`JSON.stringify` without spacing) after placeholder substitution. Elements of `events` may be deliberately invalid. |
| `rawBody` | Exact UTF-8 body string, used instead of `body` (malformed JSON). No placeholder substitution. |
| `bodyPadBytes` | Append ASCII spaces (`0x20`) to the serialized body until it is at least this many bytes, **before** gzip (see [Padding](#padding)). |

Body bytes are built in this order: serialize `body` (or take `rawBody`) → pad → gzip. The runner sends the body as raw bytes, so the HTTP client does not add a `Content-Type` of its own (vector 33 sends none).

Header rules: (1) unless `headers` contains `authorization`, the runner sends `Authorization: Bearer $TOKEN` for every `token` value except `missing`, which sends no `Authorization` header; (2) the `gzip` rule above.

### `expect`

| Field | Meaning |
|---|---|
| `status` | Exact HTTP status. |
| `headers` | Response header [matchers](#matchers). Names compare case-insensitively; headers not listed are not checked. |
| `errorCode` | For non-2xx: required value of the body's `error` string, only where ADR-0008 names a code (`unsupported_media_type`, `too_large`). `null`: the value is not checked. Always `null` for `202`. |
| `accepted`, `duplicates` | For `202`: exact counts. `null` otherwise. |
| `rejected` | For `202`: the exact list of rejected entries, ordered by `index`. `null` otherwise. |
| `lastSignal` | Store-level side effect on the setup project's `last_signal_at`: `advanced`, `unchanged`, or `null` (not checked). See [Signal check](#signal-check). |
| `equivalenceGroup` | Vectors sharing a group MUST produce identical responses (see [Equivalence groups](#equivalence-groups)). |

Each `rejected` entry is `{ "index", "event_id", "codes" }`. The response entry at that position MUST have the same `index`; its `event_id` MUST equal the expected string (or JSON `null`, or satisfy the matcher object); and its `issues` array's set of distinct `code` values MUST equal `codes` exactly (order-insensitive). Every issue MUST carry `code`, `path` and `message` (spec §8); `path` and `message` values are not checked ("codes are stable; messages are not", spec §13).

## Runner rules

### Isolation

Run each vector against a **fresh** project with a fresh token, an empty event store and an untouched rate-limit window. Vectors reuse event-id shapes on purpose; sharing a project between vectors turns accepted events into duplicates. If the runner must reuse a workspace, it MAY rename `demo-app` and `other-app` to unique slugs, but MUST rename every occurrence in the vector consistently.

### Placeholders

Substitution applies to whole string values in `body`, `setup.preload` and `setup.otherProjects[].preload`. `$TOKEN` is the only placeholder substituted inside a longer string, and only in `request.headers`.

| Placeholder | Value |
|---|---|
| `$PROJECT_ID` | The setup project's id, as the platform assigned it. |
| `$PROJECT_SLUG` | The setup project's slug. |
| `$TOKEN` | The token chosen by `setup.token`. |
| `$NOW` | Runner UTC clock when it builds that request, as `YYYY-MM-DDTHH:MM:SSZ` (whole seconds, `Z` offset). |
| `$NOW±<n><unit>` | `$NOW` shifted by `n` units; unit is `s`, `m`, `h` or `d` (days of 86 400 s). Examples: `$NOW-30s`, `$NOW+6m`. |

The runner clock MUST be within 30 s of the receiver clock; otherwise the time-based vectors (24, 25) report BLOCKED. Each keeps a one-minute margin from the 5-minute limit (spec §10).

### Tokens

| `token` | How the runner gets `$TOKEN` |
|---|---|
| `valid` | Issue an active ingest token for the setup project. |
| `revoked` | Issue a token for the setup project, then revoke it through the product's revocation path (JD-M04) and confirm the revocation finished before the probe. |
| `unknown` | Never issued, but shaped like an issued token: take a freshly issued valid token and replace its last 8 characters with different characters of the same character class. Do not issue the result; confirm it differs from every issued token. |
| `malformed` | The literal string `not-a-token`. |
| `missing` | No token; no `Authorization` header. |

### Preload

Store each `preload` list with one `POST /api/v1/events` request, body `{ "events": <preload> }`, sent with a valid token of that project. The setup response MUST be `202` with `accepted` equal to the list length, `duplicates` 0 and `rejected` empty; otherwise the vector reports BLOCKED (setup failed), not FAIL. A runner MAY insert the rows by another path only if it produces the same stored state (canonical ids included). A preload request counts towards that token's rate-limit window; no vector combines a preload with fillers.

### Rate-limit filler

A filler request is `POST /api/v1/events`, `Content-Type: application/json`, `Authorization: Bearer $TOKEN`, body:

```json
{
  "events": [
    {
      "jgr": "0.1",
      "event_id": "01JBZ4XQ8000000000000ZZZZZ",
      "producer_id": "prod_filler",
      "project_ref": "$PROJECT_SLUG",
      "thread_ref": "s_ffffffffffffffffffffffffffffffff",
      "sequence": 1,
      "type": "heartbeat",
      "status": "working",
      "occurred_at": "$NOW-30s"
    }
  ]
}
```

The first filler answers `202` with `accepted` 1, later ones `202` with `duplicates` 1. A `429` on any filler is a **FAIL** (the limit is below 60); any other non-202 is BLOCKED.

The window is the UTC minute on the **database clock** (ADR-0008 Changes H6: `date_trunc('minute', now())`). The runner starts the first filler within 2 s after a minute boundary of that clock (read it with `select now()`, or use the process clock when the database runs in process) and sends the probe no later than 45 s after the same boundary. If it cannot, the vector reports NOT RUN; it is never rerun blindly.

### Padding

Size cases need large bodies without breaking any other rule. Extra attributes would trip the L0 allowlist and the 128-character value limit, and large events would hit the 8 KB per-event limit. Padding is therefore **JSON insignificant whitespace** (RFC 8259 §2) after the closing brace: the padded body is the same valid batch, only bigger. The limit applies to bytes after decompression, so whitespace counts. Vector 06 pads to 200 000 bytes (expects acceptance); vectors 35 and 36 pad to 300 000 bytes (expect `413`). Both values clear either reading of "256 KB" (256 000 or 262 144 bytes). Vector 36 gzips the padded body: about 0.5 KB on the wire, 300 000 bytes inflated.

### Matchers

A matcher is either a string (exact equality after placeholder substitution) or an object combining these checks:

| Key | Check |
|---|---|
| `equals` | Value equals the given JSON value. |
| `pattern` | Value matches the ECMAScript regular expression (anchor it yourself). |
| `integerMin`, `integerMax` | Value is a decimal integer string (`^[0-9]+$` for headers) or JSON integer, within the inclusive bounds. |
| `present` | The header or field exists (any value, `null` included). |
| `absent` | The header or field does not exist. |

Header values are compared after trimming surrounding whitespace.

### Body shape

The response body MUST parse as JSON in every vector.

| Status | Required body |
|---|---|
| `202` | An object with `accepted` (integer), `duplicates` (integer) and `rejected` (array), spec §8. Other keys are not checked. |
| Any non-2xx | An object whose `error` is a non-empty string; equal to `expect.errorCode` when that is not `null`. Other keys (`message`, `issues`) are not checked. |

### Signal check

`lastSignal` is a side effect, not an HTTP field: the runner needs read access to the store (JD-M06) for the setup project's `projects.last_signal_at`. A pure HTTP runner reports this check NOT RUN separately and never folds it into PASS.

1. Read `last_signal_at` right before the probe (`S0`; `null` if never set). When `lastSignal` is not `null`, wait at least 1 s after the last setup request before reading.
2. Send the probe; read `last_signal_at` again (`S1`).
3. `advanced`: `S1` is not `null` and (`S0` is `null` or `S1` > `S0`). `unchanged`: `S1` equals `S0` (both `null` counts as equal).

Token `last_used_at` is not checked: ADR-0008 Changes H2 writes it at most once a minute, so a preload in the same minute hides the probe's write.

### Equivalence groups

All vectors with the same `equivalenceGroup` MUST return the same status, the same values for the headers listed in `expect.headers`, and the same `error` value. Group `events-401` (vectors 27–31) checks that missing, malformed, wrong-scheme, unknown and revoked tokens get one answer. Messages and timing are out of scope.

### Results

Report one of PASS, FAIL, BLOCKED, NOT RUN or SKIPPED per vector, following the Orcasus contract: BLOCKED means setup or environment could not support the claim; it is never counted as PASS.

## Vectors

43 vectors.

| # | Vector | Case | Expect |
|---|---|---|---|
| 01 | [`01-valid-single-event.json`](01-valid-single-event.json) | One valid L0 heartbeat, `project_ref` = slug | 202 accepted 1; signal advanced |
| 02 | [`02-project-ref-id.json`](02-project-ref-id.json) | `project_ref` = project id | 202 accepted 1 |
| 03 | [`03-valid-mixed-batch.json`](03-valid-mixed-batch.json) | Session, subagent (UUID id), usage, attention and extension events | 202 accepted 5 |
| 04 | [`04-gzip-body.json`](04-gzip-body.json) | gzip body | 202 accepted 1 |
| 05 | [`05-content-encoding-identity.json`](05-content-encoding-identity.json) | `Content-Encoding: identity` | 202 accepted 1 |
| 06 | [`06-padded-body-under-cap.json`](06-padded-body-under-cap.json) | Whitespace-padded body of 200 000 bytes | 202 accepted 1 |
| 07 | [`07-batch-100-events-accepted.json`](07-batch-100-events-accepted.json) | 100 valid events | 202 accepted 100 |
| 08 | [`08-partial-acceptance.json`](08-partial-acceptance.json) | Valid event + unknown top-level event field | 202 accepted 1, rejected [1] `schema`; signal advanced |
| 09 | [`09-all-rejected-still-202.json`](09-all-rejected-still-202.json) | Heartbeat without status, usage without delta | 202 accepted 0, rejected [0] `status_required`, [1] `usage_required`; signal unchanged |
| 10 | [`10-duplicate-within-batch.json`](10-duplicate-within-batch.json) | Same event twice in one batch | 202 accepted 1, duplicates 1 |
| 11 | [`11-duplicate-within-batch-case-variant.json`](11-duplicate-within-batch-case-variant.json) | ULID and its lower-case spelling in one batch | 202 accepted 1, duplicates 1 |
| 12 | [`12-duplicate-of-preloaded-retry.json`](12-duplicate-of-preloaded-retry.json) | Retry of a stored event | 202 accepted 0, duplicates 1; signal advanced |
| 13 | [`13-duplicate-ulid-lowercase-variant.json`](13-duplicate-ulid-lowercase-variant.json) | Lower-case spelling of a stored ULID | 202 accepted 0, duplicates 1 |
| 14 | [`14-duplicate-ulid-uppercase-of-lowercase-preload.json`](14-duplicate-ulid-uppercase-of-lowercase-preload.json) | Stored via lower-case ULID, retried upper-case | 202 accepted 0, duplicates 1 |
| 15 | [`15-duplicate-uuid-uppercase-variant.json`](15-duplicate-uuid-uppercase-variant.json) | Upper-case spelling of a stored UUID | 202 accepted 0, duplicates 1 |
| 16 | [`16-duplicate-across-slug-and-id-ref.json`](16-duplicate-across-slug-and-id-ref.json) | Stored via slug, retried via project id | 202 accepted 0, duplicates 1 |
| 17 | [`17-same-event-id-other-producer.json`](17-same-event-id-other-producer.json) | Same `event_id`, other `producer_id` | 202 accepted 1 |
| 18 | [`18-same-key-other-project.json`](18-same-key-other-project.json) | Same key stored in another project | 202 accepted 1, duplicates 0 |
| 19 | [`19-project-ref-unregistered-mismatch.json`](19-project-ref-unregistered-mismatch.json) | Unregistered slug | 202 accepted 1, rejected [1] `project_mismatch` |
| 20 | [`20-project-ref-other-project-mismatch.json`](20-project-ref-other-project-mismatch.json) | Slug of another project in the workspace | 202 accepted 1, rejected [1] `project_mismatch` |
| 21 | [`21-privacy-l1-on-l0-project.json`](21-privacy-l1-on-l0-project.json) | L1 event, L0 project | 202, rejected [0] `privacy_class_not_allowed`; signal unchanged |
| 22 | [`22-privacy-l1-on-l1-project-accepted.json`](22-privacy-l1-on-l1-project-accepted.json) | L1 and L0 events, L1 project | 202 accepted 2 |
| 23 | [`23-privacy-l2-on-l1-project.json`](23-privacy-l2-on-l1-project.json) | L2 event, L1 project | 202, rejected [0] `privacy_class_not_allowed` |
| 24 | [`24-clock-skew-6-min-ahead.json`](24-clock-skew-6-min-ahead.json) | `occurred_at` = `$NOW+6m` | 202, rejected [0] `clock_skew` |
| 25 | [`25-clock-skew-4-min-ahead-accepted.json`](25-clock-skew-4-min-ahead-accepted.json) | `occurred_at` = `$NOW+4m` | 202 accepted 1 |
| 26 | [`26-event-id-uuid-without-hyphens.json`](26-event-id-uuid-without-hyphens.json) | 32-hex `event_id` without hyphens | 202 accepted 1, rejected [1] `schema` (`event_id` value not checked) |
| 27 | [`27-token-missing.json`](27-token-missing.json) | No `Authorization` | 401, `WWW-Authenticate: Bearer` |
| 28 | [`28-token-malformed.json`](28-token-malformed.json) | `Bearer not-a-token` | 401, `WWW-Authenticate: Bearer` |
| 29 | [`29-token-wrong-scheme.json`](29-token-wrong-scheme.json) | Valid token with `Basic` scheme | 401, `WWW-Authenticate: Bearer` |
| 30 | [`30-token-unknown.json`](30-token-unknown.json) | Well-formed, never issued | 401, `WWW-Authenticate: Bearer` |
| 31 | [`31-token-revoked.json`](31-token-revoked.json) | Revoked token | 401, `WWW-Authenticate: Bearer` |
| 32 | [`32-content-type-text-plain.json`](32-content-type-text-plain.json) | `Content-Type: text/plain` | 415 `unsupported_media_type` |
| 33 | [`33-content-type-missing.json`](33-content-type-missing.json) | No `Content-Type` (AMBIGUOUS) | 415 `unsupported_media_type` |
| 34 | [`34-content-encoding-br.json`](34-content-encoding-br.json) | `Content-Encoding: br` | 415 `unsupported_media_type` |
| 35 | [`35-body-over-256kb.json`](35-body-over-256kb.json) | 300 000-byte uncompressed body | 413 (code not checked) |
| 36 | [`36-gzip-decompressed-over-256kb.json`](36-gzip-decompressed-over-256kb.json) | gzip bomb: ~0.5 KB inflating to 300 000 bytes | 413 (code not checked) |
| 37 | [`37-batch-101-events.json`](37-batch-101-events.json) | 101 valid events | 413 `too_large` |
| 38 | [`38-malformed-json.json`](38-malformed-json.json) | `{"events": [` | 400 |
| 39 | [`39-empty-object.json`](39-empty-object.json) | `{}` | 400 |
| 40 | [`40-extra-top-level-field.json`](40-extra-top-level-field.json) | `events` plus another top-level field (AMBIGUOUS) | 400 |
| 41 | [`41-events-not-array.json`](41-events-not-array.json) | `events` is an object | 400 |
| 42 | [`42-rate-limit-60th-accepted.json`](42-rate-limit-60th-accepted.json) | 60th batch in the UTC minute | 202 accepted 1 |
| 43 | [`43-rate-limit-61st-request.json`](43-rate-limit-61st-request.json) | 61st batch in the UTC minute | 429, `Retry-After` integer 1–60 |

Every non-202 vector also checks the `error` string body (see [Body shape](#body-shape)).

### Not covered

| Contract item | Why |
|---|---|
| `503` on database failure and `503 not_configured` without a database (ADR-0008 transport handling) | Needs a deployment without a database or an injected outage; integration-only. |
| Token `last_used_at` (Changes H2) | Written at most once a minute; see [Signal check](#signal-check). |
| `last_signal_at` "only moves forward" (Changes H2) | Needs a crafted older receipt time; not reachable through one HTTP request. |
| Insert order under concurrency (Changes H5), shared window across skewed instances (Changes H6) | Need concurrent requests or several receiver instances; not a single-request vector. |
| Retention purge (Changes H3, ADR-0009) | Separate route (`GET /api/cron/purge-events`), not this endpoint. |
| Migration `0003` check constraint (Changes H1) | Database-level; not observable over HTTP. |
| 8 KB per-event limit (spec §8) | ADR-0008 gives no status or issue code for it (A17). |
| Order of checks (415 / 401 / 413 / 429 / 400) | Not stated (A16); every vector has exactly one fault. |

## Ambiguities

Line numbers refer to `docs/adr/0008-events-retention-and-ingress.md` (ADR) and `docs/jgr/spec/v0.1.md` (spec) at commit `612c2a7`.

| ID | Contract text | Question | Vector choice |
|---|---|---|---|
| A1 | ADR L37; spec L101 "256 KB" | 256 000 or 262 144 bytes? | Margins only (200 000 accepted, 300 000 rejected); exact boundary untested. |
| A2 | ADR L37, L52 | The error **body** is never described: only codes appear (`415 unsupported_media_type`, `413 too_large`, `503 not_configured`). Field name (`error`), flat string vs object, `message`/`issues` are not stated. | Body MUST be an object with an `error` string (taken from the QA brief, not from ADR text); its value is checked only where the ADR names a code. |
| A3 | ADR L37 "→ `413`"; L52 "More than 100 events → `413 too_large`" | Does the body-size `413` also carry `too_large`? | Vector 37 checks `too_large`; vectors 35 and 36 check status only. |
| A4 | ADR L52 "a `Content-Type` other than `application/json`" | Is a missing header "other"? Are parameters (`; charset=utf-8`) or upper-case allowed? | Vector 33 (AMBIGUOUS) expects 415 for a missing header; parameters and casing untested. |
| A5 | ADR L52 "absent/`identity`/`gzip`" | Casing (`GZIP`), stacked encodings (`gzip, identity`), or `gzip` with a body that is not a gzip stream (400 or 415)? | Untested. |
| A6 | ADR L37 "batch shape → `400`"; spec L100 body `{ "events": [ ... ] }`; spec L64 JGR-R11 covers event fields only | Is an extra top-level batch field a 400? | Vector 40 (AMBIGUOUS) expects 400. |
| A7 | ADR L37 "batch shape" | Is `{"events": []}` a 400 or a 202 with zero counts? Is a non-object element (`42`) a 400 or a per-event `schema` rejection? | Untested. |
| A8 | ADR L37 "`WWW-Authenticate: Bearer`" | Exact value, or may it carry RFC 6750 parameters (`realm`, `error="invalid_token"`)? | Pattern `^Bearer(\s.*)?$`. |
| A9 | ADR L37 "Missing/malformed/unknown/revoked token → `401`" | Must the four cases be indistinguishable (same `error`)? Is a non-Bearer scheme "missing"? Is the scheme name case-insensitive? Spec L107 also allows `403`. | Group `events-401` requires the same status, header and `error`; vector 29 (`Basic`) expects 401; scheme casing untested; `403` not expected. |
| A10 | ADR L37 | The token format is not in ADR-0008, so "malformed" vs "unknown" is runner-defined. | See [Tokens](#tokens). |
| A11 | ADR L35 "Retry-After = seconds to the next window"; L53 | Rounding (a probe 0.4 s before the boundary: `0` or `1`)? Do 401/415/413/400 requests count towards the window? | Probe sent ≤ 45 s into the window, so `Retry-After` 1–60 holds under any rounding; which requests count is untested. |
| A12 | ADR L50 (H1) | Does a rejected entry echo the raw `event_id` or its canonical form? | Rejected events always carry an already-canonical id; vector 26 checks only that `event_id` is present. |
| A13 | ADR L50 "strict UUID shape" | Undefined: hyphen positions only, or also version/variant nibbles and braces? | Vector 26 uses hyphenless 32-hex, which fails every reading. |
| A14 | ADR L51 (H2) "at least one valid event, accepted **or** duplicate" | Does an event that passes spec validation but fails a tenant rule (`project_mismatch`, `privacy_class_not_allowed`) count as valid? | Read literally: it is neither accepted nor duplicate, so vector 21 expects `unchanged`. |
| A15 | ADR L38 "Duplicates alone do not refresh the signal" vs L51 (H2) | Conflict. | H2 (Changes) wins: vector 12 expects `advanced`. |
| A16 | ADR L37; spec L105–L107 | Order of checks when one request has several faults is not stated. | Not covered; one fault per vector. |
| A17 | spec L101 "≤ 8 KB per event" | No status or issue code in ADR-0008 (per-event `too_large` or batch `413`?). | Not covered. |
| A18 | ADR L36 "must equal the project's slug or id" | Case-insensitive match (upper-case id, slug casing)? | Untested. |
| A19 | ADR L33, L36 | A retry of a stored event that now fails a tenant rule, or a duplicate whose first copy in the batch was rejected: duplicate or rejected? | Untested. |
| A20 | spec L106 | Are the listed `202` body keys exhaustive (would an extra `request_id` break conformance)? | Presence and types only; extra keys allowed. |
