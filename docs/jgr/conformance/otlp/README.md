# Local OTLP receiver conformance vectors (ADR-0011)

Black-box cases for the local OTLP/HTTP JSON metrics receiver that the `javi` collector (JD-C01) exposes with `javi receive` on `127.0.0.1:<port>`. Each case sends one or more HTTP requests and checks the HTTP answer and the `usage.reported` events the receiver produces.

- **Oracle independence.** Every expectation comes only from the specification texts under [Sources](#sources). No implementation code or test was read to write them (QA role, [`TEAM.md`](../../../agent-ops/TEAM.md)). Where the texts can be read more than one way, the vector lists the ambiguity id and the chosen reading is in [Ambiguities](#ambiguities). No behaviour is invented silently.
- **Format.** One JSON file per case, `<NN>-<kebab-name>.json`, valid against [`schema.json`](schema.json) (JSON Schema draft-07).
- **Status.** Written 2026-10-28 for S3e task Q1. The runner is part of the U3 receiver tests (Developer lane, planned). Style follows the [HTTP ingress vectors](../http/README.md).

## Sources

| Source | Sections used |
|---|---|
| [ADR-0011](../../../adr/0011-local-otlp-usage-receiver.md) (Accepted 2026-10-28, at commit `9fc1d23`) | Normative. Context facts 2–3 and the OTLP paragraph (L14–L19); Decision outcome bullets **Receiver** (L33), **Parsing (allowlist)** (L35), **Temporality** (L36), **Mapping → JGR** (L37), **Idempotent retries** (L38), **Project attribution** (L39), **Delivery** (L40); Consequences (L47). |
| [JGR spec v0.1](../../spec/v0.1.md) | §3 envelope (`event_id` canonical UUID, opaque refs), §6 usage deltas, §7 L0 privacy, §9 dedupe, §12 edge rules and the "OTel token metrics → `usage_delta`" table. ADR-0011 (Consequences, L47) narrows §12 for the local receiver: `http/json` only. |
| OTLP specification, `opentelemetry-proto` `docs/specification.md` (branch `main`, fetched 2026-10-28; the source of opentelemetry.io/docs/specs/otlp, which was not reachable from this session) | §OTLP/HTTP → JSON Protobuf Encoding (lowerCamelCase keys, enums as integers, unknown fields MUST be ignored, 64-bit integers and `fixed64` timestamps as strings or numbers, `Content-Type: application/json` on request and response); §OTLP/HTTP Request (`/v1/metrics`, gzip, size limit after decompression → `413`); §OTLP/HTTP Response → Full Success (`200`, `ExportMetricsServiceResponse`, `partial_success` unset, empty request SHOULD succeed), Bad Data (`400`), All Other Responses (HTTP semantics). |
| [Claude Code monitoring-usage](https://code.claude.com/docs/en/monitoring-usage) (fetched 2026-10-28) | Metrics `claude_code.token.usage` (unit `tokens`; `type` = `input` / `output` / `cacheRead` / `cacheCreation`; `model`; also `query_source`, `speed`, `effort`, `skill.name` …) and `claude_code.cost.usage` (unit `USD`, `model`); Standard attributes `session.id`, `ccr.session.id`, `app.version`, `organization.id`, `user.account_uuid`, `user.account_id`, `user.id`, `user.email`, `terminal.type`; temporality default `delta`. |
| RFC 9110 §15.5.6, RFC 6761 §6.3 | `405` carries `Allow`; `localhost` names loopback (vectors 20, 10). |

`AggregationTemporality` values used: `1` = DELTA, `2` = CUMULATIVE (OTLP metrics proto). All data points use `startTimeUnixNano` = window start and `timeUnixNano` = window end, whole seconds, in 2026-10-20 (UTC), well in the past.

## Vector file format

```json
{
  "$schema": "./schema.json",
  "description": "What the case proves",
  "contract": "ADR-0011 <bullet>; OTLP §<section>; spec §N",
  "ambiguities": ["A3"],
  "steps": [
    {
      "request": {
        "method": "POST",
        "path": "/v1/metrics",
        "headers": {
          "host": "127.0.0.1:$PORT",
          "content-type": "application/json",
          "authorization": "Bearer $SECRET"
        },
        "gzip": false,
        "body": { "resourceMetrics": [] },
        "rawBody": null,
        "bodyPadBytes": null
      },
      "expect": {
        "status": 200,
        "headers": { "content-type": { "pattern": "^application/json(\\s*;.*)?$" } },
        "body": {},
        "events": [
          {
            "idLabel": "u1",
            "session": "sess-known",
            "occurred_at": "2026-10-20T12:00:00Z",
            "usage_delta": {
              "input_tokens": 1280,
              "output_tokens": 462,
              "cache_read_tokens": 9000,
              "cache_write_tokens": 512,
              "cost_usd": 0.0421,
              "model": "claude-opus-5-5",
              "estimated": false
            }
          }
        ],
        "droppedUnattributed": null
      }
    }
  ],
  "forbiddenStrings": [],
  "identityGroup": null
}
```

All keys are always present (unused ones are `null`, `[]` or `{}`), so a runner never has to guess a default.

### Top level

| Field | Meaning |
|---|---|
| `ambiguities` | Ids from [Ambiguities](#ambiguities) whose chosen reading the vector relies on. A FAIL on such a vector is reported with the id, so the owner can decide whether the reading or the receiver is wrong. |
| `steps` | Requests sent **in order to one receiver instance** (no restart between steps). Multi-step vectors test state: cumulative baselines and retries. |
| `forbiddenStrings` | Extra strings for the [forbidden-strings check](#forbidden-strings). |
| `identityGroup` | Scope of `idLabel` comparison across vectors (see [Event identity](#event-identity)). |

### `request`

| Field | Meaning |
|---|---|
| `method`, `path` | Sent to `127.0.0.1:$PORT` (the TCP target is always the loopback address, whatever the `host` header says). |
| `headers` | Request headers, lower-case names, sent **exactly**; no header is added except `content-encoding: gzip` when `gzip` is `true` and no `content-encoding` is listed, and `content-length`. `$PORT`, `$SECRET` and `$WRONG_SECRET` are substituted inside values. Use a client that sends `Host` verbatim (for example `node:http` `request` with a `headers.host`), not one that derives it from the URL. |
| `gzip` | `true`: gzip the final body bytes. |
| `body` | JSON value, serialized compactly (`JSON.stringify` without spacing). |
| `rawBody` | Exact UTF-8 body string, used instead of `body` (malformed JSON, empty bodies). |
| `bodyPadBytes` | Append ASCII spaces (`0x20`) to the serialized body until it is at least this many bytes, **before** gzip. Trailing whitespace is insignificant JSON (RFC 8259 §2), so the padded body is the same export, only bigger. |

Body bytes are built in this order: serialize `body` (or take `rawBody`) → pad → gzip.

### `expect`

| Field | Meaning |
|---|---|
| `status` | Exact HTTP status. |
| `headers` | Response header [matchers](#matchers); names compare case-insensitively; unlisted headers are not checked. Every `200` checks `content-type: application/json` (OTLP JSON Protobuf Encoding: the server MUST set it). |
| `body` | `200`: the response body MUST parse as JSON and deep-equal `{}` (ADR-0011 Receiver "answers `200 {}`"; OTLP Full Success: `partial_success` unset). `null`: not checked (all non-200 cases, A2). |
| `events` | The `usage.reported` events whose `event_id` **first appears** after this step (see [Event observation](#event-observation)). Order-insensitive. Always `[]` for non-200 steps. |
| `droppedUnattributed` | Matcher on how much the receiver's count of points dropped for unknown sessions (shown by `javi status`) increased during this step. `null`: not checked. |

Each expected event is `{ idLabel, session, occurred_at, usage_delta }`; see [Event comparison](#event-comparison).

## Runner rules

### Fixed environment

Every vector runs against this setup; a runner that cannot build it reports the vector **BLOCKED**.

| Item | Value |
|---|---|
| `HOME` | A fresh temporary directory per vector (tests never touch the real `~/.claude/settings.json` or `~/.javi`, S3e global constraints). |
| Receiver | A fresh `javi receive` (or the in-process receiver the CLI starts) per vector, listening on `127.0.0.1:$PORT`. `$PORT` is any free port the runner chooses; it MUST be the same port the receiver was told. |
| Secret | `$SECRET` is the bearer secret the receiver was configured with (the value `javi usage on` would write to `OTEL_EXPORTER_OTLP_METRICS_HEADERS`). The runner may fix it or read it from the configuration it set up. `$WRONG_SECRET` is `$SECRET` with its last character replaced by a different character of the same class (digit, lower-case letter, upper-case letter or other). |
| Salt | One fixed installation salt, the **same for every vector in a run** (needed for [identity groups](#event-identity) across fresh receivers). |
| Project | One project initialised with `javi init`, slug `web-app`. |
| Attribution table | Session `sess-known` registered to `web-app` before the first step, through the product path ADR-0011 names (a hook invocation for `session_id` = `sess-known` in the `web-app` project, which records `opaqueRef('cc', 'sess-known', salt) → web-app` in `~/.javi/sessions/`). Session `sess-unknown` is **never** registered. No other session is registered. Usage must be on (a usage configuration in `~/.javi`) before that hook runs: hooks remember sessions only while usage is on (ADR-0011 Changes, S3e review). |
| Clock | Not relevant: all timestamps are fixed and in the past; no vector depends on receipt time. |

Run each vector in isolation. Do not share a receiver between vectors: the cumulative baseline is in memory and would leak.

### Event observation

The runner MUST see every `usage.reported` event the receiver produces, for any project, before it leaves the machine. Two equivalent ways:

1. Point the `web-app` project's ingest endpoint at a capturing stub that answers `202 {"accepted": n, "duplicates": 0, "rejected": []}` and records each (decompressed) batch; or
2. Read the project spool directly, with flushing disabled or captured.

Ignore events of other types (the registration hook produces lifecycle events). After each step, wait until the receiver is quiescent: at least **4 s** (the 3 s flush debounce plus margin, ADR-0011 Delivery), or use a harness hook that awaits pending spool writes and flushes. Then collect the events that appeared since the previous step.

**Collapse rule.** Events with the same canonical `event_id` are one event: the platform deduplicates them (JGR §9), so spooling a retried export twice is conformant (A17). Collapsed copies MUST be identical in every compared field below; otherwise FAIL. A step's `events` lists only event ids not seen in earlier steps of the vector.

### Event comparison

For each produced event (after collapsing), match exactly one expected event, and vice versa:

| Check | Rule |
|---|---|
| Envelope | Valid JGR v0.1 (JD-M01 public validator); `jgr` = `"0.1"`; `type` = `"usage.reported"`; `project_ref` = the `web-app` project's slug or id; `privacy_class` absent or `"L0"`; `attributes` absent or within the L0 allowlist (spec §7). |
| `thread_ref` | Equals `opaqueRef('cc', session, salt)` computed with the JD-M01 public helper and the run's salt (ADR-0011 Mapping: "the same ref the hooks produce"). Equivalently: equals the `thread_ref` of the registration hook event. |
| `event_id` | Matches `^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` (canonical lower-case UUID, version 8, RFC 9562 variant; A14). The exact value is **never** compared, only equality between labels. |
| `occurred_at` | Same instant as the expected RFC 3339 value (A13). |
| `usage_delta` | `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens` equal exactly; an absent counter compares as `0` (A9). `cost_usd` within an absolute tolerance of `1e-9`; absent compares as `0`. `model` equal. `estimated` is `false`. `reasoning_tokens` absent or `0`. No other key. |
| `sequence` | Integer; distinct usage events of one thread carry pairwise distinct values, all greater than the registration hook event's (shared per-thread counter, ADR-0011 Mapping). |

### Event identity

`idLabel` values are compared within a **scope**: the vector, or all vectors sharing an `identityGroup`.

- Same label → the produced events MUST have the **same** `event_id`.
- Different labels → **different** `event_id`.

Group `retry-identity` (vectors 39 and 40) checks that the same export yields the same id on a second send to the same receiver and on a fresh receiver with the same salt (ADR-0011 Idempotent retries: HMAC of the group key).

### Forbidden strings

After the last step, scan every byte the receiver produced for the project: all spool files and all captured ingest batches (decompressed). None of these strings may occur, compared case-sensitively as substrings:

- Global, every vector: `sess-known`, `sess-unknown` (raw session ids become `thread_ref` only after hashing, spec §12), the `$SECRET` value (spec §7: secrets never in plaintext fields).
- The vector's `forbiddenStrings`. Vector 30 lists canary values for every identity attribute named by Claude Code (`user.email`, `user.id`, `user.account_uuid`, `user.account_id`, `organization.id`, `terminal.type`, `ccr.session.id`, `app.version`), for other non-allowlisted point attributes (`query_source`, `effort`, `skill.name`) and for resource attributes (`host.name`, `os.type`, a resource-level `user.email`), plus the attribute key names `user.email`, `organization.id`, `terminal.type`, the substring `account_uuid`, the domain `example.com` and the marker `canary`.

`~/.javi/sessions/` holds hashed refs only (ADR-0011 Project attribution); a runner MAY extend the scan to it for the raw session ids. Configuration files that legitimately hold the secret are out of scope.

### Matchers

A matcher is either a string (exact equality) or an object combining:

| Key | Check |
|---|---|
| `equals` | Value equals the given JSON value. |
| `pattern` | Value matches the ECMAScript regular expression (anchor it yourself). |
| `integerMin`, `integerMax` | Value is an integer (JSON integer or `^[0-9]+$` string) within the inclusive bounds. |
| `present` / `absent` | The header or field exists / does not exist. |

Header values are compared after trimming surrounding whitespace.

### Results

Report one of PASS, FAIL, BLOCKED, NOT RUN or SKIPPED per vector (Orcasus contract). A runner that cannot read the drop counter reports that check NOT RUN separately and never folds it into PASS. BLOCKED (setup failed) is never counted as PASS.

## Vectors

40 vectors, 46 steps.

| # | Vector | Case | Expect |
|---|---|---|---|
| 01 | [`01-all-four-token-types-and-cost.json`](01-all-four-token-types-and-cost.json) | `POST /v1/metrics`, `input` / `output` / `cacheRead` / `cacheCreation` + cost | 200 `{}`; 1 event, all counters + `cost_usd` |
| 02 | [`02-root-path-accepted.json`](02-root-path-accepted.json) | Same export on `POST /` | 200; 1 event |
| 03 | [`03-gzip-body.json`](03-gzip-body.json) | gzip body | 200; 1 event |
| 04 | [`04-content-encoding-identity.json`](04-content-encoding-identity.json) | `Content-Encoding: identity` | 200; 1 event |
| 05 | [`05-padded-body-under-limit.json`](05-padded-body-under-limit.json) | Padded to 900 000 bytes (A1) | 200; 1 event |
| 06 | [`06-auth-missing.json`](06-auth-missing.json) | No `Authorization` | 401; no event |
| 07 | [`07-auth-wrong-secret.json`](07-auth-wrong-secret.json) | `Bearer $WRONG_SECRET` | 401; no event |
| 08 | [`08-auth-wrong-scheme.json`](08-auth-wrong-scheme.json) | `Basic $SECRET` (A8) | 401; no event |
| 09 | [`09-host-foreign.json`](09-host-foreign.json) | `Host: attacker.example:$PORT`, valid bearer | 403; no event |
| 10 | [`10-host-localhost.json`](10-host-localhost.json) | `Host: localhost:$PORT` (A5, AMBIGUOUS) | 200; 1 event |
| 11 | [`11-content-type-protobuf.json`](11-content-type-protobuf.json) | `application/x-protobuf`, empty body | 415; no event |
| 12 | [`12-content-encoding-br.json`](12-content-encoding-br.json) | `Content-Encoding: br` (A7) | 415; no event |
| 13 | [`13-body-over-1mib.json`](13-body-over-1mib.json) | Padded to 1 100 000 bytes (A1) | 413; no event |
| 14 | [`14-gzip-decoded-over-1mib.json`](14-gzip-decoded-over-1mib.json) | Small gzip body inflating to 1 100 000 bytes | 413; no event |
| 15 | [`15-malformed-json.json`](15-malformed-json.json) | `{"resourceMetrics":[` | 400; no event |
| 16 | [`16-non-otlp-wrong-field-type.json`](16-non-otlp-wrong-field-type.json) | `{"resourceMetrics":42}` (A3) | 400; no event |
| 17 | [`17-non-otlp-json-array.json`](17-non-otlp-json-array.json) | Top-level JSON array (A3) | 400; no event |
| 18 | [`18-empty-request-object.json`](18-empty-request-object.json) | `{}` (A3) | 200 `{}`; no event |
| 19 | [`19-foreign-object-unknown-fields.json`](19-foreign-object-unknown-fields.json) | JGR-shaped `{"events":[…]}` (A3, AMBIGUOUS) | 200 `{}`; no event |
| 20 | [`20-wrong-method.json`](20-wrong-method.json) | `GET /v1/metrics` (A4) | 405, `Allow` names `POST`; no event |
| 21 | [`21-unknown-path.json`](21-unknown-path.json) | `POST /v1/traces` (A4, superseded by ADR-0016 §3 on 2026-10-29) | 200 `{}` unparsed; no event |
| 22 | [`22-asint-as-number.json`](22-asint-as-number.json) | `asInt` as JSON numbers | 200; same event as 01 |
| 23 | [`23-asdouble-token-values.json`](23-asdouble-token-values.json) | Tokens as `asDouble`, cost `0.00375` | 200; 1 event |
| 24 | [`24-timestamps-as-numbers.json`](24-timestamps-as-numbers.json) | `startTimeUnixNano` / `timeUnixNano` as numbers | 200; same event as 01 |
| 25 | [`25-unknown-fields-ignored.json`](25-unknown-fields-ignored.json) | Unknown fields at six levels, unused known fields | 200; same event as 01 |
| 26 | [`26-other-metrics-ignored.json`](26-other-metrics-ignored.json) | `session.count`, `lines_of_code.count` (`type` = `added`), `commit.count`, `active_time.total` + one token point | 200; 1 event, `input_tokens` 10 only |
| 27 | [`27-gauge-token-metric-ignored.json`](27-gauge-token-metric-ignored.json) | `claude_code.token.usage` as a Gauge | 200; no event |
| 28 | [`28-unknown-type-ignored.json`](28-unknown-type-ignored.json) | `type` = `reasoning`, `cache_read`, `Input` beside `input` | 200; 1 event, `input_tokens` 70 only |
| 29 | [`29-missing-session-id-ignored.json`](29-missing-session-id-ignored.json) | Points without `session.id` (A12) | 200; no event |
| 30 | [`30-identity-attributes-never-copied.json`](30-identity-attributes-never-copied.json) | Identity + other attributes on points and resource | 200; same event as 01; 20 forbidden strings absent |
| 31 | [`31-grouping-across-scope-metrics.json`](31-grouping-across-scope-metrics.json) | Tokens in one `scopeMetrics`, cost in another | 200; one event |
| 32 | [`32-two-models-two-events.json`](32-two-models-two-events.json) | Two models, same session and window | 200; 2 events, distinct ids |
| 33 | [`33-same-type-points-summed.json`](33-same-type-points-summed.json) | Two `input` points differing in `query_source` (A10, AMBIGUOUS) | 200; 1 event, `input_tokens` 130 |
| 34 | [`34-zero-only-group-skipped.json`](34-zero-only-group-skipped.json) | Every counter and cost `0` | 200; no event |
| 35 | [`35-unregistered-session-dropped.json`](35-unregistered-session-dropped.json) | `sess-unknown` (2 points) beside `sess-known` (A11) | 200; 1 event for `sess-known`; drop counter +1..2 |
| 36 | [`36-delta-consecutive-exports.json`](36-delta-consecutive-exports.json) | Two delta exports, consecutive windows (2 steps) | 1 event per step, distinct ids |
| 37 | [`37-cumulative-pair.json`](37-cumulative-pair.json) | Cumulative 100 → 150 (2 steps, A15) | no event, then `input_tokens` 50 |
| 38 | [`38-cumulative-counter-backwards.json`](38-cumulative-counter-backwards.json) | Cumulative 100 → 160 → 20 → 45 (4 steps, A15, A16) | none, 60, none, 25 |
| 39 | [`39-retry-same-receiver.json`](39-retry-same-receiver.json) | Export 01 sent twice (2 steps, A17); group `retry-identity` | 1 event, then no new id |
| 40 | [`40-retry-fresh-receiver.json`](40-retry-fresh-receiver.json) | Export 01 on a fresh receiver; group `retry-identity` | same id as vector 39 |

### Not covered

| Contract item | Why |
|---|---|
| Listening on `127.0.0.1` only, default port 4319, second instance exits when the port is taken, 30 min idle exit, hook-started receiver, `~/.javi/receiver.json` (ADR-0011 Receiver, Lifecycle) | Process and socket behaviour, not a request/response case; belongs to the U3 process tests. |
| `javi usage on` / `off` settings edits (ADR-0011 Opt-in) | File-level behaviour (U2 tests). |
| Flush debounce, spool locking (ADR-0011 Delivery) | Timing and concurrency; the runner only waits for quiescence. |
| Server-side dedupe of a retried id (`duplicates: 1`) | Platform behaviour (JGR §9, HTTP vectors 10–16); here only id equality is checked. |
| Sessions pruned after 7 days (ADR-0011 Project attribution) | Needs clock manipulation. |
| Baseline loss after a receiver restart ("can under-count once") | Follows from vector 37 step 1 on a fresh receiver; not separately asserted. |
| Order of checks (401 / 403 / 404 / 405 / 413 / 415 / 400) | Not stated (A6); every vector has exactly one fault. |

## Ambiguities

Line numbers refer to `docs/adr/0011-local-otlp-usage-receiver.md` at commit `9fc1d23`.

| ID | Contract text | Question | Vector choice |
|---|---|---|---|
| A1 | L33 "≤ 1 MiB decoded (413)" | Exact boundary (1 048 576 bytes; or 1 000 000 if read as MB)? Does "decoded" also bound the compressed size? | Margins only: 900 000 accepted (05), 1 100 000 rejected plain (13) and gzip-inflated (14). |
| A2 | L33 lists statuses only; OTLP §Failures says the body is a `google.rpc.Status` message | Error body shape (JSON `Status` with `message`? empty?) | Not checked for any non-200. |
| A3 | Brief: "non-OTLP JSON object → 400"; OTLP JSON Encoding: unknown fields MUST be ignored; Full Success: an empty request SHOULD succeed | Which JSON is "not OTLP"? | A value that cannot be decoded as `ExportMetricsServiceRequest` → 400: wrong field type (16), top-level array (17). An object with only unknown fields decodes as an empty request → `200 {}`, no event (18 `{}`, 19 JGR-shaped object). |
| A4 | L33 "accepts `POST /v1/metrics` and `/`" | Status for another method or path is not stated. | HTTP semantics (OTLP §All Other Responses): `405` with `Allow` containing `POST` (RFC 9110 §15.5.6) for `GET` on an accepted path (20); `404` for `/v1/traces` (21). |
| A5 | L33 "a loopback `Host`" | Which names count: `127.0.0.1:<port>` only, also `localhost`, `[::1]`; must the port match? | `127.0.0.1:$PORT` accepted (all positive vectors); `localhost:$PORT` accepted (10, RFC 6761); `attacker.example:$PORT` → 403 (09). `[::1]`, port mismatch and a missing `Host` untested. |
| A6 | L33 order of checks | Which status wins when a request has several faults (for example no bearer and a foreign `Host`)? | Untested; one fault per vector. |
| A7 | L33 "gzip or identity encoding (415 otherwise)" | Casing (`GZIP`), stacked encodings, `gzip` header on a non-gzip body (400 or 415)? `Content-Type` parameters (`; charset=utf-8`) or a missing `Content-Type`? | Only `br` (12) and `application/x-protobuf` (11) tested. |
| A8 | L33 "requires the bearer secret (401)" | Is a non-`Bearer` scheme carrying the right secret a 401? Is the scheme name case-insensitive? Is `WWW-Authenticate` sent? | `Basic $SECRET` → 401 (08); scheme casing and `WWW-Authenticate` not checked. |
| A9 | L37 `usage_delta` = `{ input_tokens, …, cost_usd, model, estimated: false }`; spec §6 "at least one counter MUST be present" | Are zero counters emitted as `0` or omitted? Does "all-zero" include `cost_usd`? | Absent counter compares as `0`; vector 34 makes every token type and cost `0`, so either reading skips it. |
| A10 | L37 grouping key (`session.id`, `model`, start, end) | Several points of the same `type` in one group (Claude Code splits series by `query_source`, `speed`, `effort`, …): sum, last wins, or error? | Summed (33): the allowlist discards the distinguishing attributes, and dropping one would under-count. |
| A11 | L39 "Points of unknown sessions are dropped locally and counted" | Counted per point, per group, or per session? How is the counter read? | Drop counter increase between 1 and 2 for one group of two points (35), read from `javi status` or an equivalent harness accessor. |
| A12 | L35, L39 | A point without `session.id`: ignored silently, or counted as dropped? | No event (29); counter not checked. |
| A13 | L37 "`occurred_at` = the point's end time" | RFC 3339 precision for sub-second nanosecond times; offset `Z` or other? | Compared as instants; all times are whole seconds. Sub-second times untested. |
| A14 | L38 "canonical lowercase UUID (version 8 layout)" | Does "layout" fix the version nibble `8` and the RFC 9562 variant bits `10`? | Yes: pattern in [Event comparison](#event-comparison). |
| A15 | L36 "baseline per series" | Series identity: full attribute set, or the allowlisted (`session.id`, `model`, `type`); does `startTimeUnixNano` take part? | Vectors 37 and 38 use one point per type with a constant start, so every reading agrees. |
| A16 | L36 "A counter going backwards starts a new baseline" | Does the backward point emit its own value (reset semantics) or nothing? | Nothing; the next point is measured from it (38: 100 → 160 → 20 → 45 gives none, 60, none, 25). |
| A17 | L38 "the receiver-side dedupe (JGR §9) drops it" | Does the local receiver also suppress a repeated group, or spool it again with the same id? | Both conformant: the [collapse rule](#event-observation) merges identical ids; vector 39 step 2 expects no **new** id. |
| A18 | L36 | `aggregationTemporality` `0` (unspecified) or absent; `isMonotonic: false` Sums | Untested. |
| A19 | L35 "`asInt` … and `asDouble` are accepted" | Token counts carried as non-integral `asDouble` (rounding?), negative values, `asInt` beyond 2^53 | Only integral `asDouble` token values tested (23). |
| A20 | L35 identity list (`user.email`, `user.id`, `user.account_uuid`, `organization.id`) | The Claude Code docs also name `user.account_id`, `ccr.session.id`, `app.version`, `app.entrypoint`; are they covered? | Yes, by the allowlist ("every other attribute … is never copied"); vector 30 includes them as canaries. |
