# Gemini CLI collector conformance vectors (ADR-0016)

Black-box cases for the Gemini CLI support of the `javi` collector: JD-C01 does the I/O and JD-C02 `@javis-dog/collector-adapters` supplies the pure adapters. There are two groups:

- **Hooks (`H*`).** Gemini hook stdin payloads go into `javi hook --platform gemini-cli`. Each step expects one JGR record or nothing.
- **Usage (`U*`).** OTLP/HTTP JSON bodies go to the local receiver (`/v1/metrics`, `/`, `/v1/logs`, `/v1/traces`). Each step expects `usage.reported` deltas with exact token counts (`estimated: false`), and a `cost_usd` from the price table only for per-token-billed auth (`vertex-ai`, `gemini-api-key`).

- **Oracle independence.** Every expectation comes only from the texts under [Sources](#sources). No code under `collectors/**/src` and no collector unit test was read to write them (QA role, [`TEAM.md`](../../../agent-ops/TEAM.md)). The JD-C02 README export table and the JD-M02 `RecordInput` type were read for vocabulary only. In the S5b review round the QA lane also read the runner (`collectors/claude-code/test/gemini-conformance*.ts`) to see how fields are consumed; no expected value was taken from it. Prices were taken from the pricing page text, not from `GEMINI_PRICES`. Where the texts can be read more than one way, the vector lists an ambiguity id and the chosen reading is in [Ambiguities](#ambiguities). No behaviour is invented silently.
- **Format.** One JSON file per case, named `H<NN>-<kebab-name>.json` or `U<NN>-<kebab-name>.json`, valid against [`schema.json`](schema.json) (JSON Schema draft-07). Every key is always present, so a runner never guesses a default; the exceptions are named in the field tables.
- **Status.** Written 2026-10-29 for S5b task Q1; updated the same day for the S5b review rules R1–R6 and R9 (see [Changes](#changes)). The runner is R1, `collectors/claude-code/test/gemini-conformance.test.ts`; it must be updated for the rules marked "runner" in [Changes](#changes).
- **Sibling suites.** These rules reuse the conventions of [`../otlp/`](../otlp/README.md) (Claude Code receiver) and [`../state/`](../state/README.md): partial comparison, the collapse rule, `idLabel` identity, absent strings and result labels.

## Sources

| Source | Sections used |
|---|---|
| [ADR-0016](../../../adr/0016-gemini-and-codex-collectors.md) (Accepted 2026-10-29, at commit `8c8c864`) | Normative. Context table (L13–L24: hook and OTel share the session id; `gemini_cli.token.usage` is cumulative; `promptTokenCount` includes cached tokens). Decision §2 (L34–L51): event mapping, "Everything else is dropped", AfterTool always `task.completed`, refs, synchronous hooks. Decision §3 (L52–L63): settings, receiver, parser, token mapping, temporality, attribution. Decision §4 (L64–L68): price table, estimated reports, unknown models. **Changes** (at commit `d4f2710`): "S5b, QA findings G5/G15" (new sibling series, receiver paths, price selection); "S5b implementation" (baselines kept per platform in separate maps, Gemini event ids hash `gemini-cli\0` + group key, shared receiver, sink paths drain the body); "S5b review V1" **R1–R9**, which supersede parts of §3 and §4: R1 telemetry env keys at setup and at every `SessionStart`, R2 first export, R3 grouping by end time, R4 series identity, R5 `estimated: false`, R6 cost only for `vertex-ai` / `gemini-api-key`, R9 logs and traces over 1 MiB. |
| [ADR-0011](../../../adr/0011-local-otlp-usage-receiver.md) | Normative for the inherited rules. **Receiver** (`200 {}`, bearer, `/` accepted), **Parsing** (resource fallback for `session.id`), **Temporality** (baseline per series, first point sets the baseline, backwards starts a new one), **Mapping → JGR** (grouping by `session.id`, `model`, start and end; all-zero groups skipped; `occurred_at` = point end time; shared sequence), **Idempotent retries** (UUID v8 from HMAC-SHA-256 of salt and group key), **Project attribution** (unknown sessions dropped and counted; hooks remember sessions only while usage is on, Changes). |
| [ADR-0010](../../../adr/0010-claude-code-collector.md) | Neutral hooks ("prints nothing and exits 0 in every case"). Claude Code mapping (H17, U22 only). |
| [JGR spec v0.1](../../spec/v0.1.md) | §3 envelope (opaque refs ≤ 128 chars, attribute strings ≤ 128 chars, sequence), §4 types, §5 status, §6 usage deltas (non-negative counters, `estimated` default `false`), §7 L0 allowlist, §9 dedupe, §10 clock skew, §12 edge rules (identity and content drops, Gemini row, hashing) and §14 Changelog 2026-10-29 (input − cache, `tool` ignored; as updated in the review round: cost only for `vertex-ai` / `gemini-api-key`, `estimated` stays `false` because the counts are exact). |
| [SPRINT-05b](../../../sprints/SPRINT-05b.md), [TEST_PLAN §S5b](../../../agent-ops/TEST_PLAN.md) | Backlog A1–A3 and B2 (`session.id` point-else-resource; "estimated: true only when priced"; intro-price date windows; `/v1/metrics` → both parsers), Review focus, test-plan rows ("body never parsed (malformed JSON still 200)", "401 without bearer"). |
| Gemini CLI docs from `google-gemini/gemini-cli`: `docs/hooks/reference.md`, `docs/hooks/index.md`, `docs/cli/telemetry.md`. These are the copies handed to the QA lane on 2026-10-29. ADR-0016 cites commit `b8fa817`; the QA lane did not re-verify the commit. | Hooks: base input schema (`session_id`, `transcript_path`, `cwd`, `hook_event_name`, `timestamp`); per-event fields (`source`, `reason`, `prompt`, `prompt_response`, `stop_hook_active`, `tool_name`, `tool_input`, `tool_response` with `llmContent` / `returnDisplay` / `error`, `mcp_context`, `original_request_name`, `notification_type` `"ToolPermission"`, `message`, `details`, `llm_request`, `llm_response`, `trigger`); MCP tool names `mcp_<server_name>_<tool_name>`; exit codes; "Silence is Mandatory". Telemetry: common attributes `session.id`, `installation.id`, `active_approval_mode`, `user.email`; `gemini_cli.token.usage` (`model`, `type` ∈ input / output / thought / cache / tool); other metrics; logs `gemini_cli.user_prompt` (`prompt`), `gemini_cli.tool_call` (`function_args`), `gemini_cli.api_response` (token counts); GenAI `gen_ai.client.token.usage`; environment variables `GEMINI_TELEMETRY_*` (H20). |
| gemini-cli source files, copies handed to the QA lane on 2026-10-29 for the review round: `packages/core/src/telemetry/telemetryAttributes.ts`, `packages/core/src/telemetry/metrics.ts`, `packages/core/src/telemetry/config.ts` | `getCommonAttributes`: `session.id`, `installation.id`, `interactive` (boolean), `user.email` (when cached), `auth_type` (when set), `experiments.ids` (array, only when experiments are loaded) on every metric point; `recordTokenUsageMetrics` adds `model` and `type`; `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_HEADERS` read by telemetry config. `AuthType` values `oauth-personal`, `gemini-api-key`, `vertex-ai`, `cloud-shell`, `compute-default-credentials`, `gateway` as listed in ADR-0016 Changes R6 and the orchestrator's brief; the enum itself is not in these copies and was not re-verified. |
| Google Cloud Vertex AI pricing page, <https://cloud.google.com/vertex-ai/generative-ai/pricing> (page title "Agent Platform Pricing \| Google Cloud"), text fetched 2026-10-29 | Gemini 2.5 and Gemini 3 Standard tables, the introductory-pricing banner, and footnotes. Each cost vector quotes its fragments verbatim; whitespace is normalised and each quoted row occurs exactly once on the page. |

Timestamps: hook payloads use 2026-10-29T09:xx:xxZ. Usage points use whole seconds; a series start (`startTimeUnixNano`) is the Gemini process start. In every vector with `receiverStartedAt: null` (U01–U25, U29–U33) each series starts **before** the receiver, so its first point only sets a baseline (R2, verified for all 22 original usage vectors: their latest series start is 09:30 for U03, every clock is later). U26–U28 set `receiverStartedAt` and place series starts at, before and after it. `aggregationTemporality` `2` = CUMULATIVE (Gemini) and `1` = DELTA (the Claude Code part of U22).

## Vector file format

### Hook vectors (`H*`)

```json
{
  "$schema": "./schema.json",
  "id": "H05",
  "kind": "hook",
  "description": "What the case proves",
  "contract": "ADR-0016 §2 ...; hooks reference §BeforeTool",
  "ambiguities": [],
  "clock": "2026-10-29T10:00:00Z",
  "steps": [
    {
      "platform": "gemini-cli",
      "stdin": { "session_id": "gm-sess-h05", "hook_event_name": "BeforeTool", "tool_name": "run_shell_command", "...": "..." },
      "rawStdin": null,
      "env": null,
      "expect": {
        "record": {
          "type": "task.started",
          "session": "gm-sess-h05",
          "attributes": { "platform": "gemini-cli", "tool_name": "run_shell_command" }
        }
      }
    }
  ],
  "absentStrings": ["SENTINEL_TOOLINPUT_H05_S1", "/home/dev"]
}
```

| Field | Meaning |
|---|---|
| `clock` | Pinned time for the vector (see [Pinned clock](#pinned-clock)). Every payload `timestamp` is earlier. |
| `steps[]` | Hook invocations, run **in order** against one `HOME` (sequence counters and thread refs persist between steps). |
| `steps[].platform` | `gemini-cli`: the Gemini hook entry. `claude-code`: the Claude Code hook entry (H17 only). |
| `steps[].stdin` / `rawStdin` | Exactly one is non-null. `stdin` is serialized compactly (`JSON.stringify`). `rawStdin` holds the exact UTF-8 bytes (malformed input, H14). |
| `steps[].env` | `null`, or extra environment variables (upper-case names, string values) for **this step's** hook process only, added to the [invocation](#hook-steps) environment and overriding it (H19, H20: telemetry keys that Gemini would pass to hooks from a loaded `.env`, ADR-0016 Changes R1). Values that hold `SENTINEL` are covered by the global absent strings. |
| `expect.record` | `null`: the step produces no record. Otherwise it produces exactly one record matching the object (see [Record comparison](#record-comparison)). |
| `expect.record.status` | Optional. When it is listed, the status must match exactly. When it is absent, the status is not checked (G7). |
| `expect.record.attributes` | Controlled-key expectation, or `null` (attributes checked by the invariants only). |
| `absentStrings` | Per-vector [absent strings](#absent-strings): every `SENTINEL_*` token planted in a content field, and `/home/dev` where a path is planted. |

### Usage vectors (`U*`)

```json
{
  "$schema": "./schema.json",
  "id": "U01",
  "kind": "usage",
  "description": "What the case proves",
  "contract": "ADR-0016 §3 ...",
  "ambiguities": [],
  "clock": "2026-10-29T10:00:00Z",
  "receiverStartedAt": null,
  "registerSessions": [{ "platform": "gemini-cli", "session": "gm-sess-u01" }],
  "steps": [
    {
      "request": { "path": "/v1/metrics", "auth": true, "body": { "resourceMetrics": [] }, "rawBody": null, "bodyPadBytes": null },
      "expect": {
        "status": 200,
        "events": [
          {
            "idLabel": "u1",
            "platform": "gemini-cli",
            "session": "gm-sess-u01",
            "occurred_at": "2026-10-29T09:01:00Z",
            "usage_delta": {
              "input_tokens": 1500,
              "output_tokens": 500,
              "cache_read_tokens": 1000,
              "reasoning_tokens": 100,
              "cost_usd": 0.008,
              "model": "gemini-2.5-pro",
              "estimated": false
            },
            "priceSource": { "pageRow": "Gemini 2.5 Pro", "fragment": "...", "computation": "..." }
          }
        ],
        "droppedUnattributed": null
      }
    }
  ],
  "droppedUnattributedTotal": null,
  "absentStrings": [],
  "identityGroup": null
}
```

| Field | Meaning |
|---|---|
| `receiverStartedAt` | The receiver's own start time (ADR-0016 Changes R2), whole seconds, at or before `clock`. `null` means the receiver starts at `clock`. See [Pinned clock](#pinned-clock) for how the runner applies it. |
| `registerSessions` | Sessions registered before step 1 (see [Session registration](#session-registration)). No other session is registered. |
| `steps[].request.path` | `POST` target. |
| `steps[].request.auth` | `true`: send `Authorization: Bearer $SECRET`. `false`: send no `Authorization` header. |
| `steps[].request.body` / `rawBody` | Exactly one is non-null. `body` is serialized compactly. `rawBody` holds the exact UTF-8 bytes. |
| `steps[].request.bodyPadBytes` | `null`: no padding. An integer: append ASCII spaces (`0x20`) to the serialized body until it is at least this many bytes. Trailing whitespace is insignificant JSON (RFC 8259 §2), the same mechanism as the [otlp suite](../otlp/README.md) (U33: bodies over 1 MiB). `content-length` is the padded length. |
| `expect.status` | Exact HTTP status. |
| `expect.events` | The `usage.reported` events whose `event_id` **first appears** after this step, order-insensitive. Always `[]` for non-200 steps. |
| `expect.droppedUnattributed` | Matcher (`integerMin` / `integerMax`, inclusive) on how much the unattributed-drop counter grew during this step. `null` = not checked. |
| `droppedUnattributedTotal` | The same matcher over the whole vector, from after registration to after the last step (U09). |
| `usage_delta.cost_usd` | A number is the expected cost. `null` means the `cost_usd` key MUST be absent. For a `claude-code` event, `0` also matches an absent key (the otlp suite's "absent compares as `0`", U32). |
| `usage_delta.estimated` | `false` for every event: Gemini counts are exact (ADR-0016 Changes R5) and Claude Code counts are exact (ADR-0011). |
| `usage_delta.cache_write_tokens` | Optional key (Claude Code event in U22 only). When it is not listed, the produced value must be absent or `0`. |
| `priceSource` | For every Gemini cost, the page row, the selection rule (including the `auth_type` that makes the group priceable), the prices, the verbatim table header and row fragment, and the arithmetic. Otherwise `null`. Informative: the runner compares `cost_usd`, not `priceSource`. |
| `identityGroup` | Scope of `idLabel` comparison across vectors (`replay-identity`: U01 and U21). |

## Runner rules

### Fixed environment

Every vector runs against this setup. A runner that cannot build it reports the vector **BLOCKED**.

| Item | Value |
|---|---|
| `HOME` | A fresh temporary directory per vector. Tests never touch the real `~/.gemini`, `~/.claude` or `~/.javi`. |
| Salt | One fixed installation salt, the **same for every vector in a run**: [thread identity](#thread-identity) and the `replay-identity` group compare across vectors. |
| Project | One project directory (temporary) with slug `web-app`, initialised with `javi init --project web-app --platform gemini-cli`. Vectors with a `claude-code` step or registration also run `javi init --project web-app` (the default platform) in the same directory. Folder trust is Gemini's concern and does not apply: the runner calls the hook itself. |
| Ingest | The project's ingest endpoint points at a capturing stub. The stub answers `202 {"accepted": n, "duplicates": 0, "rejected": []}` and records every decompressed batch. The runner picks the ingest token. |
| Usage (U only) | Before any registration, run `javi usage on --platform gemini-cli` against a `HOME` with no `~/.gemini/settings.json`. When `registerSessions` names `claude-code`, also run `javi usage on` (the default platform). Read `$PORT` and `$SECRET` from the configuration that this writes (`otlpEndpoint` and `otlpHeaders`, or the javi usage configuration). |
| Receiver | A fresh receiver per vector on `127.0.0.1:$PORT`. Use the one the CLI starts or an in-process instance of the same code. Cumulative baselines are in memory and MUST NOT leak between vectors. |

### Pinned clock

`clock` is the current time for the whole vector. It covers setup, registration hooks, hook steps, the receiver, JD-M02 `record`, and the JGR validation of the invariants. The runner injects it everywhere the collector reads the time, for example a test clock or JD-M02 `now`.

- Hook payload `timestamp`s and usage point times are all at or before `clock`, so a valid record never trips JGR §10 clock skew.
- Usage cost vectors keep `clock` within minutes of the point end time. The price date is then the same whether the implementation reads the point end time or the receipt time (G1).
- If the runner cannot pin the clock, it may run with the real clock only when every timestamp in the vector is at or before the real time. Otherwise the vector is **BLOCKED**, never FAIL. U16 and U17 (dated 2026-12-31 and 2027-01-02) need a pinned clock until those dates pass.
- The same clock applies to registration and receiver. Otherwise the 7-day session pruning of ADR-0011 could forget a registration.
- **Receiver start (R2).** The runner sets the pinned clock to `receiverStartedAt` (or `clock` when it is `null`) immediately before `javi usage on`, keeps it there while it creates the receiver and until the receiver is listening, and sets it back to `clock` before registration and the first step. Nothing else runs in that window (`javi init` runs before it, at `clock`). The receiver's own start time is therefore exactly `receiverStartedAt` (or `clock`) whether the implementation takes it at `usage on`, at creation or at `listen`; registration and every step see `clock`. With the clock frozen, "at or after the receiver start" means `startTimeUnixNano ≥ receiverStartedAt` in nanoseconds; U26 hits the boundary exactly. `receiverStartedAt` is never more than 10 minutes before `clock`, so the receiver window and the pruning rule do not interact. A runner that cannot pin the clock for that window reports U26–U28 **BLOCKED**.

### Hook steps

**Layers.** The **collector layer** is required for a PASS. It runs the JD-C01 product path from stdin parsing to the spool append. The **mapper layer** (JD-C02 `mapGeminiHook(raw, ctx)` with the run's salt) MAY run in addition, as a fast check. At the mapper layer, the following are reported NOT RUN: process checks, spool and state scans, `claude-code` steps, and `rawStdin` steps whose bytes do not parse as JSON (when the mapper takes a parsed value). Steps whose `rawStdin` parses (`null`, an array) are passed parsed.

**Invocation (collector layer).**

- Use the exact argv of a `javi-collector` hook entry that `javi init --platform gemini-cli` wrote into `<project>/.gemini/settings.json` (expected shape: `javi hook --project web-app --platform gemini-cli`). Feed **every** Gemini step to that command, including events that have no entry of their own. Gemini would not send them to it, but the mapper must drop them anyway.
- `claude-code` steps use the argv of the `javi-collector` entry in `<project>/.claude/settings.local.json`.
- The process runs with `cwd` = the project directory, `HOME` = the vector's home, and `GEMINI_PROJECT_DIR`, `GEMINI_CWD` and `CLAUDE_PROJECT_DIR` = the project directory. **`GEMINI_SESSION_ID` is not set**, because the mapping reads stdin `session_id` (ADR-0016 §2). No `GEMINI_TELEMETRY_*` or `OTEL_*` variable from the runner's own environment reaches the process. When `steps[].env` is non-null, its entries are added for that step only (they override a fixed value of the same name; registration steps never carry any).
- Write the stdin bytes, close stdin, and wait for exit. A process that has not exited after 10 s is a FAIL; the latency bound itself is not part of this suite.
- **Process checks**, every step: exit code `0`, and stdout of exactly 0 bytes (ADR-0016 §2, ADR-0010 Neutral hooks, hooks reference "Silence is Mandatory"). stderr is not checked.
- An in-process harness is allowed if it runs the same code path. Its process checks are then NOT RUN.

**Observation.** Records are observed in the spool and in the captured batches together, because a detached flush may move them. After each step, collect the records whose canonical `event_id` was not seen before. Ignore extension types `x.*`, for example `x.javi.collector.installed` from `init`. Wait for quiescence before collecting: the hook process has exited, and any flush it started has finished or is captured. A fixed 4 s wait or a harness hook that awaits pending writes is enough.

- `record: null`: zero records.
- Otherwise: exactly one record.

### Record comparison

| Check | Rule |
|---|---|
| `type` | Equal. |
| `thread_ref` | [Thread identity](#thread-identity) for (`step.platform`, `record.session`). |
| `status` | Listed: equal. Not listed: not checked; the invariants still require a valid JGR status where §3 requires one. |
| `attributes` (object) | **Controlled keys** = the L0 allowlist (spec §7) **minus** the free keys `platform_version`, `collector_version` and `duration_ms`. For each key listed in the expectation: a string must be equal. A `{ prefixOf, maxLength, optional }` matcher means: if present, the value is a non-empty string of at most `maxLength` characters that `prefixOf` starts with; if absent, allowed only when `optional` is `true`. Every controlled key **not** listed MUST be absent (for example no `tool_name` on `attention.requested`, and no `error_code` or `exit_code` on `task.completed`). Free keys MAY be present and are not compared. |
| `attributes` (`null`) | Invariants only (the Claude Code step of H17). |
| `sequence` | Per thread, strictly increasing in step order (JGR-R06). |

### Thread identity

- Within a run, every record and usage event for the same (`platform`, raw session id) pair carries the **same** `thread_ref`. Different pairs carry **different** `thread_ref`s, including the same raw id on two platforms (H17).
- `gemini-cli` refs match `^gm_[A-Za-z0-9_:-]+$`, and `claude-code` refs match `^cc_[A-Za-z0-9_:-]+$`. Both are at most 128 characters (spec §3).
- If the runner can call the collector's ref helper, it SHOULD also check `thread_ref` = `opaqueRef('gm', session, salt)`. That is ADR-0016 §2 and is optional here.
- A raw session id never appears in a ref; the [absent strings](#absent-strings) rule covers this.

### Session registration

For each `registerSessions` entry, in order, run one collector-layer hook step with this payload. `<clock>` is the vector clock with `.000Z` milliseconds.

```json
{ "session_id": "<session>", "transcript_path": "/home/dev/.gemini/tmp/SENTINEL_REG_TRANSCRIPT/chats/session.json", "cwd": "/home/dev/SENTINEL_REG_CWD/web-app", "hook_event_name": "SessionStart", "timestamp": "<clock>", "source": "startup" }
```

For `claude-code`, use the Claude Code shape:

```json
{ "session_id": "<session>", "transcript_path": "/home/dev/.claude/projects/SENTINEL_REG_TRANSCRIPT/s.jsonl", "cwd": "/home/dev/SENTINEL_REG_CWD/web-app", "hook_event_name": "SessionStart", "source": "startup" }
```

Each registration MUST produce one `session.started` record, or the vector is BLOCKED. That record's `thread_ref` and `sequence` are the **registration reference** for event comparison. Usage is on before registration, because hooks remember sessions only while usage is on (ADR-0011 Changes).

### Usage steps

**Request.** Send `POST http://127.0.0.1:$PORT<path>` with exactly these headers, all lower-case:

- `host: 127.0.0.1:$PORT`;
- `content-type: application/json`;
- `authorization: Bearer $SECRET`, only when `auth` is `true`;
- `content-length`.

The body is `JSON.stringify(body)`, or the `rawBody` bytes, then padded with spaces to `bodyPadBytes` when that is non-null. There is no gzip. Write the whole body even when it exceeds 1 MiB (U33); the receiver drains it (R9). Use a client that sends `Host` verbatim, as in the [otlp suite](../otlp/README.md).

**Response.**

- The status must be equal.
- For `200`, the body MUST parse as JSON and deep-equal `{}`, and `content-type` MUST be `application/json`. That holds for `/v1/logs` and `/v1/traces` too (ADR-0016 §3 "answers `200 {}`").
- For other statuses, the body is not checked.

**Observation.** After each step, wait for quiescence: at least 4 s (the 3 s flush debounce plus margin, ADR-0011 Delivery), or a harness hook that awaits pending spool writes and flushes. Then collect the `usage.reported` events that appeared since the previous step, from the spool and the captured batches. Ignore other types.

**Collapse rule.** Events with the same canonical `event_id` are one event, because the platform deduplicates them (JGR §9). Copies MUST be identical in every compared field. A step's `events` list only ids that were not seen in earlier steps of the vector.

### Event comparison

Each produced event, after collapsing, matches exactly one expected event of the step, and each expected event matches exactly one produced event.

| Check | Rule |
|---|---|
| Envelope | Valid JGR v0.1 (JD-M01 public validator, `now` = `clock`). `jgr` = `"0.1"`, `type` = `"usage.reported"`, and `project_ref` = the `web-app` slug or id. |
| `thread_ref` | Equals the `thread_ref` of the registration reference for (`platform`, `session`). |
| `event_id` | Canonical lower-case UUID version 8 with the RFC 9562 variant: `^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` (ADR-0011 Idempotent retries, G14). The value itself is never compared, only label equality (see [Event identity](#event-identity)). |
| `occurred_at` | The same instant as the expected value, which is the point's `timeUnixNano`. |
| Token counters | `input_tokens`, `output_tokens`, `cache_read_tokens` and `reasoning_tokens` are equal, and an absent counter compares as `0`. `cache_write_tokens`: equal when listed; otherwise absent or `0`. |
| `cost_usd` | When the expected value is a number, the key is present and \|produced − expected\| ≤ **1e-9 USD**. When it is `null`, the key MUST be absent; `0` is not the same as absent. Exception: for a `claude-code` event an expected `0` also matches an absent key (otlp suite convention; U32). |
| `model` | Equal. |
| `estimated` | Every expectation is `false`: the produced value is `false` or absent (spec §6 default). `true` is a FAIL on any event (R5). |
| Other keys | `usage_delta` has no keys other than the eight JGR counters and fields (spec §6). |
| `sequence` | An integer. Usage events of one thread carry pairwise distinct values, all greater than the registration reference's `sequence` (shared per-thread counter, ADR-0011 Mapping). |

### Cost

The expected `cost_usd` of a Gemini event is computed from the price row valid at the event's `occurred_at`:

```text
cost_usd = ( input_tokens      × P_input
           + cache_read_tokens × P_cached_input
           + (output_tokens + reasoning_tokens) × P_output ) / 1 000 000
```

Here `input_tokens` is already net of cache. The prices `P` are USD per 1M tokens from the Standard table at the "≤ 200K" tier, Global region where the row has one, text input row (ADR-0016 §4; G2). `tool` tokens are never priced.

- The tolerance is **1e-9 USD absolute**. Every expected value is an exact decimal (for example `0.0009875`), so an implementation that rounds to cents or to 6 decimals FAILs (G20).
- **When a cost exists (R6).** A Gemini event has `cost_usd` if and only if **both** hold: the points of its group carry the point attribute `auth_type` with the exact value `vertex-ai` or `gemini-api-key`, and the model has a price row valid at `occurred_at`. Every point of a group carries the same `auth_type` in every vector (mixed groups are untested, G23). Any other value (`oauth-personal` U23; `cloud-shell`, `compute-default-credentials`, `gateway` U25; the planted unknown value in U10) or a missing `auth_type` (U24) yields tokens only and no `cost_usd` key, even for a priced model. A model missing from the table yields no `cost_usd` key even with a priced `auth_type` (U18).
- **`estimated` (R5).** Every Gemini event carries `estimated: false` (or omits it), priced or not, because the token counts are exact. The former rule "`cost_usd` present ⇔ `estimated: true`" no longer holds for Gemini; the UI labels every cost as estimated instead (ADR-0013).
- `auth_type` is read in memory only. It never appears in an emitted record or in inspectable state: every vector that plants it lists `auth_type` and the planted value in `absentStrings` (`gateway` excepted, because the plain word may occur in unrelated state).

### Event identity

`idLabel` values are compared within a scope: the vector, or all vectors that share an `identityGroup`.

- The same label means the same `event_id`.
- Different labels mean different `event_id`s.

U21 replays the first two exports of U01 on a fresh receiver with the same salt. Its `u1` MUST equal U01's `u1`: the id is derived from (salt, session, model, start, end), so a re-sent export dedupes on the platform. Run both vectors in the same run.

### Absent strings

None of these strings may occur, compared case-sensitively as substrings.

**Global**, for every vector:

- the substring `SENTINEL` (every planted value contains it, including the registration templates);
- the substring `/home/dev`. The runner's temporary directories MUST NOT live under `/home/dev`;
- every raw session id that appears in the vector as a non-empty string: each `session`, every string `session_id` / `session.id` value in payloads, and string values nested inside a non-string `session_id` (H13). Examples: `gm-sess-u09-unknown`, `shared-sess-h17`. The numeric id `12345` in H13 is excluded, because digits can collide with unrelated numbers;
- the `$SECRET` value.

**Per vector**: the `absentStrings` list. It names every planted token explicitly, plus identity key names and other non-allowlisted key names, for example `user.email`, `installation.id`, `active_approval_mode`, `prompt_id` and `example.com`.

**Where to scan:**

1. Every emitted record, as its JSON serialization (any type, including `x.*` and registration records).
2. Every spool file and every captured ingest batch, decompressed.
3. If the runner can inspect it, every file under `$HOME/.javi`: sessions, sequences, receiver and usage state, last-flush and log files. Files that legitimately hold the bearer secret or the ingest token are exempt from the `$SECRET` check only. Raw session ids MUST NOT be found there (ADR-0011: hashed refs only).

`~/.gemini/settings.json` and the project's `.gemini/settings.json` and `.claude/settings.local.json` are outside the scan, because they are tool configuration. At the mapper layer, scan the returned value; items 2 and 3 are NOT RUN.

### Invariants

These are checked after every step, in addition to the expectations. A violation is a FAIL even when every expectation matches.

| # | Invariant |
|---|---|
| I1 | Every emitted record validates as JGR v0.1 with the JD-M01 public validator at `now` = `clock`. |
| I2 | `privacy_class` is absent or `"L0"`. There is no `encrypted`. Attribute keys are within the L0 allowlist (spec §7), and string values are at most 128 characters. |
| I3 | Gemini hook records carry `attributes.platform` = `"gemini-cli"` and a `gm_` ref. No record built from a Gemini payload or a Gemini point carries a `cc_` ref, and the other way round. |
| I4 | No counter is negative or non-integer, and no `cost_usd` is negative or non-finite, in any `usage_delta`. |
| I5 | For Gemini usage events: `estimated` is absent or `false` (never `true`, R5), and `cache_write_tokens` is absent or `0`. Whether `cost_usd` is present is checked per expectation ([Cost](#cost)), not by an invariant. |
| I6 | The [absent strings](#absent-strings) rule holds. |
| I7 | Per thread, record sequences strictly increase in emission order. |
| I8 | Collector layer: every hook step exits `0` with empty stdout. |
| I9 | A hook step produces no `usage.reported`. A receiver step produces only `usage.reported`. A non-200 step produces nothing. |

### Results

Each vector reports exactly one of PASS, FAIL, BLOCKED, NOT RUN or SKIPPED (Orcasus contract).

- **PASS**: every expectation and invariant the layer can check holds, and the collector or receiver layer ran.
- **FAIL**: any expectation or invariant is violated. If the vector lists ambiguity ids, the report names them, so the owner can decide whether the reading or the implementation is wrong.
- **BLOCKED**: the [fixed environment](#fixed-environment) or a registration cannot be built, events cannot be observed, or the clock cannot be pinned when [Pinned clock](#pinned-clock) requires it. BLOCKED is never counted as PASS.
- **NOT RUN**: the vector was not executed. Individual checks that a layer cannot perform (process checks in-process, scans at the mapper layer, an unreadable drop counter) are listed as NOT RUN **separately** next to the vector result and are never folded into PASS.
- **SKIPPED**: only with an owner decision recorded for an ambiguity. A vector is never skipped to turn the run green. Diagnose before any retry: no blind reruns and no softened expectations.

### Suggested mutation checks (R1)

Each mutation of the implementation must turn at least the listed vector to FAIL. This shows that the vectors bite.

| Mutation | Vector |
|---|---|
| Spread the hook payload into the record, or copy `prompt` | H03, H18 |
| Map AfterTool with `error` to `task.failed` or add `error_code` | H06 |
| Copy `details.tool_name` into the attention record | H08 |
| Accept any Notification type | H09 |
| Hash the session id without the platform prefix | H17 |
| Compare cumulative values only, ignoring `startTimeUnixNano` | U03 |
| Skip the input − cache rule, or skip the clamp | U04, U05 |
| Count `tool` as input | U06 |
| Map `thought` into `output_tokens` | U01 |
| Parse `/v1/logs` bodies as metrics | U13 |
| Prefix-match model ids | U15 |
| Use the > 200K tier for large deltas | U19 |
| Ignore price windows | U17 |
| Price unknown models as `0` with `estimated: true` | U18 |
| Set `estimated: true` on priced Gemini events (pre-R5) | every priced vector, e.g. U01, U14 |
| Price every `auth_type`, or every value except `oauth-personal` (pre-R6) | U10, U23, U24, U25 |
| Copy `auth_type` (or the series hash) into the record or state | U10, U23, U25 (absent strings) |
| Never count a first export from 0 (pre-R2) | U26, U27, U28 |
| Compare the series start with `>` instead of `≥` | U26 |
| Count every first export from 0 (ignore the receiver start) | U01, U27 |
| Group Gemini points by (session, model, start, end) (pre-R3) | U29 |
| Key a series by (session, model, type) only, ignoring other attributes (pre-R4) | U30, U31 (and U03, U28 when the start is also ignored) |
| Hash array attributes to one constant (for example `[object Object]`) | U30 |
| Drop the sibling rule (G5) | U20, U31 |
| Share one baseline map across platforms, keyed without the platform | U32 |
| Buffer or parse `/v1/logs` and `/v1/traces` bodies over 1 MiB, or answer `413` there | U33 |
| Let a telemetry env value reach a record, spool or state file; suppress `session.started` when telemetry keys are present | H19, H20 |

## Prices used

All values are USD per 1M tokens. They come from the Standard (on-demand) table, "≤ 200K" columns, text input row. Each fragment is quoted verbatim in the vector's `priceSource`. The table is the Vertex AI list price; it is applied to `gemini-api-key` (AI Studio) groups too, whose real price can differ (ADR-0016 Changes R6, a documented limitation). The Vectors column lists only vectors where the model is priced; U10, U23 and U24 use these models without a cost because of their `auth_type`.

| Model id | Page row | Input | Cached input | Output (incl. reasoning) | Valid | Vectors |
|---|---|---:|---:|---:|---|---|
| `gemini-2.5-pro` | Gemini 2.5 Pro | 1.25 | 0.125 | 10.00 | no window | U01–U09, U11–U13, U19–U22, U25–U28, U30–U33 |
| `gemini-2.5-flash` | Gemini 2.5 Flash | 0.30 | 0.03 | 2.50 | no window | U07, U14, U29 |
| `gemini-2.5-flash-lite` | Gemini 2.5 Flash Lite | 0.10 | 0.01 | 0.40 | no window | U15 |
| `gemini-3.8-flash` | Gemini 3.8 Flash\* through December 31, 2026 (Global) | 0.75 | 0.075 | 3.75 | until 2026-12-31 | U16 |
| `gemini-3.8-flash` | Gemini 3.8 Flash Starting January 1, 2027 (Global) | 1.50 | 0.15 | 7.50 | from 2027-01-01 | U17 |

Quoted fragments:

- Gemini 2.5 table header: "Gemini 2.5 Standard Priority Flex/Batch Show discount options Model Type Token Price <= 200K tokens Price > 200K tokens Price <= 200K cached input tokens Price > 200K cached input tokens".
- "Gemini 2.5 Pro Input (text, image, video, audio) $1.25 $2.50 $0.125 $0.25 Text output (response and reasoning) $10.00 $15.00 N/A N/A".
- "Gemini 2.5 Flash Input (text, image, video) $0.30 $0.30 $0.03 $0.03 Audio Input $1.00 $0.30 $0.10 $0.10 Text output (response and reasoning) $2.50 $2.50 N/A N/A".
- "Gemini 2.5 Flash Lite Input (text, image, video) $0.10 $0.10 $0.01 $0.01 Audio Input $0.30 $0.30 $0.03 $0.03 Text output (response and reasoning) $0.40 $0.40 N/A N/A".
- Gemini 3 table header: "Gemini 3 Standard Model Priority Flex/Batch Show discount options Model Type Region Price (/1M tokens) <= 200K input tokens Price (/1M tokens) > 200K input tokens Price (/1M tokens) <= 200K cached input tokens Price (/1M tokens) > 200K cached input tokens".
- "Gemini 3.8 Flash\* through December 31, 2026 Input (text, image, video, audio) Global $0.75 $0.75 $0.075 $0.075 Non-global $0.825 $0.825 $0.0825 $0.0825 Text output (response and reasoning) Global $3.75 $3.75 N/A N/A Non-global $4.125 $4.125 N/A N/A".
- "Gemini 3.8 Flash Starting January 1, 2027 Input (text, image, video, audio) Global $1.50 $1.50 $0.15 $0.15 Non-global $1.65 $1.65 $0.165 $0.165 Text output (response and reasoning) Global $7.50 $7.50 N/A N/A Non-global $8.25 $8.25 N/A N/A".
- Banner, which corroborates the dates: "Gemini 3.8 Flash, Gemini 3.7 Flash, Gemini 3.6 Flash, and CodeMender using these models are offered with introductory pricing of $0.75 / $3.75 per 1M tokens input / output through December 31, 2026. Starting January 1, 2027, standard pricing of $1.5 / $7.5 per 1M tokens input / output will apply."

The Priority table repeats the rows at higher prices; for example, Gemini 2.5 Pro with Priority is $2.25 input. Each quoted Standard row occurs exactly once on the page, so it cannot be confused with a Priority or Batch row.

## Vectors

53 vectors: 20 hook vectors with 64 steps, and 33 usage vectors with 88 steps. Every priced Gemini row below has `estimated: false` (R5) and an `auth_type` of `vertex-ai` or `gemini-api-key` on its points (R6): `vertex-ai` in U02, U04, U07, U14, U16, U17, U19, U26, U29 and one U25 session; `gemini-api-key` elsewhere.

| # | Vector | Case | Expect |
|---|---|---|---|
| H01 | [`H01-session-start.json`](H01-session-start.json) | SessionStart `startup` | `session.started`, `gm_` ref, `platform` |
| H02 | [`H02-session-end.json`](H02-session-end.json) | SessionStart, then SessionEnd `exit` | `session.started`, `session.ended`, same ref |
| H03 | [`H03-before-agent-prompt-discarded.json`](H03-before-agent-prompt-discarded.json) | BeforeAgent with `prompt` | `heartbeat` `working`; prompt absent |
| H04 | [`H04-after-agent-response-discarded.json`](H04-after-agent-response-discarded.json) | AfterAgent with `prompt`, `prompt_response` | `heartbeat` `idle`; both absent |
| H05 | [`H05-before-tool-builtin.json`](H05-before-tool-builtin.json) | BeforeTool `run_shell_command` | `task.started`, `tool_name` only |
| H06 | [`H06-after-tool-error-still-completed.json`](H06-after-tool-error-still-completed.json) | AfterTool with and without `tool_response.error` | `task.completed` both, no `error_code` |
| H07 | [`H07-mcp-tool-context-discarded.json`](H07-mcp-tool-context-discarded.json) | MCP tool with `mcp_context`, `original_request_name` | `tool_name` = `mcp_github_create_issue`; context absent |
| H08 | [`H08-notification-tool-permission.json`](H08-notification-tool-permission.json) | Notification `ToolPermission` with `message`, `details` | `attention.requested` `waiting`, no `tool_name` |
| H09 | [`H09-notification-other-types-dropped.json`](H09-notification-other-types-dropped.json) | `IdlePrompt`, `permission_prompt`, `toolpermission`, no type | nothing ×4 |
| H10 | [`H10-model-hooks-dropped.json`](H10-model-hooks-dropped.json) | BeforeModel, AfterModel, BeforeToolSelection | nothing ×3 |
| H11 | [`H11-precompress-and-unknown-events-dropped.json`](H11-precompress-and-unknown-events-dropped.json) | PreCompress, `PreToolUse`, `Stop`, `UserPromptSubmit`, unknown, no `hook_event_name` | nothing ×6 |
| H12 | [`H12-missing-session-id-dropped.json`](H12-missing-session-id-dropped.json) | `session_id` absent or `null` | nothing ×3 |
| H13 | [`H13-invalid-session-id-dropped.json`](H13-invalid-session-id-dropped.json) | `session_id` `""`, number, object (G9) | nothing ×3 |
| H14 | [`H14-malformed-stdin-silent.json`](H14-malformed-stdin-silent.json) | Truncated JSON, array, `null`, empty stdin | nothing ×4; exit 0, empty stdout |
| H15 | [`H15-tool-name-over-128-chars.json`](H15-tool-name-over-128-chars.json) | 200-char MCP `tool_name`; a 128-char one (G8) | record kept; prefix ≤ 128 or absent; 128 exact |
| H16 | [`H16-two-interleaved-lifecycles.json`](H16-two-interleaved-lifecycles.json) | Two full sessions interleaved, unmapped events between | 13 records, 2 stable distinct refs, sequences increasing |
| H17 | [`H17-same-session-id-claude-and-gemini.json`](H17-same-session-id-claude-and-gemini.json) | Same raw id via Claude Code and Gemini hooks | `cc_` and `gm_` refs differ |
| H18 | [`H18-lookalike-fields-not-copied.json`](H18-lookalike-fields-not-copied.json) | Top-level `platform`, `model`, `tool_name`, `privacy_class`, `thread_ref`, `attributes`, nested `tool_name` | allowlist only |
| H19 | [`H19-session-start-with-otel-endpoint-env.json`](H19-session-start-with-otel-endpoint-env.json) | SessionStart, BeforeTool, SessionEnd with `OTEL_EXPORTER_OTLP_ENDPOINT` in the hook env (R1) | 3 records as usual; exit 0, empty stdout; value absent |
| H20 | [`H20-session-start-with-gemini-telemetry-env.json`](H20-session-start-with-gemini-telemetry-env.json) | SessionStart `resume` with 7 `GEMINI_TELEMETRY_*` / `OTEL_EXPORTER_OTLP_HEADERS` keys; control session without | `session.started` ×2, distinct refs; endpoint and header tokens absent |
| U01 | [`U01-cumulative-baseline-then-deltas.json`](U01-cumulative-baseline-then-deltas.json) | 3 cumulative exports of all 5 types, then a resend | none, delta, delta, none; cost 0.008 and 0.0009875 |
| U02 | [`U02-counter-backwards-new-baseline.json`](U02-counter-backwards-new-baseline.json) | 1000 → 1600 → 200 → 450, same start | none, 600, none, 250 |
| U03 | [`U03-restart-new-start-time.json`](U03-restart-new-start-time.json) | New `startTimeUnixNano` with a higher value (G6) | none, none, 800 / 100 |
| U04 | [`U04-input-minus-cache.json`](U04-input-minus-cache.json) | input Δ7000, cache Δ4200 | `input_tokens` 2800, `cache_read_tokens` 4200 |
| U05 | [`U05-input-minus-cache-clamped.json`](U05-input-minus-cache-clamped.json) | input Δ50, cache Δ80 | `input_tokens` 0 |
| U06 | [`U06-tool-tokens-ignored.json`](U06-tool-tokens-ignored.json) | Only `tool` grows; then input and output grow | none, then input 300 / output 50 only |
| U07 | [`U07-two-models-one-session.json`](U07-two-models-one-session.json) | `gemini-2.5-pro` + `gemini-2.5-flash` | 2 events, distinct ids, per-model cache |
| U08 | [`U08-two-sessions-one-body.json`](U08-two-sessions-one-body.json) | Two sessions, two `resourceMetrics` | 2 events, own refs |
| U09 | [`U09-unattributed-sessions-dropped.json`](U09-unattributed-sessions-dropped.json) | Unknown session; session registered only via Claude Code | 1 event; drop total 2..8 |
| U10 | [`U10-identity-attributes-never-copied.json`](U10-identity-attributes-never-copied.json) | Identity and other attributes on points and resource, including an unrecognised `auth_type` | event, tokens only (no `cost_usd`, R6); 19 absent strings |
| U11 | [`U11-non-token-metrics-ignored.json`](U11-non-token-metrics-ignored.json) | 8 other metrics, including a Gauge `gemini_cli.token.usage` and `gen_ai.client.token.usage` | input 60 / output 10 only |
| U12 | [`U12-session-id-resource-fallback-and-missing.json`](U12-session-id-resource-fallback-and-missing.json) | `session.id` on resource only; none at all | 1 event (resource); other ignored |
| U13 | [`U13-logs-and-traces-never-parsed.json`](U13-logs-and-traces-never-parsed.json) | `/v1/logs` (prompt, args, token counts), `/v1/traces`, malformed, metrics-shaped, no bearer, logs body on `/` | `200 {}` ×6, 401 ×1, no event; later `/v1/metrics` pair → 150 / 20 |
| U14 | [`U14-cost-gemini-2.5-flash.json`](U14-cost-gemini-2.5-flash.json) | `gemini-2.5-flash` | cost 0.0138 |
| U15 | [`U15-cost-gemini-2.5-flash-lite-not-flash.json`](U15-cost-gemini-2.5-flash-lite-not-flash.json) | `gemini-2.5-flash-lite`, same counters | cost 0.0033 |
| U16 | [`U16-cost-gemini-3.8-flash-introductory.json`](U16-cost-gemini-3.8-flash-introductory.json) | `gemini-3.8-flash` at 2026-12-31T12:00Z | cost 0.039 (intro) |
| U17 | [`U17-cost-gemini-3.8-flash-after-introductory.json`](U17-cost-gemini-3.8-flash-after-introductory.json) | Same counters at 2027-01-02T10:01Z | cost 0.078 |
| U18 | [`U18-cost-unknown-model-tokens-only.json`](U18-cost-unknown-model-tokens-only.json) | `gemini-9.9-hyperflash-exp` with `auth_type` `gemini-api-key` | tokens, no `cost_usd`, `estimated: false` |
| U19 | [`U19-cost-long-context-tier-not-applied.json`](U19-cost-long-context-tier-not-applied.json) | input Δ350 000 | cost 0.4875 (≤ 200K tier) |
| U20 | [`U20-cache-series-appears-later.json`](U20-cache-series-appears-later.json) | `cache` series first seen in export 2 (G5) | 1700 / cache 800, then 300 / cache 200 |
| U21 | [`U21-replay-same-event-id.json`](U21-replay-same-event-id.json) | U01 steps 1–2 on a fresh receiver | same `event_id` as U01 `u1` |
| U22 | [`U22-claude-code-and-gemini-on-one-receiver.json`](U22-claude-code-and-gemini-on-one-receiver.json) | Claude Code delta points + Gemini cumulative in one body | Claude Code event unchanged; then a Gemini event |
| U23 | [`U23-cost-oauth-personal-tokens-only.json`](U23-cost-oauth-personal-tokens-only.json) | `auth_type` `oauth-personal`, priced model (R6) | 1000 / cache 500 / out 150 / thought 30, no `cost_usd` |
| U24 | [`U24-cost-missing-auth-type-tokens-only.json`](U24-cost-missing-auth-type-tokens-only.json) | No `auth_type` on the points, `gemini-2.5-flash` (R6) | 700 / cache 300 / out 100, no `cost_usd` |
| U25 | [`U25-cost-other-auth-types-tokens-only.json`](U25-cost-other-auth-types-tokens-only.json) | 4 sessions: `cloud-shell`, `compute-default-credentials`, `gateway`, `vertex-ai` (R6) | 3 events tokens only; `vertex-ai` cost 0.0009 |
| U26 | [`U26-first-export-series-starts-at-receiver-start.json`](U26-first-export-series-starts-at-receiver-start.json) | Series start = `receiverStartedAt` exactly (R2) | first export counted from 0: 2000 / cache 1000 / 400 / 100, cost 0.007625; then 0.001125; resend none |
| U27 | [`U27-first-export-before-and-after-receiver-start.json`](U27-first-export-before-and-after-receiver-start.json) | Start 1 s before vs after the receiver start (R2) | before: baseline, then 500 / 40; after: from 0 (600 / cache 300 / 90), then 400 / 200 / 60 |
| U28 | [`U28-restart-after-receiver-start-counts-from-zero.json`](U28-restart-after-receiver-start-counts-from-zero.json) | Gemini restart after the receiver started (R2, contrast U03) | none; 800 / cache 400 / 150 (0.00255); 600 / 200 / 60 (0.001375) |
| U29 | [`U29-group-by-end-time-different-starts.json`](U29-group-by-end-time-different-starts.json) | input, cache, thought series with 3 different starts, one end (R3) | 1 event: 2000 / cache 2000 / 300 / 100, cost 0.00166 |
| U30 | [`U30-two-series-differ-in-experiments-ids.json`](U30-two-series-differ-in-experiments-ids.json) | 2 series per type differing only in `experiments.ids` (R4) | summed: 450 / cache 150 / 60, then 300 / 100 / 30 |
| U31 | [`U31-attribute-set-changes-mid-session.json`](U31-attribute-set-changes-mid-session.json) | `experiments.ids` appears in export 2; old series frozen (R4 + G5) | 400 / cache 200 / 60, then 200 / 100 / 20 |
| U32 | [`U32-same-session-and-model-on-both-platforms.json`](U32-same-session-and-model-on-both-platforms.json) | Same raw session id, model, attributes and times on Claude Code and Gemini, both cumulative | none; cc 300 / 30 and gm 800 / 80; gm 200 / 20 |
| U33 | [`U33-logs-and-traces-over-1mib.json`](U33-logs-and-traces-over-1mib.json) | `/v1/logs` 1 100 000 B, `/v1/traces` 2 100 000 B, metrics-shaped logs 1 100 000 B (R9) | `200 {}` ×3, nothing stored; later `/v1/metrics` pair → 150 / 15 |

### Not covered

| Contract item | Why |
|---|---|
| `javi hook` latency bound (ADR-0016 §2 "the test asserts a bound") | The bound is not stated; it belongs to the B2 process tests. This suite only fails a hook that hangs for more than 10 s. |
| `.gemini/settings.json` hook entries, `~/.gemini/settings.json` telemetry block (forced `logPrompts: false`, refusal on conflicts, `off` restores), the trust notice (ADR-0016 §2–§3, B1) | File-level behaviour with no JGR output (TEST_PLAN §S5b process rows). |
| R1 at setup: `usage on --platform gemini-cli` scanning the `.env` lookup chain and the workspace `telemetry` block and refusing; R1 at session start: the workspace `telemetry` block check, the content of the local warning record, `javi status` showing it; user-wide wording | File and CLI-output behaviour with no JGR output; the vector format has no way to plant files or read `javi status`. H19 and H20 cover only what is observable here: the hook still maps, stays silent, and leaks no value. Process tests (TEST_PLAN §S5b). |
| R7 (backup never holds javi's secret), R8 (`uninstall --forget-token` keeps a shared token) | File-level behaviour (process tests). |
| Host check and content-type check on `/v1/logs` and `/v1/traces`; a body over 1 MiB without the bearer | Same code path as `/v1/metrics` ([otlp suite](../otlp/README.md) 09–14); only the bearer check is repeated (U13). A 401 answered before a 1 MiB body is fully written can reset the connection, so it is not asserted. The drain of bodies over 1 MiB is U33. |
| Delta-temporality Gemini points, `isMonotonic: false`, temporality `0` | ADR-0016 says the points are cumulative; other temporalities are unspecified. |
| A reset of one series while other series of the group keep counting | Per-series baselines (ADR-0011, R3 "reset detection stays per series") imply a 0 contribution; the vectors reset all series together. |
| Mixed `auth_type` within one group, an `auth_type` that changes mid-session, `auth_type` on the resource only, case variants (`Vertex-AI`) | Unspecified (G23); every vector keeps one exact value per group. |
| A receiver restart within a vector, and tokens lost during the downtime | One receiver per vector; R2's "under-counted after a restart" follows from U27's "before" session. |
| A cumulative series whose start is after the receiver start but whose first export arrives much later | Same rule as U27's "after" session; the delay itself is not observable. |
| A session registered after its first exported point | The order of attribution and baselining is unspecified; see [Ambiguities](#ambiguities) G13. |
| `/clear` and new session ids, Windows shells, a real Gemini run | UNVERIFIED in ADR-0016 Consequences; runtime (owner). |
| `x.javi.collector.installed`, spool eviction, flush debounce | Covered by the Claude Code collector suites; unchanged by ADR-0016. |

## Changes

- **2026-10-29 (S5b review V1, ADR-0016 Changes R1–R6, R9).** Commit message `test(JD-C02): Gemini vectors for the S5b review rules (R2–R6, R9)`. Items marked **runner** need a change in `collectors/claude-code/test/gemini-conformance.test.ts`.
  - **R5, all usage vectors (runner).** Every Gemini expectation is now `estimated: false`. Schema: a `gemini-cli` event must have `estimated: false`; `cost_usd` number ⇒ `priceSource` object; `cost_usd` `null` ⇒ `priceSource` `null`. [Cost](#cost) and invariant I5 are restated: "`cost_usd` present ⇔ `estimated: true`" no longer holds; I5 now only forbids `estimated: true` (and non-zero `cache_write_tokens`).
  - **R6, existing vectors.** Every Gemini data point (all metrics of a `gemini-cli` resource, including the logs-path bodies of U13) gained the point attribute `auth_type`, inserted after `user.email`: `vertex-ai` in U02, U04, U07, U14, U16, U17, U19; `gemini-api-key` in U01, U03, U05, U06, U08, U09, U11–U13, U15, U18, U20–U22 (U21 equals U01, so replay identity holds). No cost changed except **U10**: its planted `auth_type` `SENTINEL_AUTH_TYPE_U10` is not a priced value, so its event is now tokens only (`cost_usd` `null`, was 0.0013). `auth_type` and the planted value were added to `absentStrings`; `priceSource.selection` names the `auth_type`; descriptions and contracts cite R5 and R6.
  - **R6, new vectors.** U23 (`oauth-personal`), U24 (no `auth_type`), U25 (`cloud-shell`, `compute-default-credentials`, `gateway`, and a priced `vertex-ai` control).
  - **R2, new key `receiverStartedAt` (runner).** Required on usage vectors; `null` in U01–U25 and U29–U33. The runner pins the clock to it from `javi usage on` until the receiver is listening ([Pinned clock](#pinned-clock)). Verified: in all 22 original usage vectors every series starts before `clock` (latest: U03's restart at 09:30 against a 10:00 clock), so they stay "baseline first". New: U26 (start = receiver start), U27 (1 s before vs after), U28 (restart after the receiver started; contrast U03).
  - **R3.** U29: three series of one export with different starts and one end form one group.
  - **R4.** U30 (two series per type differing only in `experiments.ids`), U31 (attribute set changes mid-session; relies on G21), U32 (same raw session id and model on both platforms, both cumulative; kills a shared baseline map, G24).
  - **R9, new key `bodyPadBytes` (runner).** Required on every request; `null` everywhere except U33. Same mechanism as the otlp suite. U33: `/v1/logs` and `/v1/traces` bodies over 1 MiB answer `200 {}` and store nothing.
  - **R1, new key `env` (runner).** Required on every hook step; `null` everywhere except H19 and H20, whose `SessionStart` (and later) steps run with telemetry env keys. The setup refusal and the warning record are out of scope ([Not covered](#not-covered)).
  - **Claude Code `cost_usd: 0` (runner).** For a `claude-code` event, an expected `0` now also matches an absent key (U32 has no Claude Code cost metric).
  - **Counts (runner).** 53 vectors: 20 hook (64 steps) and 33 usage (88 steps); the runner's count test must expect 53 / 20 / 33.
  - **Ambiguities.** G21–G25 added. G5 stays decided; G21 records how it reads next to R2.
  - **Not covered** gained R1 file behaviour, R7, R8, mixed `auth_type`, receiver restarts; the 1 MiB row now points to U33.

## Ambiguities

| ID | Contract text | Question | Vector choice |
|---|---|---|---|
| G1 | ADR-0016 §4 "dated per-model price table"; SPRINT-05b A3 "intro-price date windows"; page "through December 31, 2026" | Which instant selects the price: the point end time, the receipt time, or the series start? Which time zone ends "December 31"? | The point end time (`occurred_at`), but `clock` is kept within minutes of it so a receipt-time reading agrees. Times stay ≥ 12 h from the boundary in every zone: 2026-12-31T12:00Z and 2027-01-02T10:01Z. Intervals that span the boundary are untested. |
| G2 | ADR-0016 §4 names only "the tier for prompts ≤ 200k tokens" | The page has Standard, Priority and Flex/Batch tables, Global and Non-global regions, and text and audio input rows. ADR-0016 names none of them. | Standard, Global, text input row: the orchestrator's brief, and the cheapest default consistent with a CLI. A developer who reads the first Gemini 4 table, or the Non-global column, gets different numbers. |
| G3 | ADR-0016 §4 "per-model price table" | Which model ids map to which page row? The page uses display names ("Gemini 2.5 Flash Lite"); the OTel `model` attribute carries ids. | Exact ids `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`, `gemini-3.8-flash`, with exact matching: U15 fails a prefix match. Suffixed ids (`-preview`, `-001`, `models/…`) and variants ("Gemini 3.8 Flash Cyber") are untested. |
| G4 | Page: "Gemini 3.8 Flash\* through December 31, 2026 … \* Promotional pricing provided through 50% credits back on net spend" | Is the introductory price the billed price, or a credit applied later? | The listed (effective) $0.75 / $0.075 / $3.75. |
| G5 | ADR-0016 §3 "The first point only sets a baseline" + "input → input_tokens minus the cache delta of the same … interval" | The `cache` series can appear later than `input`, when caching starts mid-session. Under the literal reading, its first point has no delta, so input is **not** reduced and that export over-counts input (and cost) by the cached tokens. This contradicts "Under-counting is preferred to double counting". | **Decided 2026-10-29 (orchestrator, ADR-0016 Changes):** a new series whose start equals a baselined start of the same session and model counts from 0, giving 1700 / cache 800 (U20 updated). This follows the ADR's preference for under-counting. After R2 the rule still applies when the start is before the receiver start (G21, U31). |
| G6 | ADR-0016 §3 "a reset starts a new one"; ADR-0011 "A counter going backwards starts a new baseline" | Is a new `startTimeUnixNano` with a higher value a reset? | Yes: the OTel cumulative data model treats a new start time as a reset (U03). A value-only comparison would emit 1000 / 400. |
| G7 | ADR-0016 §2 mapping table | The status is not given for `session.started`, `session.ended` or `task.*`. ADR-0010 used `working` / `completed` for Claude Code sessions. | Not checked. Heartbeat and attention statuses are checked. |
| G8 | Spec §3 "values string (≤ 128 chars)"; ADR-0016 §2 `tool_name` only | Should an over-long tool name be truncated, omitted, or should the event be dropped? | The record MUST still be produced (the signal is not lost). `tool_name` is a prefix of at most 128 characters, or absent. An ellipsis marker fails the prefix rule. |
| G9 | Hooks reference `session_id: string` | Does an empty or non-string `session_id` give a thread? | No record (H13). |
| G10 | Hooks reference `timestamp` "ISO 8601 execution time" | Is a hook record's `occurred_at` the payload `timestamp` or the collector clock? | Not compared. Every payload timestamp is ≤ `clock`, so both readings validate. |
| G11 | ADR-0016 Context "`otlpProtocol: "http"` sends metrics, logs and traces to one endpoint"; §3 Settings `otlpEndpoint: "http://127.0.0.1:<port>"` | Does Gemini post every signal to `/` (the base URL as given), or to `/v1/<signal>`? Is "http" JSON or protobuf? The fetched telemetry doc says only `"grpc"`/`"http"`. | U13 sends a logs body to `/v1/logs` and to `/`. Nothing is stored either way: at `/`, the metrics parser sees `resourceLogs` and finds no metrics. If Gemini sends protobuf, every export would be `415`, and only a real run shows it. |
| G12 | ADR-0016 §2 `attributes.platform` (hooks) | Do usage events carry `attributes.platform`? | Not checked beyond the L0 allowlist. |
| G13 | ADR-0011 "dropped locally and counted" | Is the drop counted per point, per group or per session? Is it counted before or after baselining? | Only a vector-level range (U09: 2..8 for two unattributed sessions over two exports). |
| G14 | ADR-0016 §3 "the ADR-0011 baseline rules apply" (event ids not restated) | Do Gemini usage events use ADR-0011's derived UUID v8 ids? | Yes, per spec §12 SHOULD: UUID v8 pattern; U01 / U21 replay identity. |
| G15 | ADR-0016 §3 Receiver: `/v1/traces` → `200 {}` | [`../otlp/21-unknown-path.json`](../otlp/21-unknown-path.json) expects `404` for `POST /v1/traces` (ADR-0011 era). | This suite follows ADR-0016 (U13: `200 {}`). The otlp vector 21 must be updated or re-pointed to another unknown path; that is an orchestrator task, outside this lane's paths. |
| G16 | SPRINT-05b A2 "session.id (point, else resource)"; ADR-0016 §3 names only the attributes | Is the resource fallback in scope for Gemini? | Yes (U12), from A2 and ADR-0011 Parsing. |
| G17 | Spec §12 table also maps `gen_ai.client.inference.usage.*`; ADR-0016 §3 "only `gemini_cli.token.usage` Sum points" | Gemini also exports the GenAI semconv `gen_ai.client.token.usage`. Should it be read? | Ignored (U11). Reading both would double count. |
| G18 | ADR-0016 §4 "tokens only, no `cost_usd`" | Is `cost_usd: 0` the same as no `cost_usd`? | No: the key MUST be absent (U18). |
| G19 | Hooks reference `notification_type: ("ToolPermission")` | Is the match exact and case-sensitive? | Yes: `toolpermission` and Claude Code's `permission_prompt` are dropped (H09). |
| G20 | ADR-0016 §4 "`cost_usd` is computed per usage report" | Is the cost rounded (cents, micro-USD)? | No rounding coarser than 1e-9 (the tolerance). |
| G21 | ADR-0016 Changes R2: "This makes the G5 sibling rule a special case." | Does the G5 sibling rule still apply when the shared start is **before** the receiver start? R2 alone says such a first point "only sets a baseline". | Yes: a series that first appears next to baselined siblings with the same start cannot have been missed (Gemini exports every series every time), so G5 still counts it from 0. U20 is unchanged (1700 / cache 800) and U31 applies the same rule to a new attribute set (R4). If the owner reads R2 as replacing G5, U20 step 2 becomes 2500 / 200 with no cache and U31 step 2 becomes no event. |
| G22 | ADR-0016 Changes R2 "the receiver process's own start time" | Which instant is the receiver start (process start, `listen`, first request), and how does a test set it? | Any instant from `javi usage on` to the receiver listening, read from the pinned clock; the runner holds the clock at `receiverStartedAt` for that whole window ([Pinned clock](#pinned-clock)). U26 tests equality ("at or after"). An implementation that captures the time at module load or from the wall clock is BLOCKED or FAILs. |
| G23 | ADR-0016 Changes R6 "Cost is estimated only for vertex-ai and gemini-api-key" | Is the auth type decided per point, per series or per group? What if one group mixes values? Is the match case-sensitive? | Per group; every vector uses one exact, lower-case value per group. U25 shows the decision is per group (session), not per export. Mixed groups are untested. |
| G24 | ADR-0016 Changes (S5b implementation) "Baselines are kept per platform (separate maps)"; ADR-0011 Temporality (Claude Code cumulative) | U32 needs Claude Code cumulative points; ADR-0011 says they are possible "only if managed settings force it". Claude Code has no cost metric in U32. | Claude Code cumulative points are baselined like otlp vector 37. With no `claude_code.cost.usage`, the expected Claude Code `cost_usd` is `0`, which also matches an absent key (otlp suite rule). A shared map bites only if both platforms derive the same key for these points; U32 makes the attribute lists, start and end identical so that any key that leaves out the platform and the metric name collides. |
| G25 | ADR-0016 Changes R1 "A hit writes a local warning record" | Is the `SessionStart` record still emitted when telemetry keys are present? Is the warning a JGR record? | The `session.started` record is still emitted (the signal is not lost) and the warning is local, so it is not observed. An `x.*` warning record would be ignored for the count but still checked by I1, I2 and the absent strings. |
