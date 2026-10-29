# Codex CLI collector conformance vectors (ADR-0016 S5c)

Black-box cases for the Codex CLI support of the `javi` collector: JD-C01 does the I/O and JD-C02 `@javis-dog/collector-adapters` supplies the pure adapters. There are two groups:

- **Hooks (`H*`).** Codex hook stdin payloads go into the `javi-collector` hook entry that `javi init --platform codex-cli` wrote into `.codex/hooks.json`. Each step expects one JGR record or nothing.
- **Usage (`U*`).** OTLP/HTTP JSON **logs** bodies go to the local receiver, mostly on its Codex path `/v1/logs/codex-cli`. Each step expects `usage.reported` events: a token report per `codex.sse_event` `response.completed` record, and a separate cost-only report per `codex.turn_cost` record, only for `auth_mode` `ApiKey`. Usage vectors may interleave hook steps, for sub-agent links and resumed sessions.

- **Oracle independence.** Every expectation comes only from the texts under [Sources](#sources). No code under `collectors/**/src` and no collector unit test was read to write them (QA role, [`TEAM.md`](../../../agent-ops/TEAM.md)). `collectors/adapters/module.json` was read for vocabulary only (`mapCodexHook`, `parseCodexLogs`). The Gemini runner (`collectors/claude-code/test/gemini-conformance*.ts`) was read only to see how vector fields are consumed; no expected value was taken from it. The research notes of the S5c Researcher lane were treated as untrusted pointers: every payload and log shape was re-read in the official Codex files listed below. Where the texts can be read more than one way, the vector lists an ambiguity id and the chosen reading is in [Ambiguities](#ambiguities). No behaviour is invented silently.
- **Format.** One JSON file per case, named `H<NN>-<kebab-name>.json` or `U<NN>-<kebab-name>.json`, valid against [`schema.json`](schema.json) (JSON Schema draft-07). Every key is always present, so a runner never guesses a default; the one exception is `expect.record.status` (see the field tables).
- **Status.** Written 2026-10-29 for S5c task Q1. The runner is R1, planned as `collectors/claude-code/test/codex-conformance*.ts`.
- **Sibling suites.** These rules reuse the conventions of [`../gemini/`](../gemini/README.md), [`../otlp/`](../otlp/README.md) and [`../state/`](../state/README.md): partial comparison, the collapse rule, `idLabel` identity, absent strings and result labels. [What is new](#differences-from-the-gemini-runner) is listed below.

## Sources

| Source | Sections used |
|---|---|
| [ADR-0016](../../../adr/0016-gemini-and-codex-collectors.md) Changes 2026-10-29 **"S5c design"** (C1–C6) and **"S5c design review D0"**, at commit `6756557`. D0 wins where the two differ. | Normative. **C1** hooks (`.codex/hooks.json`, append only, `javi hook` prints nothing). **C2** mapping table, dropped events, thread ref `opaqueRef('cx', session_id, salt)`, `attributes.platform` = `codex-cli`. **C4** receiver allowlist (the two records and their kept attributes; `tool_token_count` and `reasoning_token_count` never added). **C5** token and cost mapping, event ids, cost only for `ApiKey`, "A missing cost is never zero". **C6** attribution (root `conversation.id` = hook `session_id`; sub-agent `conversation.id` = `agent_id`; SubagentStart links; unknown ids dropped). **D0**: H1/C7 proxy variables, H2 javi's own header in the hook env, **H3** input − cached − cache_write, H4 launcher (`~/.javi/bin/javi-hook`, `--platform codex-cli --project <slug> --source javi-collector`), H5 stdout reaches the model, **H6** `config.toml` block and keys, **M1** own path `/v1/logs/codex-cli`, 5 MiB cap, 413, constant parse-error message, all-or-nothing spooling, deterministic ids, `ensureReceiver`; **M2** wire types and the `usage.estimated_usd` pattern; M4 sub-agents (persisted synchronously, 7-day TTL, tool events carry `agent_ref`, resumed sub-agents dropped); M5 header env; Low (SessionStart `resume` / `compact` → heartbeat). |
| ADR-0016 §2, §3 and Changes "S5b" (R2, R6, R9; shared receiver) | Only for the Gemini and Claude Code parts of the cross-platform vectors (H19, U18, U21, U22): `gm_` refs, cumulative baselines, `auth_type` cost rule, unparsed `/v1/logs` and `/v1/traces` sinks, one receiver and one secret for all platforms. |
| [ADR-0011](../../../adr/0011-local-otlp-usage-receiver.md) | Receiver (`200 {}`, bearer → 401, loopback `Host`, malformed JSON → 400), Changes ("an object without `resourceMetrics` is an empty request", liveness probe), Lifecycle (hooks start the receiver), Idempotent retries (UUID v8 from HMAC-SHA-256), Project attribution (every hook records `thread_ref → project`; unknown sessions dropped and counted; remembered only while usage is on), Mapping → JGR (Claude Code delta points, U21). |
| [ADR-0010](../../../adr/0010-claude-code-collector.md) | Neutral hooks (exit 0, nothing printed); Claude Code mapping (H19, U21 only). |
| [JGR spec v0.1](../../spec/v0.1.md) | §3 envelope (opaque refs ≤ 128 chars, attribute strings ≤ 128 chars, sequence, `agent_ref`), §4 types (`agent.*` status required), §5 status, §6 usage deltas (non-negative counters, `cost_usd`, at least one counter, `estimated` default `false`), §7 L0 allowlist, §9 dedupe, §10 clock skew, §12 edge rules (identity and content drops; Codex row: input − cached − cache_write, cost from `codex.turn_cost` for API-key auth only), §14 Changelog 2026-10-29 (S5c). |
| [SPRINT-05c](../../../sprints/SPRINT-05c.md), [TEST_PLAN §S5c](../../../agent-ops/TEST_PLAN.md) | Backlog A1–A3, B2, Q1; Review focus (no email, tool arguments or prompt reaches the spool; sub-agent usage before its SubagentStart is dropped); test-plan rows (content sentinels, `codex.tool_result` / `codex.user_prompt` bodies, `ApiKey` vs `Chatgpt` / missing, ids stable on retry, unknown `agent_id` dropped). |
| Official Codex hook input schemas, `openai/codex` branch `main`, `codex-rs/hooks/schema/generated/*.command.input.schema.json`, fetched 2026-10-29 from `raw.githubusercontent.com` | Payload shapes for `SessionStart` (`source` ∈ `startup`, `resume`, `clear`, `compact`, `fork`), `SessionEnd` (`reason` const `other`), `UserPromptSubmit` (`prompt`), `PreToolUse` / `PostToolUse` (`tool_name`, `tool_input`, `tool_response`, `tool_use_id`, optional `agent_id`, `agent_type`), `PermissionRequest`, `Stop` (`last_assistant_message`, `stop_hook_active`), `SubagentStart` / `SubagentStop` (`agent_id`, `agent_type`, `agent_transcript_path`), `Interrupt`, `PreCompact` / `PostCompact` (`trigger`), model-request (`PreModelRequest`, `PostModelRequest` with `token_usage`). Every payload has `session_id`, `cwd` and `transcript_path`; most have `model`, `permission_mode` (enum) and `turn_id`. There is no `timestamp`. |
| Official Codex OTel sources, same branch and date: `codex-rs/otel/src/events/shared.rs`, `codex-rs/otel/src/events/session_telemetry.rs`, `codex-rs/otel/src/tool_result.rs`, `codex-rs/otel/src/lib.rs` | `log_event!` common fields on every log record: `event.timestamp` (RFC 3339 with milliseconds), `conversation.id`, `app.version`, `auth_mode` (only when known), `originator`, `user.account_id`, `user.email`, `terminal.type`, `model`, `slug`. `sse_event_completed`: `event.name` `codex.sse_event`, `event.kind` `response.completed`, `input_token_count` / `output_token_count` / `tool_token_count` (Display → string), `cached_token_count` / `cache_write_token_count` / `reasoning_token_count` (integers), `tool_token_count` = `total_tokens`. `see_event_completed_failed`: same name and kind with `error.message` and no counters. `record_turn_cost`: `codex.turn_cost` with `turn.id`, `usage.estimated_usd` (a string), `turn.interrupted` (boolean), `reasoning_effort`. `codex.user_prompt` (`prompt`, `prompt_length`), `codex.tool_result` (`arguments`, `output`, `call_id`, `tool_name`, MCP fields). `TelemetryAuthMode` displays `ApiKey` or `Chatgpt`. |

**Illustrative values.** The resource attributes (`service.name` `codex_cli_rs`, `service.version`, a planted `host.name`), the scope name `codex_otel.log_only`, `app.version` `0.130.0`, `originator`, `terminal.type`, the model ids (`gpt-5.5-codex`, `gpt-5.5-codex-mini`), the MCP tool name form `mcp__<server>__<tool>` and the tool names `shell` / `apply_patch` are illustrative. ADR-0016 D0 lists the scope name and the resource on the wire as UNVERIFIED. An implementation MUST NOT depend on them (X12).

**Payload check.** Every Codex hook payload in this suite, and the registration template, validates against the official input schema of its `hook_event_name` (ajv, draft-07, checked 2026-10-29). The only exceptions are intended: H13 steps 6–10 (events Codex does not have), H14 steps 1, 2, 4, 5 and 6 (missing or non-string `session_id`) and H17 steps 1–2 (look-alike fields and an off-enum `permission_mode`).

**Timestamps.** Every vector's `clock` is 2026-10-29T10:00:00Z. Log records use 2026-10-29T09:xx:xxZ with `.000` milliseconds in `event.timestamp`, and `timeUnixNano` / `observedTimeUnixNano` of the same instant unless a vector says otherwise (U07). Hook payloads carry no time. Gemini and Claude Code points (U21) use whole seconds; their series start (09:00) is before the receiver start, so Gemini's first export only sets a baseline (ADR-0016 Changes R2).

## Vector file format

### Hook vectors (`H*`)

```json
{
  "$schema": "./schema.json",
  "id": "H06",
  "kind": "hook",
  "description": "What the case proves",
  "contract": "ADR-0016 Changes 2026-10-29 (S5c design) C2 Mapping ...",
  "ambiguities": [],
  "clock": "2026-10-29T10:00:00Z",
  "usageOn": [],
  "steps": [
    {
      "platform": "codex-cli",
      "stdin": { "session_id": "cx-sess-h06", "hook_event_name": "PreToolUse", "tool_name": "shell", "...": "..." },
      "rawStdin": null,
      "env": null,
      "expect": {
        "record": {
          "type": "task.started",
          "session": "cx-sess-h06",
          "agent": null,
          "attributes": { "platform": "codex-cli", "tool_name": "shell" }
        }
      }
    }
  ],
  "absentStrings": ["SENTINEL_TOOLINPUT_H06_S1", "/home/dev"]
}
```

| Field | Meaning |
|---|---|
| `clock` | Pinned time for the vector (see [Pinned clock](#pinned-clock)). |
| `usageOn` | Platforms whose `javi usage on` runs before step 1, with the usage part of the [fixed environment](#fixed-environment) (`CODEX_HOME`, receiver). `[]` in every vector except H18 (`["claude-code", "codex-cli"]`). |
| `steps[]` | Hook invocations, run **in order** against one `HOME` (sequence counters, thread refs and agent links persist between steps). |
| `steps[].platform` | `codex-cli`: the Codex hook entry. `claude-code` / `gemini-cli`: those platforms' hook entries (H19 only). |
| `steps[].stdin` / `rawStdin` | Exactly one is non-null. `stdin` is serialized compactly (`JSON.stringify`). `rawStdin` holds the exact UTF-8 bytes (H15). |
| `steps[].env` | `null`, or extra environment variables for **this step's** hook process only, added to the [invocation](#hook-steps) environment and overriding it. Names may be lower case (`http_proxy`). The literal token `$SECRET` inside a value is replaced by the receiver secret; it only occurs when `usageOn` is non-empty (H18). |
| `expect.record` | `null`: the step produces no record. Otherwise it produces exactly one record matching the object (see [Record comparison](#record-comparison)). |
| `expect.record.agent` | The raw `agent_id` whose agent reference the record MUST carry as `agent_ref` (see [Agent identity](#agent-identity)), or `null`: `agent_ref` MUST be absent. |
| `expect.record.status` | Optional. When listed, the status must match exactly. When absent, it is not checked (X1). |
| `expect.record.attributes` | Controlled-key expectation, or `null` (attributes checked by the invariants only: the Claude Code step of H19). |
| `absentStrings` | Per-vector [absent strings](#absent-strings): every `SENTINEL*` token planted in the vector, `/home/dev` where a path is planted, and named key names and values. |

### Usage vectors (`U*`)

```json
{
  "$schema": "./schema.json",
  "id": "U14",
  "kind": "usage",
  "description": "What the case proves",
  "contract": "C6 Attribution ...",
  "ambiguities": ["X21"],
  "clock": "2026-10-29T10:00:00Z",
  "registerSessions": [{ "platform": "codex-cli", "session": "cx-sess-u14" }],
  "steps": [
    {
      "hook": { "platform": "codex-cli", "stdin": { "hook_event_name": "SubagentStart", "...": "..." }, "rawStdin": null, "env": null },
      "expect": { "record": { "type": "agent.started", "session": "cx-sess-u14", "agent": "cx-agent-u14-a", "attributes": { "platform": "codex-cli" } } }
    },
    {
      "request": { "path": "/v1/logs/codex-cli", "auth": true, "body": { "resourceLogs": [] }, "rawBody": null, "bodyPadBytes": null },
      "expect": {
        "status": 200,
        "events": [
          {
            "idLabel": "u1",
            "platform": "codex-cli",
            "session": "cx-sess-u14",
            "agent": "cx-agent-u14-a",
            "occurred_at": "2026-10-29T09:02:00Z",
            "usage_delta": {
              "input_tokens": 600,
              "output_tokens": 120,
              "cache_read_tokens": 300,
              "cache_write_tokens": 0,
              "reasoning_tokens": 0,
              "cost_usd": null,
              "model": "gpt-5.5-codex-mini",
              "estimated": false
            },
            "derivation": "input_tokens = max(0, 900 − 300 − 0) = 600 (D0 H3); ..."
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
| `registerSessions` | Sessions registered before step 1 (see [Session registration](#session-registration)). No other session is registered before step 1; hook steps inside the vector may register more (U14–U16). |
| `steps[]` | Run **in order**. A step has either `request` (a receiver request) or `hook` (a collector-layer hook invocation, same fields and rules as a hook-vector step). |
| `steps[].request.path` | `POST` target: `/v1/logs/codex-cli` (the Codex path), or `/v1/logs`, `/v1/traces`, `/v1/metrics`, `/` (U18, U21). |
| `steps[].request.auth` | `true`: send `Authorization: Bearer $SECRET`. `false`: send no `Authorization` header. |
| `steps[].request.body` / `rawBody` | Exactly one is non-null. `body` is serialized compactly. `rawBody` holds the exact UTF-8 bytes. |
| `steps[].request.bodyPadBytes` | `null`: no padding. An integer: append ASCII spaces (`0x20`) to the serialized body until it is at least this many bytes (RFC 8259 §2, as in the Gemini and otlp suites). `content-length` is the padded length (U19). |
| `steps[].expect.status` | Exact HTTP status. |
| `steps[].expect.events` | The `usage.reported` events whose `event_id` **first appears** after this step, order-insensitive. Always `[]` for non-200 steps. |
| `steps[].expect.droppedUnattributed` | Matcher (`integerMin` / `integerMax`, inclusive) on how much the unattributed-drop counter grew during this step. `null` = not checked. |
| `droppedUnattributedTotal` | The same matcher over the whole vector, from after registration to after the last step. |
| `events[].session` / `agent` | The raw session id of the thread the event counts in (for sub-agent usage: the **parent** session), and the raw `agent_id` whose agent reference it MUST carry, or `null` (no `agent_ref`). |
| `events[].occurred_at` | The expected instant, or `null`: not compared (Codex cost-only reports, X16). |
| `usage_delta` | All five counters are listed; an absent produced counter compares as `0`. `cost_usd` `null`: the key MUST be absent (`0` is not absent), except that for a `claude-code` event an expected `0` also matches an absent key. `model` `null`: the key MUST be absent (cost-only reports). `estimated` is always `false`. |
| `derivation` | Informative: the source attributes and the arithmetic, with rule ids. The runner compares `usage_delta`, not this text. Every token report shows `input_tokens = max(0, input − cached − cache_write)`. |
| `identityGroup` | Scope of `idLabel` comparison across vectors (`replay-identity`: U01 and U12). |

## Runner rules

### Fixed environment

Every vector runs against this setup. A runner that cannot build it reports the vector **BLOCKED**.

| Item | Value |
|---|---|
| `HOME` | A fresh temporary directory per vector, not under `/home/dev`. Tests never touch the real `~/.codex`, `~/.gemini`, `~/.claude` or `~/.javi`. |
| `CODEX_HOME` | `$HOME/.codex`, an existing empty directory, set for **every** `javi` command and hook process of the vector. `javi usage on --platform codex-cli` edits `$CODEX_HOME/config.toml` (D0 H6), so without this the runner would edit the real user file. A runner that cannot point `CODEX_HOME` at the temporary directory reports **BLOCKED** and runs nothing. |
| Process env hygiene | No `OTEL_*`, `CLAUDE_CODE_ENABLE_TELEMETRY`, `GEMINI_TELEMETRY_*`, `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY` (any letter case) or `CODEX_*` other than `CODEX_HOME` from the runner's own environment reaches any `javi` command or hook process. The test sandbox itself may run behind a proxy; those variables MUST be removed (D0 H1 would otherwise refuse `usage on`, M5 would warn, and hooks would see a proxy). Only `steps[].env` adds such variables, for one step. |
| Salt | One fixed installation salt, the **same for every vector in a run**: [thread identity](#thread-identity) and the `replay-identity` group compare across vectors. |
| Project | One project directory (temporary) with slug `web-app`, initialised with `javi init --project web-app --platform codex-cli`. A vector whose steps, `registerSessions` or `usageOn` name `gemini-cli` or `claude-code` also runs `javi init --project web-app --platform gemini-cli` and/or `javi init --project web-app` (default platform) in the same directory. Codex project trust and hook approval are Codex's concern and do not apply: the runner calls the hook itself. |
| Ingest | The project's ingest endpoint points at a capturing stub on `127.0.0.1`. The stub answers `202 {"accepted": n, "duplicates": 0, "rejected": []}` and records every decompressed batch. The runner picks the ingest token. |
| Usage | Usage vectors, and hook vectors with a non-empty `usageOn`. Before any registration, at `clock`, with the hygienic env above, run in this order: `javi usage on --platform codex-cli` (always for usage vectors; it MAY carry `--port <free port>`), then `javi usage on --platform gemini-cli` when `registerSessions` or `usageOn` names `gemini-cli` (against a `HOME` without `~/.gemini/settings.json`), then `javi usage on` when it names `claude-code`. Only the first command may carry `--port`, because one receiver port and secret serve all platforms (ADR-0016 Changes S5b). A non-zero exit is **BLOCKED**. |
| `$PORT`, `$SECRET` | Read from `$CODEX_HOME/config.toml`, parsed as TOML (for example with `smol-toml`, which JD-C01 pins): `otel.exporter.otlp-http.endpoint` gives `$PORT`, and `otel.exporter.otlp-http.headers.Authorization` is `Bearer $SECRET`. If the runner can also read javi's usage configuration, the port and secret MUST be equal. The [setup checks](#setup-checks) apply. |
| Receiver | A fresh receiver per vector on `127.0.0.1:$PORT`: the one the CLI starts, or an in-process instance of the same code. It MUST be the receiver that a hook's `ensureReceiver` finds alive (ADR-0011 Changes: pid alive and an authenticated probe answered with that pid), so hooks do not start a competing one. A `javi receive` that a hook starts anyway must find the port taken and exit; the runner kills any leftover at the end of the vector. No state of the receiver leaks between vectors. |

### Setup checks

After the usage commands and before registration, the runner checks the javi block of `$CODEX_HOME/config.toml` (D0 H6). A violated check is a **FAIL** of the vector (reported as "setup"), not BLOCKED: these are contract requirements that every usage vector relies on.

| # | Check |
|---|---|
| S1 | The file parses as TOML and contains the lines `# >>> javi usage (do not edit)` and `# <<< javi`. |
| S2 | `otel.exporter.otlp-http.endpoint` is exactly `http://127.0.0.1:<port>/v1/logs/codex-cli` with a decimal port, and `otel.exporter.otlp-http.protocol` is `"json"` (D0 H6, M1). |
| S3 | `otel.exporter.otlp-http.headers.Authorization` is the word `Bearer`, one space and a non-empty secret. |
| S4 | `otel.log_user_prompt`, `otel.log_agent_responses`, `otel.log_guardian_assessments` and `otel.log_sse_deltas` are all `false` (D0 H6; spec §12 "Codex `log_user_prompt = false`"). |
| S5 | There is no `otel.metrics_exporter` and no `otel.trace_exporter` key (C3: `metrics_exporter` and statsig untouched). |

Everything else about `config.toml` (refusals, backup, `usage off`) is out of scope ([Not covered](#not-covered)).

### Pinned clock

`clock` is the current time for the whole vector. It covers setup, registration hooks, hook steps, the receiver, JD-M02 `record`, and the JGR validation of the invariants. The runner injects it everywhere the collector reads the time (a test clock, JD-M02 `now`, a clock preload in child processes).

- Every `event.timestamp` and log record time is at or before `clock`, so a valid record never trips JGR §10 clock skew.
- The receiver starts at `clock`. There is no `receiverStartedAt`: Codex records are per response, not cumulative. The Gemini series of U21 start before `clock`, so their first export only sets a baseline.
- The same clock applies to registration and receiver, so the 7-day session and sub-agent TTLs (ADR-0011, D0 M4) never expire inside a vector.
- If the runner cannot pin the clock, it may run with the real clock only when every timestamp in the vector is at or before the real time (true for every vector after 2026-10-29T10:00Z). Otherwise the vector is **BLOCKED**, never FAIL.

### Hook steps

**Layers.** The **collector layer** is required for a PASS. It runs the JD-C01 product path, launcher included, from stdin parsing to the spool append. The **mapper layer** (JD-C02 `mapCodexHook(raw, ctx)` with the run's salt) MAY run in addition, as a fast check. At the mapper layer the following are NOT RUN: process checks, spool and state scans, `usageOn`, non-Codex steps, agent-link persistence, and `rawStdin` steps whose bytes do not parse as JSON (when the mapper takes a parsed value).

**Invocation (collector layer).**

- Read `<project>/.codex/hooks.json`, written by `javi init --platform codex-cli`. javi's handlers are the `type: "command"` handlers whose `command` contains `--source javi-collector` (D0 H4). Expected shape: `<HOME>/.javi/bin/javi-hook --platform codex-cli --project web-app --source javi-collector`, unquoted.
- Run the `command` of javi's `SessionStart` handler with `/bin/sh -c '<command>'`. Feed **every** Codex step to that command, including events that have no handler of their own: Codex would not send them, but the mapper must drop them anyway. If javi's handlers carry different commands, use the handler of the step's `hook_event_name` when one exists. The runner uses `-c`, not Codex's `$SHELL -lc`, so that no profile output of the test machine reaches stdout; startup output is checked by `init` (D0 H5) and is not part of this suite.
- `gemini-cli` steps use the argv of the `javi-collector` entry in `<project>/.gemini/settings.json`; `claude-code` steps use the entry in `<project>/.claude/settings.local.json` (H19).
- The process runs with `cwd` = the project directory, `HOME` = the vector's home, `CODEX_HOME` = `$HOME/.codex`, `SHELL` = `/bin/sh`, a `PATH` that finds `node`, and the [env hygiene](#fixed-environment) rules. `GEMINI_PROJECT_DIR`, `GEMINI_CWD` and `CLAUDE_PROJECT_DIR` are set to the project directory only for steps of those platforms. When `steps[].env` is non-null, its entries are added for that step only, after `$SECRET` substitution; registration steps never carry any.
- Write the stdin bytes, close stdin, and wait for exit. A process that has not exited after 10 s is a FAIL. The latency bound is not part of this suite.
- **Process checks**, every step: exit code `0`, and stdout of exactly **0 bytes** (C1, D0 H5: Codex passes SessionStart, SubagentStart and UserPromptSubmit stdout to the model, and treats non-JSON Stop stdout as an error). stderr is not checked.
- An in-process harness is allowed if it runs the same code path after the launcher (`hook --platform codex-cli --project web-app --source javi-collector`). Its process checks and the launcher are then NOT RUN, listed next to the result.

**Observation.** Records are observed in the spool and in the captured batches together, because a detached flush may move them. After each step, collect the records whose canonical `event_id` was not seen before. Ignore extension types `x.*` (for example `x.javi.collector.installed` from `init`), but still apply I1, I2 and I6 to them. Wait for quiescence before collecting: the hook process has exited and any flush it started has finished or is captured. A fixed 4 s wait or a harness hook that awaits pending writes is enough.

- `record: null`: zero records.
- Otherwise: exactly one record.

### Record comparison

| Check | Rule |
|---|---|
| `type` | Equal. |
| `thread_ref` | [Thread identity](#thread-identity) for (`step.platform`, `record.session`). |
| `agent_ref` | `agent` `null`: absent. `agent` a string: present and equal to the [agent reference](#agent-identity) for (`step.platform`, `record.session`, `agent`). |
| `status` | Listed: equal. Not listed: not checked; the invariants still require a valid JGR status where §3 requires one (`heartbeat`, `agent.*`). |
| `attributes` (object) | **Controlled keys** = the L0 allowlist (spec §7) **minus** the free keys `platform_version`, `collector_version` and `duration_ms`. For each listed key: a string must be equal. A `{ prefixOf, maxLength, optional }` matcher means: if present, a non-empty string of at most `maxLength` characters that `prefixOf` starts with; if absent, allowed only when `optional` is `true`. Every controlled key **not** listed MUST be absent: no `model` from the hook payload, no `tool_name` on non-tool events, no `exit_code` or `error_code` on `task.completed`. Free keys MAY be present and are not compared. |
| `attributes` (`null`) | Invariants only (the Claude Code step of H19). |
| `sequence` | Per thread, strictly increasing in step order (JGR-R06). |

### Thread identity

- Within a run, every record and usage event for the same (`platform`, raw session id) pair carries the **same** `thread_ref`. Different pairs carry **different** refs, including the same raw id on two or three platforms (H19, U21).
- `codex-cli` refs match `^cx_[A-Za-z0-9_:-]+$`, `gemini-cli` refs `^gm_[A-Za-z0-9_:-]+$`, `claude-code` refs `^cc_[A-Za-z0-9_:-]+$`; all at most 128 characters (spec §3).
- A sub-agent's records and usage carry the **parent** session's `thread_ref`: Codex hook `session_id` is the root id (C6), and sub-agent usage counts in the parent thread.
- If the runner can call the collector's ref helper, it SHOULD also check `thread_ref` = `opaqueRef('cx', session, salt)` (C2). Optional.
- The **thread reference** for event comparison is the `thread_ref` and `sequence` of the first record the vector produced for (`platform`, `session`), from registration or from a hook step.

### Agent identity

- The **agent reference** for (`platform`, `session`, `agent`) is the `agent_ref` of the first record in the vector whose expectation names that `agent` (normally its `agent.started`).
- Every later record or usage event that names the same (`platform`, `session`, `agent`) carries the same `agent_ref`. Different `agent` values in one vector give different `agent_ref`s.
- An `agent_ref` matches `^[A-Za-z0-9_:-]{1,128}$` and differs from every `thread_ref`. Its prefix is not checked (X5). A raw `agent_id` never appears in it (global absent strings).

### Session registration

For each `registerSessions` entry, in order, run one collector-layer hook step for that platform with this payload:

```json
{ "session_id": "<session>", "transcript_path": "/home/dev/.codex/sessions/2026/10/29/rollout-SENTINEL_REG_TRANSCRIPT.jsonl", "cwd": "/home/dev/SENTINEL_REG_CWD/web-app", "hook_event_name": "SessionStart", "model": "gpt-5.5-codex", "permission_mode": "default", "source": "startup" }
```

For `gemini-cli` and `claude-code`, use the templates of the [Gemini suite](../gemini/README.md#session-registration) (`<clock>` with `.000Z` milliseconds for Gemini's `timestamp`).

Each registration MUST produce one `session.started` record, or the vector is BLOCKED. That record is the thread reference. Usage is on before registration, because hooks remember sessions only while usage is on (ADR-0011 Changes).

### Usage steps

**Request.** Send `POST http://127.0.0.1:$PORT<path>` with exactly these headers, all lower case:

- `host: 127.0.0.1:$PORT`;
- `content-type: application/json`;
- `authorization: Bearer $SECRET`, only when `auth` is `true`;
- `content-length`.

The body is `JSON.stringify(body)`, or the `rawBody` bytes, then padded with spaces to `bodyPadBytes`. There is no gzip (Codex sends none, D0 M1). Use a client that sends `Host` verbatim. For U19's 413 step the receiver may answer before the whole body is written: a connection reset or `EPIPE` **after** the status line was received is fine; no response at all is a FAIL.

**Response.**

- The status must be equal.
- For `200`, the body MUST parse as JSON and deep-equal `{}`, and `content-type` MUST be `application/json` (ADR-0011; on `/v1/logs` and `/v1/traces` too, ADR-0016 §3).
- For any status, the response body MUST NOT contain any [absent string](#absent-strings) (D0 M1: "Parse errors return a constant message (no body snippets)"). Otherwise it is not compared.

**Hook steps in usage vectors.** A `hook` step runs exactly like a [hook step](#hook-steps) at the collector layer, with the same process checks and record comparison, against the same `HOME` and receiver. It produces no `usage.reported` (I9).

**Observation.** After each step, wait for quiescence: at least 4 s (the 3 s flush debounce plus margin, ADR-0011 Delivery), or a harness hook that awaits pending spool writes and flushes. Then collect the `usage.reported` events that appeared since the previous step, from the spool and the captured batches.

**Collapse rule.** Events with the same canonical `event_id` are one event, because the platform deduplicates them (JGR §9). Copies MUST be identical in every compared field, except `occurred_at` of a Codex cost-only report, which is not compared (X19). A step's `events` list only ids that were not seen in earlier steps of the vector.

### Event comparison

Each produced event, after collapsing, matches exactly one expected event of the step, and each expected event matches exactly one produced event.

| Check | Rule |
|---|---|
| Envelope | Valid JGR v0.1 (JD-M01 public validator, `now` = `clock`). `jgr` = `"0.1"`, `type` = `"usage.reported"`, `project_ref` = the `web-app` slug or id. |
| `thread_ref` | Equals the [thread reference](#thread-identity) for (`platform`, `session`). |
| `agent_ref` | `agent` `null`: absent. A string: equal to the [agent reference](#agent-identity) established by the vector's hook steps. |
| `event_id` | Canonical lower-case UUID version 8 with the RFC 9562 variant: `^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` (X11). The value is never compared, only label equality ([Event identity](#event-identity)). |
| `occurred_at` | A string: the same instant (millisecond precision is enough). `null`: not compared; I1 still requires it to be valid and not after `clock`. |
| Token counters | `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens` and `reasoning_tokens` are equal; an absent counter compares as `0`. |
| `cost_usd` | A number: present and \|produced − expected\| ≤ **1e-9 USD**. `null`: the key MUST be absent. For a `claude-code` event an expected `0` also matches an absent key. |
| `model` | A string: equal. `null`: the key MUST be absent. |
| `estimated` | The produced value is `false` or absent. `true` is a FAIL on any event. |
| Other keys | `usage_delta` has no keys other than the eight JGR counters and fields (spec §6). |
| `sequence` | An integer. Usage events of one thread carry pairwise distinct values, all greater than the thread reference's `sequence` (shared per-thread counter, ADR-0011 Mapping). |

### Codex usage mapping

This restates the rules the expectations were computed from. It is not an extra check.

- **Token report** (C4 record 1, C5, D0 H3). From one `codex.sse_event` record with `event.kind` `response.completed`, the four kept counters present and valid (non-negative safe integers as `stringValue` or `intValue`, D0 M2) and no `error.message`:
  - `input_tokens` = max(0, `input_token_count` − `cached_token_count` − `cache_write_token_count`);
  - `cache_read_tokens` = `cached_token_count`; `cache_write_tokens` = `cache_write_token_count`; `output_tokens` = `output_token_count`;
  - `reasoning_token_count` and `tool_token_count` are never added, so `reasoning_tokens` is absent or `0`;
  - `model` = the record's `model` attribute; `occurred_at` = `event.timestamp` (X10); no `cost_usd`, whatever the `auth_mode`;
  - the thread is the `conversation.id`'s registered session, or, for a linked sub-agent, its parent with the agent's `agent_ref`.
- **Cost-only report** (C4 record 2, C5, D0 M2). From one `codex.turn_cost` record with `auth_mode` exactly `ApiKey` and a `usage.estimated_usd` string matching `^\d+(\.\d+)?$`: `cost_usd` = that decimal; no token counters, no `model` (X16). `Chatgpt`, another value or a missing `auth_mode` gives nothing, never `0`.
- **Event ids** (C5, D0 M1). A token report's id derives from (salt, `codex-cli`, conversation, timestamp, counters); a cost report's id from (salt, `codex-cli`, conversation, `turn.id`). The same input gives the same id, in one body, on a resend, and on a fresh receiver with the same salt.
- **Everything else** is dropped in memory: other event names and kinds, every other attribute (identity, content, resource, scope), and records of unknown conversations, which are counted as unattributed (C6, ADR-0011).

### Event identity

`idLabel` values are compared within a scope: the vector, or all vectors that share an `identityGroup`.

- The same label means the same `event_id`.
- Different labels mean different `event_id`s.

U12 replays U01's first body on a fresh receiver with the same salt. Its `u1` MUST equal U01's `u1`. Run both vectors in the same run.

### Absent strings

None of these strings may occur, compared case-sensitively as substrings.

**Global**, for every vector:

- the substring `SENTINEL` (every planted value contains it, including the registration templates);
- the substring `/home/dev`; the runner's temporary directories MUST NOT live under `/home/dev`;
- every raw session id in the vector that is a non-empty string: each `session`, every string `session_id` value in hook payloads, string values nested inside a non-string `session_id` (H14), every `conversation.id` string value in request bodies, and every `registerSessions` entry. The numeric id `12345` in H14 is excluded, because digits can collide with unrelated numbers;
- every raw agent id: each `agent` value and every `agent_id` string in hook payloads and `conversation.id` values that are agent ids;
- the `$SECRET` value.

**Per vector**: the `absentStrings` list. It names every planted token explicitly, plus key names and values that must never be copied, for example `user.email`, `user.account_id`, `auth_mode`, `ApiKey`, `Chatgpt`, `usage.estimated_usd`, `host.name` and `example.com`.

**Where to scan:**

1. Every emitted record, as its JSON serialization (any type, including `x.*` and registration records).
2. Every spool file and every captured ingest batch, decompressed.
3. Every response body of a usage step (any status).
4. If the runner can inspect it, every file under `$HOME/.javi`: sessions, sub-agent links, sequences, receiver and usage state, warning files, last-flush and log files, and the launcher. Raw session and agent ids MUST NOT be found there (ADR-0011 and C6: hashed refs only). Only files that javi uses to store the bearer secret or the ingest token (its usage configuration and token file; the runner names them in its report) are exempt, and only from the `$SECRET` check. Files under `~/.javi/warnings/` are **never** exempt: a warning holds names only (D0 H1, H2).

`$CODEX_HOME/config.toml`, `<project>/.codex/hooks.json` and the Claude Code and Gemini settings files are outside the scan, because they are tool configuration (`config.toml` legitimately holds the secret). At the mapper layer, scan the returned value; items 2–4 are NOT RUN.

### Invariants

These are checked after every step, in addition to the expectations. A violation is a FAIL even when every expectation matches.

| # | Invariant |
|---|---|
| I1 | Every emitted record validates as JGR v0.1 with the JD-M01 public validator at `now` = `clock`. |
| I2 | `privacy_class` is absent or `"L0"`. There is no `encrypted`. Attribute keys are within the L0 allowlist (spec §7), and string values are at most 128 characters. |
| I3 | Codex hook records carry `attributes.platform` = `"codex-cli"` and a `cx_` ref. No record built from a Codex payload or log record carries a `cc_` or `gm_` ref, and the other way round. |
| I4 | No counter is negative or non-integer, and no `cost_usd` is negative or non-finite, in any `usage_delta`. |
| I5 | For Codex usage events: `estimated` is absent or `false`; `reasoning_tokens` is absent or `0`; an event never carries both a token counter above `0` and `cost_usd` (token and cost reports are separate, C5). |
| I6 | The [absent strings](#absent-strings) rule holds. |
| I7 | Per thread, record sequences strictly increase in emission order. |
| I8 | Collector layer: every hook step, registration included, exits `0` with empty stdout. |
| I9 | A hook step produces no `usage.reported`. A receiver step produces only `usage.reported`. A non-200 step produces nothing. |
| I10 | Every `agent_ref` matches the opaque pattern and differs from every `thread_ref`. A record without `agent_id` in its payload has no `agent_ref`. |

### Results

Each vector reports exactly one of PASS, FAIL, BLOCKED, NOT RUN or SKIPPED (Orcasus contract).

- **PASS**: every expectation, setup check and invariant the layer can check holds, and the collector or receiver layer ran.
- **FAIL**: any expectation, setup check or invariant is violated. If the vector lists ambiguity ids, the report names them, so the owner can decide whether the reading or the implementation is wrong.
- **BLOCKED**: the [fixed environment](#fixed-environment) cannot be built (no temporary `CODEX_HOME`, a `usage on` or `init` exits non-zero), a registration does not produce its `session.started`, events cannot be observed, or the clock cannot be pinned when [Pinned clock](#pinned-clock) requires it. BLOCKED is never counted as PASS.
- **NOT RUN**: the vector was not executed. Individual checks that a layer cannot perform (process checks in-process, the launcher, scans at the mapper layer, an unreadable drop counter) are listed as NOT RUN **separately** next to the vector result and are never folded into PASS.
- **SKIPPED**: only with an owner decision recorded for an ambiguity. A vector is never skipped to turn the run green. Diagnose before any retry: no blind reruns and no softened expectations.

### Suggested mutation checks (R1)

Each mutation of the implementation must turn at least the listed vector to FAIL. This shows that the vectors bite.

| Mutation | Vector |
|---|---|
| Spread the hook payload into the record, or copy `prompt`, `tool_input`, `tool_response` or `last_assistant_message` | H05, H06, H07, H10, H17 |
| Copy the hook `model` or `permission_mode` into attributes | H01, H17 |
| Map PostToolUse with a failure-looking `tool_response` to `task.failed`, or add `exit_code` | H07 |
| Map SessionStart `resume` / `compact` to `session.started` | H03 |
| Map Interrupt, a compact event or PostModelRequest (with `token_usage`) to anything | H13 |
| Hash `agent_id` with the session (or not at all), or give root events an `agent_ref` | H11, H12, H17 |
| Use one prefix for all platforms, or hash the session id without the platform | H19, U21 |
| Print anything on stdout (for example a JSON `{}` on Stop) | every H vector (I8) |
| Keep C5's input − cached (skip D0 H3), or skip the clamp | U01, U02 |
| Add `reasoning_token_count` to output, report it as `reasoning_tokens`, or use `tool_token_count` | U01, U06 |
| Accept only `stringValue` (or only `intValue`) counters; reject JSON-number `intValue` | U03 |
| Treat an invalid counter as `0` instead of dropping the record | U04 |
| Accept the failure variant, or match on counter names without `event.name` / `event.kind` | U05, U17, U18 |
| Hash the token id without `event.timestamp`, or with the receiver time | U07, U12 |
| Put `cost_usd` on the token report, or emit cost for `Chatgpt` / missing / case variants of `ApiKey` | U08, U09 |
| Parse `usage.estimated_usd` with `parseFloat` (accepting `1e-3`, `5.`, `0.25USD`) or accept numbers | U10 |
| Hash the cost id with the timestamp | U11 |
| Attribute an unknown conversation to the latest session, or route a sub-agent to the root without a link | U13, U15, U22 |
| Forget the sub-agent link at SubagentStop | U14 |
| Register sessions only on `session.started` | U16 |
| Parse Codex records on `/v1/logs`, `/v1/traces`, `/` or `/v1/metrics` | U18 |
| Keep the 1 MiB metrics cap on the Codex path, use 5 MB instead of 5 MiB, or store a partial body on 413 | U19 |
| Echo body snippets in the 400 message, or answer 400 to an empty request | U20 |
| Key sessions by raw id without the platform | U21, U22 |
| Copy a proxy URL, a header value or `$SECRET` into a record, spool or warning file; suppress the record when proxy or header variables are present | H18 |

## Vectors

41 vectors: 19 hook vectors with 68 steps, and 22 usage vectors with 52 steps (48 receiver requests and 4 hook steps) and 38 expected usage events.

| # | Vector | Case | Expect |
|---|---|---|---|
| H01 | [`H01-session-start-startup.json`](H01-session-start-startup.json) | SessionStart `startup`, UUID-shaped id | `session.started`, `cx_` ref, `platform` only |
| H02 | [`H02-session-end.json`](H02-session-end.json) | SessionStart, SessionEnd `other` | `session.started`, `session.ended`, same ref |
| H03 | [`H03-session-start-resume-compact-heartbeat.json`](H03-session-start-resume-compact-heartbeat.json) | `startup`, `compact`; `resume` ×2 on another id | `session.started`, then `heartbeat` ×3 |
| H04 | [`H04-session-start-clear-fork-new-session.json`](H04-session-start-clear-fork-new-session.json) | `startup`, `clear`, `fork` (X2) | `session.started` ×3, three refs |
| H05 | [`H05-user-prompt-submit-prompt-discarded.json`](H05-user-prompt-submit-prompt-discarded.json) | UserPromptSubmit with `prompt` | `heartbeat` `working`; prompt absent |
| H06 | [`H06-pre-tool-use-tool-name-only.json`](H06-pre-tool-use-tool-name-only.json) | PreToolUse `shell`, `apply_patch` | `task.started`, `tool_name` only |
| H07 | [`H07-post-tool-use-always-completed.json`](H07-post-tool-use-always-completed.json) | PostToolUse: success, exit code 1, error string | `task.completed` ×3, no `exit_code` / `error_code` |
| H08 | [`H08-mcp-tool-name-kept.json`](H08-mcp-tool-name-kept.json) | MCP `mcp__github__create_issue` | `tool_name` verbatim; arguments absent |
| H09 | [`H09-permission-request-attention.json`](H09-permission-request-attention.json) | PermissionRequest `shell` (X3) | `attention.requested` `waiting`; `tool_name` absent or `shell` |
| H10 | [`H10-stop-idle-last-message-discarded.json`](H10-stop-idle-last-message-discarded.json) | Stop, `stop_hook_active` false and true | `heartbeat` `idle` ×2; message absent |
| H11 | [`H11-subagent-start-stop-agent-ref.json`](H11-subagent-start-stop-agent-ref.json) | Two sub-agents start and stop | `agent.started` / `agent.stopped`, parent ref, two stable agent refs |
| H12 | [`H12-subagent-tool-events-agent-ref.json`](H12-subagent-tool-events-agent-ref.json) | Sub-agent tool events, a root tool event, an unlinked sub-agent (X5) | agent ref on sub-agent events only |
| H13 | [`H13-unmapped-events-dropped.json`](H13-unmapped-events-dropped.json) | Interrupt, Pre/PostCompact, Pre/PostModelRequest, Notification, BeforeTool, no / lower-case event name, PostToolUseFailure | nothing ×10 |
| H14 | [`H14-missing-or-invalid-session-id-dropped.json`](H14-missing-or-invalid-session-id-dropped.json) | `session_id` absent, `null`, `""`, number, object | nothing ×6 |
| H15 | [`H15-malformed-stdin-silent.json`](H15-malformed-stdin-silent.json) | Truncated, empty, `null`, `[]`, a string, control bytes | nothing ×6; exit 0, empty stdout |
| H16 | [`H16-tool-name-over-128-chars.json`](H16-tool-name-over-128-chars.json) | 200-char MCP `tool_name`; a 128-char one (X8) | record kept; prefix ≤ 128 or absent; 128 exact |
| H17 | [`H17-lookalike-and-off-schema-fields-not-copied.json`](H17-lookalike-and-off-schema-fields-not-copied.json) | Sentinel `model` / `permission_mode`, top-level `platform`, `thread_ref`, `agent_ref`, `privacy_class`, `attributes`, nested `tool_name` (X4) | allowlist only, L0, no agent ref |
| H18 | [`H18-proxy-and-header-env-in-hook.json`](H18-proxy-and-header-env-in-hook.json) | Usage on; `HTTP_PROXY`, `http_proxy`, `ALL_PROXY`, javi's bearer in `OTEL_EXPORTER_OTLP_METRICS_HEADERS`, `OTEL_EXPORTER_OTLP_LOGS_HEADERS` (D0 H1, H2) | 3 normal records; exit 0, empty stdout; no value anywhere |
| H19 | [`H19-same-session-id-three-platforms.json`](H19-same-session-id-three-platforms.json) | One raw id via Claude Code, Gemini, Codex | `cc_`, `gm_`, `cx_` refs differ |
| U01 | [`U01-response-completed-cache-aware-input.json`](U01-response-completed-cache-aware-input.json) | in 1000 / cached 400 / write 100 / out 300 / reasoning 120 / tool 1300, `ApiKey`; resend | 500 / 400 / 100 / 300, no cost; resend nothing |
| U02 | [`U02-input-clamp-cache-write.json`](U02-input-clamp-cache-write.json) | 100 = 40 + 60 (official example); 100 < 80 + 60 | input 0 both times |
| U03 | [`U03-counter-wire-types.json`](U03-counter-wire-types.json) | Documented mix; all `intValue` numbers; all `stringValue` (X13) | 900 / 500 / 512 inputs |
| U04 | [`U04-invalid-counters-record-dropped.json`](U04-invalid-counters-record-dropped.json) | `-5`, `1e3`, double, `abc`, 2^53 + 1, `""`, `-1`, `300.0`; one valid (X14) | 1 event (200 / cache 100 / 40) |
| U05 | [`U05-failure-variant-and-other-kinds-ignored.json`](U05-failure-variant-and-other-kinds-ignored.json) | Failure variant, counters + `error.message`, other kinds, no kind / name, other name | nothing; later valid record → 1 event |
| U06 | [`U06-reasoning-and-tool-token-count-never-added.json`](U06-reasoning-and-tool-token-count-never-added.json) | Reasoning 1100 of output 1200; `tool_token_count` 99999 | output = `output_token_count` |
| U07 | [`U07-several-records-and-conversations-one-body.json`](U07-several-records-and-conversations-one-body.json) | 2 resourceLogs, 2 conversations, duplicate record, timestamp-only difference, `timeUnixNano` 0 (X10, X15) | 5 events |
| U08 | [`U08-cost-api-key-separate-report.json`](U08-cost-api-key-separate-report.json) | `ApiKey` token record, then `codex.turn_cost` `0.012345` | token report without cost; cost-only 0.012345 |
| U09 | [`U09-cost-chatgpt-missing-and-other-auth-modes.json`](U09-cost-chatgpt-missing-and-other-auth-modes.json) | `Chatgpt`, missing, `apikey`, `api_key`, `API_KEY` (X17) | tokens only; no cost report |
| U10 | [`U10-cost-invalid-estimated-usd-ignored.json`](U10-cost-invalid-estimated-usd-ignored.json) | 11 invalid strings, a double, an int; `1.5`, `0.000125`, `12` (X18) | 3 cost-only reports |
| U11 | [`U11-cost-event-id-per-turn.json`](U11-cost-event-id-per-turn.json) | Same turn re-emitted later; another turn, same amount (X19) | 1, none, 1 |
| U12 | [`U12-replay-identity-fresh-receiver.json`](U12-replay-identity-fresh-receiver.json) | U01 body on a fresh receiver | same id as U01 `u1` |
| U13 | [`U13-unregistered-conversation-dropped.json`](U13-unregistered-conversation-dropped.json) | Unknown conversation (tokens, cost), no `conversation.id`, one registered | 1 event; drops 1..4 |
| U14 | [`U14-subagent-usage-attributed-to-parent.json`](U14-subagent-usage-attributed-to-parent.json) | SubagentStart, sub-agent + root records, SubagentStop, sub-agent cost (X21) | parent thread with agent ref; root without |
| U15 | [`U15-subagent-usage-before-start-dropped.json`](U15-subagent-usage-before-start-dropped.json) | Sub-agent usage before SubagentStart; after; a prefix-sharing id | dropped; 1 event; dropped |
| U16 | [`U16-resumed-session-registered-by-hook.json`](U16-resumed-session-registered-by-hook.json) | Only a SessionStart `resume` hook (X22) | heartbeat; usage attributed |
| U17 | [`U17-other-codex-records-nothing-stored.json`](U17-other-codex-records-nothing-stored.json) | `codex.user_prompt`, `codex.tool_result`, `codex.tool_decision`, `codex.api_request`, `codex.conversation_starts`, other kind, skill event | nothing, no sentinel; later valid → 1 event |
| U18 | [`U18-codex-records-only-on-the-codex-path.json`](U18-codex-records-only-on-the-codex-path.json) | Codex body on `/v1/logs`, `/v1/traces`, `/`, `/v1/metrics`; Gemini logs on `/v1/logs` and the Codex path (X23) | `200 {}` ×6, nothing; then 1 event on the Codex path |
| U19 | [`U19-codex-path-bearer-and-5-mib-cap.json`](U19-codex-path-bearer-and-5-mib-cap.json) | No bearer; 5 300 000 B; 5 200 000 B (X24) | 401; 413; 200 + 1 event |
| U20 | [`U20-malformed-and-empty-bodies.json`](U20-malformed-and-empty-bodies.json) | Truncated JSON, `{}`, empty `resourceLogs` (X25) | 400 without snippets; `200 {}` ×2; then 1 event |
| U21 | [`U21-same-session-id-three-platforms.json`](U21-same-session-id-three-platforms.json) | One raw id registered on all three; Codex logs, Claude Code delta, Gemini cumulative (X26) | 3 events on 3 threads |
| U22 | [`U22-same-session-id-other-platforms-only-dropped.json`](U22-same-session-id-other-platforms-only-dropped.json) | Raw id registered on Claude Code and Gemini only; Codex tokens and cost | nothing; drops 2..4 |

### Not covered

| Contract item | Why |
|---|---|
| `.codex/hooks.json`: append only, user group positions unchanged, `timeout` in seconds (SessionEnd and Interrupt ≤ 3), `commandWindows`, the launcher file and its mode, refusals for paths with spaces, uninstall listing (C1, D0 H4, M3) | File-level behaviour with no JGR output (TEST_PLAN §S5c process rows). The runner only reads the command to invoke it. |
| `config.toml` beyond [setup checks](#setup-checks): refusal when it does not parse or has any `otel` key, append-only marked block, backup (mode 0600, original only), `usage off` block removal, mode preservation (D0 H6) | File-level behaviour (process tests, Review focus). |
| `usage on` refusal for proxy variables in the shell or `$CODEX_HOME/.env` (D0 H1), warnings for `OTEL_EXPORTER_OTLP_(LOGS_)HEADERS` (M5), the shell startup-output warning (H5), the git-tracked `hooks.json` and project `[hooks]` warnings (Low) | CLI output with no JGR output. H18 covers only what is observable here: the hook still maps, stays silent and leaks no value. |
| The content of the warning records, `javi status` ("waiting for approval in Codex", trust states from `[hooks.state]`, warnings shown first) | Not observable through records; process tests. The warning files are still scanned for leaked values (H18). |
| `ensureReceiver` from hooks starting a receiver that is not running | Process lifecycle (ADR-0011 tests); the runner provides the receiver. |
| A `response.completed` with a counter missing (an older Codex without `cache_write_token_count`), an all-zero response, a cost of exactly `0` | Unspecified: C4 says "token counters present"; ADR-0011 skips all-zero groups for metrics. No vector depends on a reading. |
| gzip or a non-JSON content type on the Codex path, `Host` checks there | Codex sends neither gzip nor protobuf (`protocol = "json"`, D0 M1); the `Host` and content-type checks are the same code as [otlp](../otlp/README.md) 09–17. |
| Spooling failures mid-request ("all or nothing per request") | Needs fault injection; U19's 413 shows the request-level part. |
| Receiver downtime, no Codex retry, lost deltas (D0 M1) | Documented loss; not observable in one vector. |
| Nested sub-agents, internal sub-agents, a resumed sub-agent's usage, mixed `auth_mode` in one conversation, an `ApiKey` cost from a non-OpenAI provider | D0 M4 and Low describe them as dropped or labelled; the wire shapes are UNVERIFIED. U15 covers an unlinked agent id. |
| Agent links of another project, TTL expiry (7 days) | Needs a second project or a clock jump; same rule as ADR-0011 session pruning. |
| Windows `cmd.exe` and PowerShell, a real Codex run, the hook approval flow | UNVERIFIED in ADR-0016 D0; runtime (owner). |

## Differences from the Gemini runner

1. **Codex path and cap.** Codex logs go to `/v1/logs/codex-cli` and are parsed there with a 5 MiB cap; `/v1/logs` and `/v1/traces` stay unparsed sinks (U18, U19).
2. **`CODEX_HOME`.** Every command and hook runs with `CODEX_HOME` = `$HOME/.codex`; `$PORT` and `$SECRET` come from the TOML `[otel]` block, which also gets [setup checks](#setup-checks) S1–S5.
3. **Env hygiene.** Proxy variables of the runner's own environment are removed; only `steps[].env` sets them, and `$SECRET` is substituted there.
4. **Hook invocation.** The command comes from `.codex/hooks.json` (the launcher, found by `--source javi-collector`) and runs with `/bin/sh -c`.
5. **`usageOn`.** Hook vectors may turn usage on (H18) and then need the receiver.
6. **Hook steps in usage vectors.** Usage steps are `request` or `hook`; thread and agent references come from whichever record appears first.
7. **Agent identity.** Records and events carry `agent`; `agent_ref` is compared by identity, and `null` means absent.
8. **Expectations.** All five counters are listed, `reasoning_tokens` is always `0`, `model: null` means absent, `occurred_at: null` means not compared, and the collapse rule ignores `occurred_at` for cost-only reports. There is no `receiverStartedAt` or `priceSource`; `derivation` holds the arithmetic.
9. **Response bodies** are scanned for absent strings (D0 M1).
10. **Counts.** The runner's count test must expect 41 / 19 / 22.

## Changes

- **2026-10-29 (S5c Q1).** First version, from ADR-0016 Changes "S5c design" (C1–C6) and "S5c design review D0", ADR-0011 and JGR v0.1. Commit message `test(JD-C02): Codex conformance vectors — hooks, logs usage, auth-gated cost, sub-agents (S5c Q1)`.

## Ambiguities

| ID | Contract text | Question | Vector choice |
|---|---|---|---|
| X1 | C2 table names no status for `session.*`, `task.*`, `agent.*`, nor for the `resume` / `compact` heartbeat (D0 Low) | Which status do they carry? ADR-0010 used `working` / `completed` for Claude Code sessions. | Not checked. UserPromptSubmit `working`, Stop `idle` and PermissionRequest `waiting` are checked. A valid status is still required where §3 needs one. |
| X2 | D0 Low: "SessionStart with source `compact` or `resume` emits a heartbeat" | What do `clear` and `fork` (also SessionStart sources) emit? | `session.started`: they are not named as exceptions, and Codex starts a new session id for both (H04). |
| X3 | C2: `PermissionRequest` → `attention.requested` waiting | Does the attention record carry `tool_name`? The payload has one; Gemini's attention record had none. | Either: `tool_name` absent, or exactly the payload's `tool_name` (H09 uses a prefix matcher with `maxLength` equal to the name's length). |
| X4 | C2 lists only `tool_name` (tool events) and `platform`; spec §7 L0 allows `model` | May hook records carry `model` from the payload? Must an off-schema `permission_mode` (the schema has an enum) drop the record? | No `model` attribute on hook records; unread fields are not validated, so off-schema values in them do not stop the record (H01, H17). |
| X5 | C2 "`agent_ref` from `agent_id`"; D0 M4 "Sub-agent tool events carry `agent_ref`" | Do root events carry an `agent_ref` (for example a "main" agent)? Does a tool event with an `agent_id` that never had a SubagentStart (resumed sub-agent) carry one? What is its format? | Root events: none. An unlinked `agent_id` on a tool event: its own `agent_ref`, distinct from the linked one (H12). Only the opaque pattern is checked, not a prefix. |
| X6 | C2: "`Interrupt`, the compact events and model-request events are dropped" | Are event names matched exactly? Are names of other platforms (Notification, BeforeTool, PostToolUseFailure) dropped? Is PostModelRequest's `token_usage` used for usage? | Exact, case-sensitive names; everything outside the C2 table is dropped; hooks never produce `usage.reported` (H13). |
| X7 | Codex schemas: `session_id` is a required string | Does an empty or non-string `session_id` give a thread? | No record (H14). |
| X8 | Spec §3 "values string (≤ 128 chars)"; C2 `tool_name` only | Truncate, omit, or drop an over-long tool name? | The record is still produced; `tool_name` is a prefix of at most 128 characters or absent (H16), as Gemini G8. |
| X9 | D0 H1 and H2: the SessionStart hook "writes a local warning record (names only)" | Is the `session.started` record still emitted? Is the warning a JGR record? Do later hooks check too? | The record is emitted (the signal is not lost); the warning is local and not observed. An `x.*` warning record would be ignored for the count but checked by I1, I2, I6 (H18). |
| X10 | C4 keeps `event.timestamp` and no other time | Is `occurred_at` `event.timestamp`, the record's `timeUnixNano`, or the receipt time? | `event.timestamp`. U07 sets `timeUnixNano` to `0` and `observedTimeUnixNano` 30 s later on one record. Elsewhere all three agree. |
| X11 | C5 "event id = HMAC(salt, …)"; ADR-0011 Idempotent retries | Is the Codex id the same UUID v8 layout as ADR-0011? | Yes: the UUID v8 pattern; label identity across U01 / U12. |
| X12 | D0 "Still UNVERIFIED: the scope name and the JSON form of `intValue`", M2 "`event.name` and `event.kind` are log-record attributes"; C4 "records whose attributes say they come from Codex" | What selects a Codex record: the resource, the scope, or the record attributes? | The record attributes `event.name` / `event.kind` only. Resource and scope values are illustrative, and a planted `host.name` must never be copied. |
| X13 | D0 M2 "accepts both forms for every counter" | Is an `intValue` a decimal string or a JSON number? | Both (proto3 JSON allows both for int64; U03). |
| X14 | D0 M2 "non-negative safe integers only" | Is a record with one invalid kept counter dropped, or is that counter taken as 0? | Dropped entirely: guessing 0 for a cached count would over-count input (U04). |
| X15 | C5 id inputs (conversation, timestamp, counters) | Are two records that differ only in `event.timestamp` one report or two? Do identical records collapse? | Two reports; identical records share one id and collapse (U07). |
| X16 | C5 "a separate `usage.reported` carrying only `cost_usd`"; spec §6 at least one counter; ADR-0016 R5 (`estimated` means token counts) | Does the cost-only report carry `model`, token counters (0) or `estimated: true`? What is its `occurred_at`? | No `model`, no counters (absent or 0), `estimated` false or absent; `occurred_at` not compared, because C4 keeps no time for `codex.turn_cost`. |
| X17 | C5 "only when `auth_mode = ApiKey`" | Exact match? Case variants? | Exact, case-sensitive `ApiKey` (Codex's `TelemetryAuthMode` Display). `apikey`, `api_key`, `API_KEY` give no cost (U09). |
| X18 | D0 M2 "`usage.estimated_usd` must match `^\d+(\.\d+)?$`" | Is a non-string value (doubleValue, intValue) ignored? Is an integer string such as `12` valid? | Non-strings are ignored; `12` matches the pattern and is a cost of 12 USD (U10). |
| X19 | C5 cost id = HMAC(salt, `codex-cli`, conversation, `turn.id`) | If the same turn's cost is logged twice with different timestamps, is that one event? | One event id; the collapse rule ignores `occurred_at` for cost-only reports (U11). |
| X20 | ADR-0011 "dropped locally and counted"; C6 "Unknown ids are dropped locally" | Counted per record, per conversation, per request? Is a record without `conversation.id` counted? | Only ranges (U13: 1..4; U15, U22: per step ≥ 1, total 2..4). |
| X21 | C6 links; D0 M4 "7-day TTL like session registration" | Does SubagentStop end the link? Codex polls cost about every 150 s, so cost can arrive after the sub-agent stopped. | The link survives SubagentStop; the later sub-agent cost counts in the parent thread with the agent ref (U14). Whether Codex also includes it in the parent's turn cost is UNVERIFIED (D0). |
| X22 | ADR-0011 "each hook records `thread_ref → project`"; D0 Low (resume → heartbeat) | Does a `resume` SessionStart (a heartbeat) register the session for usage? | Yes, like every hook (U16). |
| X23 | D0 M1 "/v1/logs and /v1/traces stay unparsed sinks for Gemini" | Are the sinks present when Codex usage is on? What do `/` and `/v1/metrics` do with a logs body? | U18 turns Gemini usage on as well. `/` and `/v1/metrics` answer `200 {}` and store nothing (ADR-0011 Changes: no `resourceMetrics` is an empty request). |
| X24 | D0 M1 "a 5 MiB cap. Larger bodies are answered 413" | Is the cap 5 MiB (5 242 880 B) or 5 MB? Exact boundary? | MiB. Margins only: 5 300 000 → 413, 5 200 000 (over 5 MB) → 200 (U19). |
| X25 | D0 M1 "Parse errors return a constant message"; ADR-0011 malformed → 400 | Status for an empty object or empty `resourceLogs`? | `200 {}`, stores nothing (OTLP: an empty request SHOULD succeed; ADR-0011 Changes A3). Truncated JSON → 400 (U20). |
| X26 | ADR-0016 Consequences "one receiver for three agents" | U21 mixes platforms: which rules apply to the Claude Code and Gemini events? | Their own suites' rules: Claude Code delta points as-is with reported cost; Gemini baseline then delta, `oauth-personal` → no cost (R6). |
