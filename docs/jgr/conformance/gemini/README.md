# Gemini CLI collector conformance vectors (ADR-0016)

Black-box cases for the Gemini CLI support of the `javi` collector: JD-C01 does the I/O and JD-C02 `@javis-dog/collector-adapters` supplies the pure adapters. There are two groups:

- **Hooks (`H*`).** Gemini hook stdin payloads go into `javi hook --platform gemini-cli`. Each step expects one JGR record or nothing.
- **Usage (`U*`).** OTLP/HTTP JSON bodies go to the local receiver (`/v1/metrics`, `/`, `/v1/logs`, `/v1/traces`). Each step expects `usage.reported` deltas with an estimated `cost_usd`.

- **Oracle independence.** Every expectation comes only from the texts under [Sources](#sources). No code under `collectors/**/src` and no collector test was read to write them (QA role, [`TEAM.md`](../../../agent-ops/TEAM.md)). The JD-C02 README export table and the JD-M02 `RecordInput` type were read for vocabulary only. Prices were taken from the pricing page text, not from `GEMINI_PRICES`. Where the texts can be read more than one way, the vector lists an ambiguity id and the chosen reading is in [Ambiguities](#ambiguities). No behaviour is invented silently.
- **Format.** One JSON file per case, named `H<NN>-<kebab-name>.json` or `U<NN>-<kebab-name>.json`, valid against [`schema.json`](schema.json) (JSON Schema draft-07). Every key is always present, so a runner never guesses a default; the exceptions are named in the field tables.
- **Status.** Written 2026-10-29 for S5b task Q1. The runner is R1, `collectors/claude-code/test/gemini-conformance.test.ts` (orchestrator, planned).
- **Sibling suites.** These rules reuse the conventions of [`../otlp/`](../otlp/README.md) (Claude Code receiver) and [`../state/`](../state/README.md): partial comparison, the collapse rule, `idLabel` identity, absent strings and result labels.

## Sources

| Source | Sections used |
|---|---|
| [ADR-0016](../../../adr/0016-gemini-and-codex-collectors.md) (Accepted 2026-10-29, at commit `8c8c864`) | Normative. Context table (L13–L24: hook and OTel share the session id; `gemini_cli.token.usage` is cumulative; `promptTokenCount` includes cached tokens). Decision §2 (L34–L51): event mapping, "Everything else is dropped", AfterTool always `task.completed`, refs, synchronous hooks. Decision §3 (L52–L63): settings, receiver, parser, token mapping, temporality, attribution. Decision §4 (L64–L68): price table, estimated reports, unknown models. |
| [ADR-0011](../../../adr/0011-local-otlp-usage-receiver.md) | Normative for the inherited rules. **Receiver** (`200 {}`, bearer, `/` accepted), **Parsing** (resource fallback for `session.id`), **Temporality** (baseline per series, first point sets the baseline, backwards starts a new one), **Mapping → JGR** (grouping by `session.id`, `model`, start and end; all-zero groups skipped; `occurred_at` = point end time; shared sequence), **Idempotent retries** (UUID v8 from HMAC-SHA-256 of salt and group key), **Project attribution** (unknown sessions dropped and counted; hooks remember sessions only while usage is on, Changes). |
| [ADR-0010](../../../adr/0010-claude-code-collector.md) | Neutral hooks ("prints nothing and exits 0 in every case"). Claude Code mapping (H17, U22 only). |
| [JGR spec v0.1](../../spec/v0.1.md) | §3 envelope (opaque refs ≤ 128 chars, attribute strings ≤ 128 chars, sequence), §4 types, §5 status, §6 usage deltas (non-negative counters, `estimated` default `false`), §7 L0 allowlist, §9 dedupe, §10 clock skew, §12 edge rules (identity and content drops, Gemini row, hashing) and §14 Changelog 2026-10-29 (input − cache, `tool` ignored, estimated cost). |
| [SPRINT-05b](../../../sprints/SPRINT-05b.md), [TEST_PLAN §S5b](../../../agent-ops/TEST_PLAN.md) | Backlog A1–A3 and B2 (`session.id` point-else-resource; "estimated: true only when priced"; intro-price date windows; `/v1/metrics` → both parsers), Review focus, test-plan rows ("body never parsed (malformed JSON still 200)", "401 without bearer"). |
| Gemini CLI docs from `google-gemini/gemini-cli`: `docs/hooks/reference.md`, `docs/hooks/index.md`, `docs/cli/telemetry.md`. These are the copies handed to the QA lane on 2026-10-29. ADR-0016 cites commit `b8fa817`; the QA lane did not re-verify the commit. | Hooks: base input schema (`session_id`, `transcript_path`, `cwd`, `hook_event_name`, `timestamp`); per-event fields (`source`, `reason`, `prompt`, `prompt_response`, `stop_hook_active`, `tool_name`, `tool_input`, `tool_response` with `llmContent` / `returnDisplay` / `error`, `mcp_context`, `original_request_name`, `notification_type` `"ToolPermission"`, `message`, `details`, `llm_request`, `llm_response`, `trigger`); MCP tool names `mcp_<server_name>_<tool_name>`; exit codes; "Silence is Mandatory". Telemetry: common attributes `session.id`, `installation.id`, `active_approval_mode`, `user.email`; `gemini_cli.token.usage` (`model`, `type` ∈ input / output / thought / cache / tool); other metrics; logs `gemini_cli.user_prompt` (`prompt`), `gemini_cli.tool_call` (`function_args`), `gemini_cli.api_response` (token counts); GenAI `gen_ai.client.token.usage`. |
| Google Cloud Vertex AI pricing page, <https://cloud.google.com/vertex-ai/generative-ai/pricing> (page title "Agent Platform Pricing \| Google Cloud"), text fetched 2026-10-29 | Gemini 2.5 and Gemini 3 Standard tables, the introductory-pricing banner, and footnotes. Each cost vector quotes its fragments verbatim; whitespace is normalised and each quoted row occurs exactly once on the page. |

Timestamps: hook payloads use 2026-10-29T09:xx:xxZ. Usage points use whole seconds; a series start (`startTimeUnixNano`) is the Gemini process start. `aggregationTemporality` `2` = CUMULATIVE (Gemini) and `1` = DELTA (the Claude Code part of U22).

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
  "registerSessions": [{ "platform": "gemini-cli", "session": "gm-sess-u01" }],
  "steps": [
    {
      "request": { "path": "/v1/metrics", "auth": true, "body": { "resourceMetrics": [] }, "rawBody": null },
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
              "estimated": true
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
| `registerSessions` | Sessions registered before step 1 (see [Session registration](#session-registration)). No other session is registered. |
| `steps[].request.path` | `POST` target. |
| `steps[].request.auth` | `true`: send `Authorization: Bearer $SECRET`. `false`: send no `Authorization` header. |
| `steps[].request.body` / `rawBody` | Exactly one is non-null. `body` is serialized compactly. `rawBody` holds the exact UTF-8 bytes. |
| `expect.status` | Exact HTTP status. |
| `expect.events` | The `usage.reported` events whose `event_id` **first appears** after this step, order-insensitive. Always `[]` for non-200 steps. |
| `expect.droppedUnattributed` | Matcher (`integerMin` / `integerMax`, inclusive) on how much the unattributed-drop counter grew during this step. `null` = not checked. |
| `droppedUnattributedTotal` | The same matcher over the whole vector, from after registration to after the last step (U09). |
| `usage_delta.cost_usd` | A number is the expected cost. `null` means the `cost_usd` key MUST be absent. |
| `usage_delta.cache_write_tokens` | Optional key (Claude Code event in U22 only). When it is not listed, the produced value must be absent or `0`. |
| `priceSource` | For every estimated Gemini cost, the page row, the selection rule, the prices, the verbatim table header and row fragment, and the arithmetic. Otherwise `null`. Informative: the runner compares `cost_usd`, not `priceSource`. |
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

### Hook steps

**Layers.** The **collector layer** is required for a PASS. It runs the JD-C01 product path from stdin parsing to the spool append. The **mapper layer** (JD-C02 `mapGeminiHook(raw, ctx)` with the run's salt) MAY run in addition, as a fast check. At the mapper layer, the following are reported NOT RUN: process checks, spool and state scans, `claude-code` steps, and `rawStdin` steps whose bytes do not parse as JSON (when the mapper takes a parsed value). Steps whose `rawStdin` parses (`null`, an array) are passed parsed.

**Invocation (collector layer).**

- Use the exact argv of a `javi-collector` hook entry that `javi init --platform gemini-cli` wrote into `<project>/.gemini/settings.json` (expected shape: `javi hook --project web-app --platform gemini-cli`). Feed **every** Gemini step to that command, including events that have no entry of their own. Gemini would not send them to it, but the mapper must drop them anyway.
- `claude-code` steps use the argv of the `javi-collector` entry in `<project>/.claude/settings.local.json`.
- The process runs with `cwd` = the project directory, `HOME` = the vector's home, and `GEMINI_PROJECT_DIR`, `GEMINI_CWD` and `CLAUDE_PROJECT_DIR` = the project directory. **`GEMINI_SESSION_ID` is not set**, because the mapping reads stdin `session_id` (ADR-0016 §2).
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

The body is `JSON.stringify(body)`, or the `rawBody` bytes. There is no gzip and no padding. Use a client that sends `Host` verbatim, as in the [otlp suite](../otlp/README.md).

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
| `cost_usd` | When the expected value is a number, the key is present and \|produced − expected\| ≤ **1e-9 USD**. When it is `null`, the key MUST be absent; `0` is not the same as absent. |
| `model` | Equal. |
| `estimated` | Expected `true`: exactly `true`. Expected `false`: `false` or absent (spec §6 default). |
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
- A Gemini event has `cost_usd` if and only if it has `estimated: true`. A model missing from the table yields no `cost_usd` key and `estimated: false` (U18).

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
| I5 | For Gemini usage events: `cost_usd` is present if and only if `estimated` is `true`. `cache_write_tokens` is absent or `0`. |
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

## Prices used

All values are USD per 1M tokens. They come from the Standard (on-demand) table, "≤ 200K" columns, text input row. Each fragment is quoted verbatim in the vector's `priceSource`.

| Model id | Page row | Input | Cached input | Output (incl. reasoning) | Valid | Vectors |
|---|---|---:|---:|---:|---|---|
| `gemini-2.5-pro` | Gemini 2.5 Pro | 1.25 | 0.125 | 10.00 | no window | U01–U13, U19–U22 |
| `gemini-2.5-flash` | Gemini 2.5 Flash | 0.30 | 0.03 | 2.50 | no window | U07, U14 |
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

40 vectors: 18 hook vectors with 59 steps, and 22 usage vectors with 58 steps.

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
| U01 | [`U01-cumulative-baseline-then-deltas.json`](U01-cumulative-baseline-then-deltas.json) | 3 cumulative exports of all 5 types, then a resend | none, delta, delta, none; cost 0.008 and 0.0009875 |
| U02 | [`U02-counter-backwards-new-baseline.json`](U02-counter-backwards-new-baseline.json) | 1000 → 1600 → 200 → 450, same start | none, 600, none, 250 |
| U03 | [`U03-restart-new-start-time.json`](U03-restart-new-start-time.json) | New `startTimeUnixNano` with a higher value (G6) | none, none, 800 / 100 |
| U04 | [`U04-input-minus-cache.json`](U04-input-minus-cache.json) | input Δ7000, cache Δ4200 | `input_tokens` 2800, `cache_read_tokens` 4200 |
| U05 | [`U05-input-minus-cache-clamped.json`](U05-input-minus-cache-clamped.json) | input Δ50, cache Δ80 | `input_tokens` 0 |
| U06 | [`U06-tool-tokens-ignored.json`](U06-tool-tokens-ignored.json) | Only `tool` grows; then input and output grow | none, then input 300 / output 50 only |
| U07 | [`U07-two-models-one-session.json`](U07-two-models-one-session.json) | `gemini-2.5-pro` + `gemini-2.5-flash` | 2 events, distinct ids, per-model cache |
| U08 | [`U08-two-sessions-one-body.json`](U08-two-sessions-one-body.json) | Two sessions, two `resourceMetrics` | 2 events, own refs |
| U09 | [`U09-unattributed-sessions-dropped.json`](U09-unattributed-sessions-dropped.json) | Unknown session; session registered only via Claude Code | 1 event; drop total 2..8 |
| U10 | [`U10-identity-attributes-never-copied.json`](U10-identity-attributes-never-copied.json) | Identity and other attributes on points and resource | event; 18 absent strings |
| U11 | [`U11-non-token-metrics-ignored.json`](U11-non-token-metrics-ignored.json) | 8 other metrics, including a Gauge `gemini_cli.token.usage` and `gen_ai.client.token.usage` | input 60 / output 10 only |
| U12 | [`U12-session-id-resource-fallback-and-missing.json`](U12-session-id-resource-fallback-and-missing.json) | `session.id` on resource only; none at all | 1 event (resource); other ignored |
| U13 | [`U13-logs-and-traces-never-parsed.json`](U13-logs-and-traces-never-parsed.json) | `/v1/logs` (prompt, args, token counts), `/v1/traces`, malformed, metrics-shaped, no bearer, logs body on `/` | `200 {}` ×6, 401 ×1, no event; later `/v1/metrics` pair → 150 / 20 |
| U14 | [`U14-cost-gemini-2.5-flash.json`](U14-cost-gemini-2.5-flash.json) | `gemini-2.5-flash` | cost 0.0138 |
| U15 | [`U15-cost-gemini-2.5-flash-lite-not-flash.json`](U15-cost-gemini-2.5-flash-lite-not-flash.json) | `gemini-2.5-flash-lite`, same counters | cost 0.0033 |
| U16 | [`U16-cost-gemini-3.8-flash-introductory.json`](U16-cost-gemini-3.8-flash-introductory.json) | `gemini-3.8-flash` at 2026-12-31T12:00Z | cost 0.039 (intro) |
| U17 | [`U17-cost-gemini-3.8-flash-after-introductory.json`](U17-cost-gemini-3.8-flash-after-introductory.json) | Same counters at 2027-01-02T10:01Z | cost 0.078 |
| U18 | [`U18-cost-unknown-model-tokens-only.json`](U18-cost-unknown-model-tokens-only.json) | `gemini-9.9-hyperflash-exp` | tokens, no `cost_usd`, `estimated: false` |
| U19 | [`U19-cost-long-context-tier-not-applied.json`](U19-cost-long-context-tier-not-applied.json) | input Δ350 000 | cost 0.4875 (≤ 200K tier) |
| U20 | [`U20-cache-series-appears-later.json`](U20-cache-series-appears-later.json) | `cache` series first seen in export 2 (G5) | 1700 / cache 800, then 300 / cache 200 |
| U21 | [`U21-replay-same-event-id.json`](U21-replay-same-event-id.json) | U01 steps 1–2 on a fresh receiver | same `event_id` as U01 `u1` |
| U22 | [`U22-claude-code-and-gemini-on-one-receiver.json`](U22-claude-code-and-gemini-on-one-receiver.json) | Claude Code delta points + Gemini cumulative in one body | Claude Code event unchanged; then a Gemini event |

### Not covered

| Contract item | Why |
|---|---|
| `javi hook` latency bound (ADR-0016 §2 "the test asserts a bound") | The bound is not stated; it belongs to the B2 process tests. This suite only fails a hook that hangs for more than 10 s. |
| `.gemini/settings.json` hook entries, `~/.gemini/settings.json` telemetry block (forced `logPrompts: false`, refusal on conflicts, `off` restores), the trust notice (ADR-0016 §2–§3, B1) | File-level behaviour with no JGR output (TEST_PLAN §S5b process rows). |
| 1 MiB limit, Host check and content-type check on `/v1/logs` and `/v1/traces` | Same code path as `/v1/metrics` ([otlp suite](../otlp/README.md) 09–14); only the bearer check is repeated (U13). |
| Delta-temporality Gemini points, `isMonotonic: false`, temporality `0` | ADR-0016 says the points are cumulative; other temporalities are unspecified. |
| A reset of one series while other series of the group keep counting | Per-series baselines (ADR-0011) imply a 0 contribution; the vectors reset all series together. |
| A session registered after its first exported point | The order of attribution and baselining is unspecified; see [Ambiguities](#ambiguities) G13. |
| `/clear` and new session ids, Windows shells, a real Gemini run | UNVERIFIED in ADR-0016 Consequences; runtime (owner). |
| `x.javi.collector.installed`, spool eviction, flush debounce | Covered by the Claude Code collector suites; unchanged by ADR-0016. |

## Ambiguities

| ID | Contract text | Question | Vector choice |
|---|---|---|---|
| G1 | ADR-0016 §4 "dated per-model price table"; SPRINT-05b A3 "intro-price date windows"; page "through December 31, 2026" | Which instant selects the price: the point end time, the receipt time, or the series start? Which time zone ends "December 31"? | The point end time (`occurred_at`), but `clock` is kept within minutes of it so a receipt-time reading agrees. Times stay ≥ 12 h from the boundary in every zone: 2026-12-31T12:00Z and 2027-01-02T10:01Z. Intervals that span the boundary are untested. |
| G2 | ADR-0016 §4 names only "the tier for prompts ≤ 200k tokens" | The page has Standard, Priority and Flex/Batch tables, Global and Non-global regions, and text and audio input rows. ADR-0016 names none of them. | Standard, Global, text input row: the orchestrator's brief, and the cheapest default consistent with a CLI. A developer who reads the first Gemini 4 table, or the Non-global column, gets different numbers. |
| G3 | ADR-0016 §4 "per-model price table" | Which model ids map to which page row? The page uses display names ("Gemini 2.5 Flash Lite"); the OTel `model` attribute carries ids. | Exact ids `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`, `gemini-3.8-flash`, with exact matching: U15 fails a prefix match. Suffixed ids (`-preview`, `-001`, `models/…`) and variants ("Gemini 3.8 Flash Cyber") are untested. |
| G4 | Page: "Gemini 3.8 Flash\* through December 31, 2026 … \* Promotional pricing provided through 50% credits back on net spend" | Is the introductory price the billed price, or a credit applied later? | The listed (effective) $0.75 / $0.075 / $3.75. |
| G5 | ADR-0016 §3 "The first point only sets a baseline" + "input → input_tokens minus the cache delta of the same … interval" | The `cache` series can appear later than `input`, when caching starts mid-session. Under the literal reading, its first point has no delta, so input is **not** reduced and that export over-counts input (and cost) by the cached tokens. This contradicts "Under-counting is preferred to double counting". | **Decided 2026-10-29 (orchestrator, ADR-0016 Changes):** a new series whose start equals a baselined start of the same session and model counts from 0, giving 1700 / cache 800 (U20 updated). This follows the ADR's preference for under-counting. |
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
