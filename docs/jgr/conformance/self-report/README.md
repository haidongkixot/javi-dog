# Agent self-report conformance vectors (ADR-0017, S5d)

Black-box cases for agent self-report: an agent calls javi's MCP tools `report_status` and `report_task`, the post-tool hook turns the call into a JGR record, and the thread reader shows the agent's claim. There are three groups:

- **MCP server (`M*`).** JD-C03 `@javis-dog/collector-mcp-server` over stdio (`javi mcp`, JD-C01). Each step writes one newline-terminated JSON-RPC line and expects one exact response line, or none.
- **Hook mapping (`H*`).** Hook stdin payloads of Claude Code, Codex CLI and Gemini CLI go into javi's hook entries (JD-C01, mapped by JD-C02). Each step expects one JGR record or nothing.
- **Reader precedence (`R*`).** An ordered event sequence for one thread goes into the store; after each event the JD-M12 thread reader must return the expected `status`, `statusSource`, `statusReason` and attention flag.

- **Oracle independence.** Every expectation comes only from the texts under [Sources](#sources). No code under `collectors/**/src`, `packages/**/src` or `apps/**` and no existing unit test was read to write them (QA role, [`TEAM.md`](../../../agent-ops/TEAM.md)). The [Codex](../codex/README.md) and [Gemini](../gemini/README.md) suites (README, schema, a few vectors) were read for format conventions and for the hook payload shapes they already verified; no expected value was taken from an implementation. Where the texts could be read more than one way, the gap was reported to the orchestrator; ADR-0017's Changes entry "QA spec gaps" resolved them, and the vectors now encode the single resolved outcome ([Spec gaps](#spec-gaps-g)). Cases that are still open are left out. No behaviour is invented silently.
- **Format.** One JSON file per case, named `<M|H|R><NN>-<kebab-name>.json`, valid against [`schema.json`](schema.json) (JSON Schema draft-07). Every key is always present, so a runner never guesses a default.
- **Status.** Written 2026-10-30 for S5d task T5. The runner is planned with T5; it is not part of this commit.

## Reused conventions and what is new

Reused from the [Codex](../codex/README.md#runner-rules) and [Gemini](../gemini/README.md#runner-rules) suites, with the same meaning:

| Convention | Where |
|---|---|
| Partial record comparison: **controlled keys** = the L0 allowlist minus the free keys `platform_version`, `collector_version`, `duration_ms`; listed keys compared, unlisted controlled keys MUST be absent; `{ prefixOf, maxLength, optional }` matcher | [Record comparison](#record-comparison) |
| `record: null` = zero records; otherwise exactly one record per step | [Hook steps](#hook-steps) |
| Thread identity per (`platform`, raw session id); `cc_` / `cx_` / `gm_` ref prefixes; agent identity from the first record naming the agent | [Thread and agent identity](#thread-and-agent-identity) |
| `idLabel` identity: same label = same `event_id`, different labels = different ids, scoped to a vector or an `identityGroup` | [Event identity](#event-identity) |
| Absent strings: the global `SENTINEL` and `/home/dev` substrings, raw session and agent ids, plus a per-vector list | [Absent strings](#absent-strings) |
| Pinned clock for the whole vector | [Pinned clock](#pinned-clock) |
| Collector layer required for a PASS; mapper layer optional; process checks (exit 0, empty stdout) | [Hook steps](#hook-steps) |
| Invariants I1–I8, result labels PASS / FAIL / BLOCKED / NOT RUN / SKIPPED | [Invariants](#invariants), [Results](#results) |

New in this suite:

- **Three platforms in one hook vector.** A hook vector may mix `claude-code`, `codex-cli` and `gemini-cli` steps (each with its own session), so one file shows one rule on every platform. `rawStdin` and `env` are dropped: no case needs them.
- **`expect.record.status` is always present.** A string must be equal; `null` means not checked; `{ "notIn": [...] }` means the status, if present, is none of those values (used on ordinary tool events whose input imitates a self-report).
- **`platform` on Claude Code records** is `{ "equals": "claude-code", "optional": true }`, because ADR-0010 does not name a `platform` attribute for Claude Code (Y6).
- **`expect.record.eventId`.** `null`: not checked. `{ "format": "ulid-at-clock", "idLabel": ... }`: the `event_id` is a ULID whose time part is the vector clock, and `idLabel` (or `null` for Gemini) sets its identity.
- **MCP vectors** with a JSON [pattern language](#pattern-language), a no-response rule with a ping barrier, a stderr rule and suite-wide text labels.
- **Reader vectors** with expectations after every event.

## Sources

All at commit `2d4dcc2` (branch `claude/clever-goldberg-wlurty`, "ADR-0017 design review D0"), plus the orchestrator's amendment of ADR-0017 and TEST_PLAN §S5d made on 2026-10-30 after the first QA report (ADR-0017 Changes entry **"QA spec gaps"**; at the time of writing it was not yet committed on top of `2d4dcc2`). Contract strings in the vectors read `ADR-0017 (2d4dcc2 + QA spec gaps)`.

| Source | Sections used |
|---|---|
| [ADR-0017](../../../adr/0017-agent-self-report-mcp-server.md) | **Normative.** Decision 1 (handshake, methods, message rules, errors, stdout and stderr), decision 2 (vocabularies, strict arguments, annotations, instructions ≤ 1 000 characters, honest answer), decision 3 (match per platform, one record per hook call, silent pre-tool hooks, validation, mapping, sub-agents, thread / sequence / ids, the one exception, divergence on failed calls), decision 4 (reason in `error_code`), decision 6 (agent status, precedence, reader, attention). The **Changes — design review D0** table (H1, H2, M1–M7, L1–L5), the **Changes — QA spec gaps** table (G1–G3, G6–G12, G14, G19) and the amended decisions 1–3 and 6 win over the earlier text. Research table: payload fields per CLI, Gemini `mcp_context`, Codex `_meta.sessionId`, protocol versions. |
| [JGR spec v0.1](../../spec/v0.1.md) | §3 envelope (opaque refs, attribute limits, sequence), §4 types (`agent.*` and `heartbeat` need a status), §5 statuses (`stale` is never sent), §7 L0 allowlist (`tool_name`, `task_kind`, `error_code`), §12 Claude Code hook mapping and edge rules (`tool_input`, `tool_response` dropped). |
| [TEST_PLAN §S5d](../../../agent-ops/TEST_PLAN.md) | Rows on strict vocabularies, handshake, `tools/call`, hook mapping, read restrictions, invalid input, one record per call, sub-agents, derived ULID, sentinels, "not recorded". The row on invalid self-report input now reads "no record at all for that javi call" (G5 fixed). |
| [SPRINT-05d](../../../sprints/SPRINT-05d.md) | Goal, global constraints (no free text, input never echoed), T5 acceptance ("every vector PASS, mutation-checked"), review focus (prompt-like strings in extra keys, third-party `tool_input` never read). |
| [ADR-0010](../../../adr/0010-claude-code-collector.md) §Decision Mapping | Claude Code ordinary mapping only: `Pre/PostToolUse/PostToolUseFailure` → `task.*` with `tool_name`, `Notification permission_prompt` → `attention.requested` (waiting), `SubagentStart` → `agent.started` with `agent_ref` from hashed `agent_id`, `UserPromptSubmit` → `heartbeat working`, `Stop` → `heartbeat idle`. |
| [Codex suite](../codex/README.md), [Gemini suite](../gemini/README.md) | Format conventions (above) and the verified payload shapes: Codex `PreToolUse` / `PostToolUse` / `PermissionRequest` / `SubagentStart` / `UserPromptSubmit` / `Stop` fields; Gemini base fields with `timestamp`, `BeforeTool` / `AfterTool` with `mcp_context` and `original_request_name`, `BeforeAgent` / `AfterAgent`, `Notification` `ToolPermission`. |

**Claude Code payloads** use the documented hook shape: `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`, `tool_name`, `tool_input`, `tool_use_id`, `tool_response` (`PostToolUse`), `error` and `is_interrupt` (`PostToolUseFailure`), optional `agent_id` and `agent_type`. **Illustrative values:** `gpt-5.5-codex`, the `agent_type` values, the tool response texts and the `mcp_context.command` / `args` / `cwd` / `url` values. An implementation MUST NOT depend on them.

**Timestamps.** Every hook vector's `clock` is `2026-10-30T10:00:00Z`. Gemini payload `timestamp`s are `2026-10-30T10:00:00.000Z`, except one H11 step at `09:59:00.000Z`: the hook time is javi's own clock, never a time inside the payload (G12), so that step's ULID time part is still the clock. Claude Code and Codex payloads carry no time.

## Vector file format

### MCP vectors (`M*`)

```json
{
  "$schema": "./schema.json",
  "id": "M07",
  "kind": "mcp",
  "description": "What the case proves",
  "contract": "ADR-0017 (at 2d4dcc2) decision 1 …",
  "ambiguities": [],
  "server": { "hooksInstalled": true },
  "steps": [
    {
      "note": "tools/list before initialize → -32600",
      "send": { "jsonrpc": "2.0", "id": 1, "method": "tools/list" },
      "rawLine": null,
      "expect": { "jsonrpc": "2.0", "id": 1, "error": { "code": -32600, "message": { "$match": "string" }, "data": { "$match": "any", "optional": true } } }
    }
  ],
  "stderrForbidden": ["initialize", "notifications/initialized", "ping", "tools/call", "tools/list"],
  "absentStrings": ["SENTINEL_STATUS_M07"]
}
```

| Field | Meaning |
|---|---|
| `server.hooksInstalled` | `true`: javi's hooks for the server's platform and project are installed, so a valid call is noted. `false`: they are not (only M20), so a valid call answers "not recorded" (ADR-0017 decision 2, Honest answer). |
| `steps[]` | Written **in order** to one fresh server process (or instance). Each step waits for its response before the next step is sent. |
| `steps[].send` / `rawLine` | Exactly one is non-null. `send` is serialized compactly (`JSON.stringify`) and written followed by `\n`. `rawLine` is written byte for byte (UTF-8) followed by `\n`; it holds broken JSON, or the `__proto__` case (M17), which `JSON.stringify` cannot produce. |
| `steps[].expect` | `null`: the step produces **no** stdout line ([No response](#no-response)). Otherwise a [pattern](#pattern-language) that the **next** stdout line, parsed as JSON, must match. |
| `stderrForbidden` | Method names sent in the vector. None may occur in stderr ("no method names", decision 1). |
| `absentStrings` | Every planted `SENTINEL_*` token, plus prompt-like phrases where planted. None may occur in stdout or stderr. |

### Hook vectors (`H*`)

```json
{
  "$schema": "./schema.json",
  "id": "H02",
  "kind": "hook",
  "description": "What the case proves",
  "contract": "ADR-0017 (at 2d4dcc2) decision 3 Mapping …",
  "ambiguities": [],
  "clock": "2026-10-30T10:00:00Z",
  "identityGroup": null,
  "steps": [
    {
      "platform": "codex-cli",
      "note": "PostToolUse mcp__javi__report_status {\"status\":\"waiting\",\"reason\":\"needs_approval\"}",
      "stdin": { "session_id": "cx-sess-h02", "hook_event_name": "PostToolUse", "tool_name": "mcp__javi__report_status", "...": "..." },
      "expect": {
        "record": {
          "type": "heartbeat",
          "session": "cx-sess-h02",
          "agent": null,
          "status": "waiting",
          "attributes": { "platform": "codex-cli", "tool_name": "mcp__javi__report_status", "error_code": "waiting.needs_approval" },
          "eventId": { "format": "ulid-at-clock", "idLabel": "cx4" }
        }
      }
    }
  ],
  "absentStrings": ["SENTINEL_CALL_H02_S9", "..."]
}
```

| Field | Meaning |
|---|---|
| `clock` | Pinned time for the vector ([Pinned clock](#pinned-clock)). Always `2026-10-30T10:00:00Z`. |
| `identityGroup` | `null`, or `self-report-event-id` (H11 and H12): the scope of `idLabel` comparison across the two vectors. |
| `steps[]` | Hook invocations, run **in order** against one `HOME`. Sequence counters, thread refs and agent links persist between steps. |
| `steps[].platform` | `claude-code`, `codex-cli` or `gemini-cli`: which platform's hook entry receives the payload. |
| `steps[].stdin` | The payload, serialized compactly. |
| `expect.record` | `null`: zero records. Otherwise exactly one record matching the object. |
| `record.type` | The JGR type. |
| `record.session` | The raw session id whose [thread reference](#thread-and-agent-identity) the record carries. |
| `record.agent` | `null`: `agent_ref` MUST be absent. A string: the raw `agent_id` whose agent reference the record MUST carry. |
| `record.status` | A string: equal. `null`: not checked (a valid status is still required where §3 needs one). `{ "notIn": [...] }`: absent, or none of the values. |
| `record.attributes` | Controlled-key expectation ([Record comparison](#record-comparison)), or `null`: invariants only (Claude Code `SessionStart` and `SubagentStart`, which only establish the thread and the agent). |
| `record.eventId` | `null`: not checked. `{ "format": "ulid-at-clock", "idLabel": "<label>" \| null }`: see [Event identity](#event-identity). |
| `absentStrings` | Per-vector [absent strings](#absent-strings). |

### Reader vectors (`R*`)

```json
{
  "$schema": "./schema.json",
  "id": "R01",
  "kind": "reader",
  "description": "What the case proves",
  "contract": "ADR-0017 (at 2d4dcc2) decision 6 …",
  "ambiguities": [],
  "platform": "claude-code",
  "steps": [
    {
      "note": "agent reports blocked",
      "event": { "type": "heartbeat", "status": "blocked", "toolName": "mcp__javi__report_status", "errorCode": "blocked.missing_credentials", "agent": null, "receivedAt": "2026-10-30T10:00:02Z", "sequence": 2 },
      "expect": { "status": "blocked", "statusSource": "agent", "statusReason": "missing_credentials", "needsAttention": true }
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `platform` | `attributes.platform` of every built event (`claude-code`). |
| `steps[].event.type` / `status` | The JGR `type` and `status` (`null`: no `status` key). |
| `event.toolName` / `errorCode` | `attributes.tool_name` / `attributes.error_code`, or `null`: the key is absent. |
| `event.agent` | `null`: no `agent_ref`. A label: `agent_ref` = `agent_<label>`. |
| `event.receivedAt` / `sequence` | The stored receipt time and the JGR `sequence`. They define the reader order, which may differ from the step order (R12). |
| `steps[].expect` | The thread state after this event is stored, or `null` (not checked; unused today). `status` may be `null`: no status at all (R17). |
| `expect.needsAttention` | The reader's attention flag for the thread (the runner maps it to the reader's field and names it in its report). |

## Pattern language

An MCP `expect` is a JSON value read as a pattern. A pattern P matches a value V as follows.

| P | Rule |
|---|---|
| string, number, boolean, `null` | V has the same JSON type and is equal. `42` does not match `"42"`. |
| array | V is an array of the same length; element i matches P[i]. |
| object with `$match` | A matcher (below). |
| other object | V is an object. Every key of P (other than `$open`) must match: a matcher with `"optional": true` may be absent; any other key must be present and match. Keys of V that P does not list are allowed only when P has `"$open": true`; otherwise V has exactly the keys of P. |

| Matcher | Rule |
|---|---|
| `{ "$match": "any" }` | Any value. |
| `{ "$match": "string", ... }` | A string. Options: `minLength` / `maxLength` (in UTF-16 code units, as JavaScript `length`; all expected strings here are ASCII-bounded), `startsWith`, `containsAll` (each listed substring occurs, case-sensitive), `noDeliveryClaim` ([rule Y3](#readings-y)), `label` ([text labels](#text-labels)). |
| `{ "$match": "oneOf", "values": [P1, P2, ...] }` | V matches at least one listed pattern (used today only for `isError` absent-or-`false`). |
| `{ "$match": "setEquals", "values": [...] }` | V is an array of primitives with the same elements as `values`, in any order, with no duplicates. Used for `enum` and `required`. |
| `{ "$match": "unorderedArray", "items": [P1, P2, ...] }` | V is an array of the same length, and a one-to-one assignment exists where each element matches a distinct item pattern. Used for `tools/list`. |

Any matcher may carry `"optional": true`.

**Shapes used by every MCP vector**, written as patterns in the files:

- JSON-RPC error: `{ "jsonrpc": "2.0", "id": <id>, "error": { "code": <code>, "message": <string>, "data": <any, optional> } }`. The message text is free, but it is scanned for absent strings like everything else.
- Valid `tools/call`: `result` is open; `content` is exactly one item `{ "type": "text", "text": <non-empty string, noDeliveryClaim> }` (the item is open); `isError` is absent or `false`.
- Invalid `tools/call` (unknown keys, wrong types including `reason: null`, values outside the lists, missing required keys, missing or non-object `arguments`, a `reason` with another status): `result.isError` is `true`; one text item whose text has label `report_status.invalid` or `report_task.invalid` and contains every status (report_status) or every phase and kind (report_task) (G4). Validation comes before the hooks check (G3), so this holds with `hooksInstalled: false` too.
- `initialize`: `result` has exactly `protocolVersion`, `capabilities` = exactly `{ "tools": { "listChanged": false } }`, `serverInfo` = exactly `{ "name": "javi", "version": <non-empty string> }`, and `instructions` (1–1 000 characters, mentions `report_status` and `report_task`).
- `tools/list`: `result.tools` holds exactly the two tools in any order. Each tool object is open (a `title` or `outputSchema` may be added) and has `name`, an optional non-empty `description`, `inputSchema` and `annotations`. `inputSchema` is open and has `type: "object"`, `properties` with **exactly** the tool's keys (each property open, with `type: "string"` and an `enum` equal as a set to the ADR list), `required` equal as a set to `["status"]` or `["phase", "kind"]`, and `additionalProperties: false` (Y2). `annotations` is exactly `{ "readOnlyHint": false, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false }`.

## Runner rules

### MCP steps

**Layers.** Either layer may PASS; the report names the layer.

- **Process layer**: the built `javi.mjs mcp --platform claude-code --project web-app`, after `javi init --project web-app` in a temporary project and `HOME` (`hooksInstalled: true`), or in a `HOME` where javi's hooks are not installed for that project (`hooksInstalled: false`). If `init` refuses, the vector is BLOCKED.
- **Instance layer**: JD-C03 `createMcpServer()` over in-memory streams, with whatever option or state stub makes javi's hooks count as installed or not. stdout and stderr are the two streams it is given.

**Writing.** One fresh server per vector. For each step, write the line and `\n`, then observe.

**Response.** When `expect` is a pattern, read the next complete stdout line (terminated by `\n`) within 5 s. It MUST parse as one JSON object with `"jsonrpc": "2.0"`, and match the pattern. No response within 5 s is a FAIL.

<a id="no-response"></a>**No response.** When `expect` is `null`, write the barrier `{"jsonrpc":"2.0","id":"__barrier_<step index>","method":"ping"}` next. The next stdout line MUST be exactly the ping result `{"jsonrpc":"2.0","id":"__barrier_<step index>","result":{}}` (compared as JSON). Any other line before it is a FAIL. Barrier ids contain no sentinel, and ping is allowed before `initialize` (decision 1), so the barrier never changes the server state. The barrier exchange is not part of the vector and is not scanned against `stderrForbidden`.

**stdout.** Every byte on stdout belongs to a newline-terminated line that parses as a JSON-RPC 2.0 response (decision 1: "stdout carries only newline-terminated JSON-RPC messages"). After the last step, close stdin and wait up to 2 s for exit; any further stdout line is a FAIL. Exit status is not checked.

**stderr.** stderr is read in full after exit (or after 2 s). It may be empty. Otherwise:

- it MUST NOT contain any absent string (global or per vector) or any `stderrForbidden` entry;
- every stderr line is at most 200 characters;
- across the whole suite run, the set of distinct non-empty stderr lines has at most 20 members (a "fixed strings" check: echoed input would multiply lines).

#### Text labels

A `label` on a string matcher names a constant. All strings matched under the same label, **across the whole suite run**, MUST be identical (decision 2: "a constant per tool"; decision 2 Honest answer: "a constant"). Labels: `report_status.invalid`, `report_task.invalid`, `not-recorded`. Different labels are not required to differ.

### Hook steps

#### Fixed environment

| Item | Value |
|---|---|
| `HOME` | A fresh temporary directory per vector, not under `/home/dev`. Real `~/.claude`, `~/.codex`, `~/.gemini` and `~/.javi` are never touched. |
| `CODEX_HOME` | `$HOME/.codex`, set for every `javi` command and hook process, as in the Codex suite. |
| Env hygiene | As in the [Codex suite](../codex/README.md#fixed-environment): no `OTEL_*`, proxy, `CODEX_*` (other than `CODEX_HOME`), `GEMINI_TELEMETRY_*`, `CLAUDE_CODE_*` variables from the runner's environment. |
| Salt | One fixed installation salt, the same for every vector of a run (thread identity and the `self-report-event-id` group compare across vectors). |
| Project | One temporary project directory with slug `web-app`, not a git repository, initialised with `javi init --project web-app`, `javi init --project web-app --platform codex-cli` and `javi init --project web-app --platform gemini-cli`, **without** `--self-report`: the mapping does not depend on registration (decision 3 "Independent of registration", G11), so this setup also checks that rule. A non-zero exit is BLOCKED. |
| Ingest | A capturing stub on `127.0.0.1` answering `202 {"accepted": n, "duplicates": 0, "rejected": []}` and recording every decompressed batch. |

#### Pinned clock

`clock` is the current time for setup and every hook step, as in the Codex and Gemini suites. If the runner cannot pin it, `eventId` checks are NOT RUN (listed next to the result) and the rest of the vector may run with the real clock; the vector cannot then PASS H11 or H12, which are BLOCKED.

#### Invocation and observation

- **Collector layer** (required for a PASS): `claude-code` steps run the argv of javi's entry in `<project>/.claude/settings.local.json`; `codex-cli` steps follow the [Codex suite invocation](../codex/README.md#hook-steps) (`.codex/hooks.json`, `/bin/sh -c`); `gemini-cli` steps use the argv of javi's entry in `<project>/.gemini/settings.json`. `cwd` = the project, `CLAUDE_PROJECT_DIR` / `GEMINI_PROJECT_DIR` / `GEMINI_CWD` = the project for those platforms only.
- **Mapper layer** (optional, fast): JD-C02's mapper for the platform with the run's salt and clock. Process checks and spool scans are NOT RUN there.
- **Process checks**, every step: exit code `0` and **0 bytes** on stdout. stderr is not checked.
- **Observation**: after the hook exits and any flush it started has finished or is captured (a fixed 4 s wait, or a harness hook that awaits pending writes), collect the records whose canonical `event_id` was not seen before in this vector, from the spool and the captured batches together. Ignore extension types `x.*`, but apply I1, I2 and I6 to them. Self-reports may be flushed at once (decision 3, Prompt delivery); that does not change what is observed.

#### Record comparison

| Check | Rule |
|---|---|
| `type` | Equal. |
| `thread_ref` | The [thread reference](#thread-and-agent-identity) for (`step.platform`, `record.session`). |
| `agent_ref` | `agent` `null`: absent. A string: equal to the agent reference for (`step.platform`, `record.session`, `agent`). |
| `status` | As in the field table. |
| `attributes` (object) | **Controlled keys** = the L0 allowlist (spec §7) minus the free keys `platform_version`, `collector_version`, `duration_ms`. A listed string must be equal. `{ "equals", "optional" }`: equal when present; absent allowed only when `optional`. `{ "prefixOf", "maxLength", "optional" }`: when present, a non-empty string of at most `maxLength` characters that `prefixOf` starts with; absent allowed only when `optional`. Every controlled key **not** listed MUST be absent: no `error_code` without a reason, no `task_kind` on a heartbeat, no `tool_name` on a collector heartbeat, no `model` from the Codex payload. Free keys MAY be present and are not compared. |
| `attributes` (`null`) | Invariants only. |
| `sequence` | Per thread, strictly increasing in step order (JGR-R06; decision 3 "uses the hook's own … sequence"). |

#### Thread and agent identity

- Within a run, every record for the same (`platform`, raw session id) carries the same `thread_ref`; different pairs carry different refs, including the same raw id on two platforms (H11 step 6). `claude-code` refs match `^cc_[A-Za-z0-9_:-]+$`, `codex-cli` `^cx_…`, `gemini-cli` `^gm_…`; all at most 128 characters.
- The thread reference for a (`platform`, session) is the `thread_ref` of the first record the vector produced for it. A self-report record MUST carry the same `thread_ref` as the session's other records (decision 3 "joins the session's thread").
- The agent reference for (`platform`, session, `agent`) is the `agent_ref` of the first record naming that agent (its `agent.started` in H06). Later records naming it carry the same `agent_ref`; it matches `^[A-Za-z0-9_:-]{1,128}$` and differs from every `thread_ref`.

#### Event identity

For a record whose `eventId` is not `null`:

- `event_id` is a ULID: 26 characters of Crockford base32 (`^[0-9A-HJKMNP-TV-Z]{26}$` after upper-casing). Its first 10 characters decode to the millisecond Unix time of `clock` (`1793354400000`, decision 3 "the time part is the hook time").
- `idLabel` a string: within the scope (the vector, or all vectors of the `identityGroup`), the same label means the same canonical `event_id`, and different labels mean different ids. Run H11 and H12 in the same run with the same salt and clock.
- `idLabel` `null` (Gemini): no identity assertion beyond "not seen before in this vector", which the observation rule already requires; two identical Gemini payloads in one vector therefore yield two records (decision 3 "a fresh ULID").

The labels encode decision 3's HMAC input (platform ‖ session id ‖ call id): H11 varies the call id (`cc1` / `cc2`), the session (`cc3`) and the platform (`cx3`, the same session string and call id on `codex-cli`), and H12 replays four of them in a fresh `HOME` in another order.

#### Absent strings

Compared case-sensitively as substrings. **Global**, for every hook vector: the substring `SENTINEL` (every call id, path, prompt, response, `mcp_context` value and look-alike input contains it), the substring `/home/dev`, every raw session id and every raw `agent_id` of the vector. **Per vector**: `absentStrings`. **Where**: every emitted record (any type), every spool file and captured batch, and, when the runner can inspect it, every file under `$HOME/.javi` (raw ids MUST NOT be stored, ADR-0010 hashing).

For MCP vectors the same global `SENTINEL` rule and the per-vector list apply to stdout and stderr.

#### Invariants

Checked after every hook step, in addition to the expectations.

| # | Invariant |
|---|---|
| I1 | Every emitted record validates as JGR v0.1 with the JD-M01 public validator at `now` = `clock`. |
| I2 | `privacy_class` is absent or `"L0"`; no `encrypted`; attribute keys are on the L0 allowlist; strings ≤ 128 characters. |
| I3 | Records of a platform carry that platform's ref prefix; `attributes.platform`, when present, equals the step's platform. |
| I4 | No step emits more than one record (decision 3 "no hook ever produces two records"). |
| I5 | Every `heartbeat` that carries `tool_name` came from a javi tool call step (decision 6 / review L1: no collector heartbeat has a `tool_name`). |
| I6 | The [absent strings](#absent-strings) rule holds. |
| I7 | Per thread, sequences strictly increase in emission order. |
| I8 | Collector layer: exit `0`, empty stdout. |

### Reader steps

- **Store.** A fresh store per vector (PGlite or the reader's test store), one project (`web-app`), one producer (`prod_conformance`), one thread (`cc_rv_<vector id>`).
- **Events.** For each step, build a JGR v0.1 event: a fresh `event_id`, `occurred_at` = `receivedAt`, `type`, `status` (omitted when `null`), `sequence`, `agent_ref` = `agent_<label>` when `agent` is set, `attributes` = `{ platform, tool_name?, error_code? }` (omitted when `null`), and `usage_delta: { "input_tokens": 1 }` for `usage.reported`. Store it with `received_at` = `receivedAt`. A runner that cannot set `received_at` reports the vector BLOCKED; R12 depends on it.
- **Read.** After each step with a non-null `expect`, call the JD-M12 thread reader at `now` = that step's `receivedAt` + 1 s (so the thread is fresh and staleness never adds attention). Compare `status`, `statusSource`, `statusReason` (`null` = null or absent) and the attention flag exactly.
- The reader orders by `received_at`, then `sequence`, then row id (decision 6, Ordering). Every vector except R12 has strictly increasing `receivedAt`.

### Results

Each vector reports exactly one of PASS, FAIL, BLOCKED, NOT RUN or SKIPPED (Orcasus contract), with the same meanings as the [Codex suite](../codex/README.md#results). A FAIL on a vector that lists G or Y ids names them, so the owner can decide whether the reading or the implementation is wrong. Checks a layer cannot perform are listed as NOT RUN next to the vector result and never folded into PASS. SKIPPED needs a recorded owner decision on a listed gap.

## Cross-platform matrix

Rows are ADR-0017 rules; cells name the vectors that check them per platform. "N/A" means the rule does not apply to that platform; "—" means not covered (see [Not covered](#not-covered)).

| Rule (ADR-0017 decision 3 unless noted) | Claude Code | Codex CLI | Gemini CLI |
|---|---|---|---|
| Match: exact `mcp__javi__report_status` / `mcp__javi__report_task` | H01–H06, H08 | H01–H06, H08 | N/A |
| Match: `mcp_context.server_name` = `javi` and `mcp_context.tool_name` ∈ {report_status, report_task} only | N/A | N/A | H01–H05, H07 |
| Look-alike names → ordinary tool, `tool_input` unread | H08 | H08 | H07 |
| `report_status` → `heartbeat` + status + `tool_name` | H01, H14 | H01, H14 | H01, H14 |
| reason → `error_code` `<status>.<reason>` | H02, H06, H09, H10, H14 | H02, H06, H10, H14 | H02, H09, H10, H14 |
| `report_task` phases → `task.*` + `task_kind` | H03, H06, H09 | H03, H06 | H03, H07, H09 |
| `tool_name` taken as given in the payload (G19) | H01–H03 | H01–H03 | H07 (unprefixed `report_task`) |
| Pre-tool hook silent for javi's tools | H04 (`PreToolUse`) | H04 (`PreToolUse`) | H04 (`BeforeTool`) |
| One record per javi call, no generic tool event | H01–H03 (I4) | H01–H03 (I4) | H01–H03 (I4) |
| Invalid input → no record at all | H05, H09 | H05 | H05 |
| Mapping independent of `--self-report` registration (G11) | every H vector ([Fixed environment](#fixed-environment)) | every H vector | every H vector |
| Sub-agent: `report_status` dropped, `report_task` with `agent_ref` | H06 | H06 | N/A (G13) |
| Failed call still maps | H09 (`PostToolUseFailure`) | N/A (Codex runs `PostToolUse` only on success) | H09 (`AfterTool` with error) |
| Only tool name, `tool_input`, `mcp_context.server_name/tool_name` read; `tool_response` and the rest of `mcp_context` never copied | H10 | H10 | H07, H10 |
| Other tools' `tool_input` never copied | H08, H09, H10 | H08, H10 | H07, H10 |
| Same thread and next sequence as the hook | H01–H06, H14 | H01–H06, H14 | H01–H05, H14 |
| `event_id` ULID at javi's clock (G12) | H01–H06, H09–H12, H14 | H01–H06, H10–H12, H14 | H01–H05, H07, H09–H12, H14 (H11: payload `timestamp` ≠ clock) |
| `event_id` stable per (platform, session, call id) | H11 + H12 | H11 + H12 | N/A (fresh ULID) |
| Collector heartbeats carry no `tool_name` (decision 6, L1) | H14 | H14 | H14 |
| Permission prompt for javi's tool still → `attention.requested` | H13 (`Notification`) | H13 (`PermissionRequest`) | H13 (`Notification ToolPermission`) |
| MCP server (platform-neutral, decisions 1–2) | M01–M22 | M01–M22 (M02 2025-06-18; M21 `_meta.sessionId`) | M01–M22 (M02 2025-06-18) |
| Reader precedence (platform-neutral, decision 6) | R01–R18 | R01–R18 | R01–R18 |

## Vectors

| Id | Proves | Steps |
|---|---|---:|
| M01 | `initialize` 2025-11-25 echoed; exact capabilities, serverInfo, instructions ≤ 1 000; `notifications/initialized` unanswered; ping `{}`; `tools/list` | 4 |
| M02 | 2025-06-18 echoed | 3 |
| M03 | 2025-03-26 echoed | 3 |
| M04 | 2024-11-05 (real, not in the list) → 2025-11-25 | 3 |
| M05 | 2026-07-28 (current spec, not in the list) → 2025-11-25 | 2 |
| M06 | Sentinel version and client info → 2025-11-25, never echoed | 3 |
| M07 | Before `initialize`: `tools/list`, `tools/call` → -32600, ping works; after: both work | 8 |
| M08 | `server/discover`, unknown and unoffered methods → -32601 before `initialize` too (G1), and after | 7 |
| M09 | Unoffered standard methods → -32601 | 8 |
| M10 | Notifications (known, unknown, request names without id) never answered | 11 |
| M11 | Malformed JSON → -32700, `id: null`, even with a visible id | 8 |
| M12 | Batch arrays (with requests, notifications only, empty) → one -32600, `id: null` | 7 |
| M13 | `id` echoed with its JSON type (string, 0, negative, 2^53−1) on results and errors | 12 |
| M14 | `tools/list`: exactly two tools, exact enums, `required`, `additionalProperties: false`, exact annotations | 4 |
| M15 | Every valid `report_status` input → success text without a delivery claim | 22 |
| M16 | Every phase and kind of `report_task` → success | 12 |
| M17 | Invalid `report_status` inputs, including `reason: null`, missing `status` and missing / non-object `arguments` → `isError` constant text, input never echoed (G2, G10) | 27 |
| M18 | Invalid `report_task` inputs, including missing keys → `isError` constant text (G2) | 16 |
| M19 | Unknown tool names (sentinel, client-prefixed, case, empty) → -32602 | 8 |
| M20 | Hooks not installed: valid calls → "not recorded: javi hooks are not installed for this project"; invalid input → the validation constant first; `tools/list` unchanged (G3) | 8 |
| M21 | Sentinels in `_meta`, unknown tools / methods, broken JSON never on stdout or stderr; `_meta` is not an argument | 8 |
| M22 | `"id": null` → -32600 with `id: null` before and after `initialize`; a second `initialize` answered like the first (G14) | 9 |
| H01 | `report_status` without reason → heartbeat, `tool_name`, no `error_code` (3 platforms) | 15 |
| H02 | `report_status` with reason → `error_code` `<status>.<reason>` (3 platforms) | 12 |
| H03 | `report_task` → `task.started` / `completed` / `failed` + `task_kind` (3 platforms) | 12 |
| H04 | Pre-tool hooks silent for javi's tools; the post-tool hook emits the one record | 15 |
| H05 | Invalid input → no record at all (13 inputs × 3 platforms), then a valid call maps (G5) | 45 |
| H06 | Sub-agent `report_status` dropped, `report_task` with `agent_ref` (Claude Code, Codex) | 14 |
| H07 | Gemini matched only on `mcp_context`; look-alikes and missing context → ordinary tool; an unprefixed payload `tool_name` is kept as given (G19) | 11 |
| H08 | Claude Code / Codex look-alike names → ordinary tool; pre-tool not silent for them | 20 |
| H09 | Claude Code `PostToolUseFailure` and Gemini `AfterTool` with error still map; type from the phase | 9 |
| H10 | Sentinels in other tools' input and in javi's `tool_response` / `mcp_context` never copied | 15 |
| H11 | `event_id` run A: ULID at javi's clock even when the Gemini `timestamp` differs (G12); ids differ per call id, session and platform | 9 |
| H12 | `event_id` run B: replay in a fresh `HOME` gives the same ids (Claude Code, Codex) | 5 |
| H13 | Permission prompts for javi's tools still → `attention.requested` (Y5) | 6 |
| H14 | Self-report in the session thread between collector heartbeats without `tool_name` | 12 |
| R01 | Agent `blocked` survives end-of-turn `idle`; a prompt heartbeat clears it | 5 |
| R02 | Survives `usage.reported`, `error`, `idle`; `attention.requested` clears it (G8) | 5 |
| R03 | Cleared by `task.started`, `task.completed`, `task.failed` carrying a status | 6 |
| R04 | Cleared by `session.started` | 2 |
| R05 | Cleared by `session.ended` | 2 |
| R06 | Cleared by `agent.started` / `agent.stopped` | 4 |
| R07 | Agent `waiting` needs attention, with or without reason | 3 |
| R08 | Collector-only `blocked` needs no attention; collector `waiting` does | 3 |
| R09 | `statusReason` only for a listed reason whose prefix equals the status (G9) | 8 |
| R10 | A newer self-report replaces the older | 5 |
| R11 | Structural match: any heartbeat with a `tool_name` is an agent status | 3 |
| R12 | Order by `received_at`, then `sequence`, not insertion order | 4 |
| R13 | `attention.requested` clears an agent `working` or `completed`: collector `waiting` with attention (G8) | 5 |
| R14 | Collector-only thread keeps the existing rule | 5 |
| R15 | A self-reported `task.*` is not itself an agent status | 2 |
| R16 | A status-less clearing event shows the latest non-agent status from before the report (G6) | 5 |
| R17 | Cleared with no non-agent status ever → status `null`, source `collector` (G6) | 2 |
| R18 | A self-reported `task.*` clears an agent status (G7) | 5 |

Totals: 22 MCP vectors (193 steps), 14 hook vectors (200 steps), 18 reader vectors (74 steps).

## Suggested mutation checks

Each mutation must turn at least the listed vector to FAIL (SPRINT-05d T5 "mutation-checked").

| Mutation | Vector |
|---|---|
| Echo any requested `protocolVersion` | M04, M05, M06 |
| Answer 2026-07-28 or the newest known version for unknown versions | M04, M05 |
| Omit `capabilities.tools.listChanged` or add capabilities | M01 |
| Answer `-32601` (or anything) to a notification | M10 |
| Serve `tools/list` before `initialize` | M07 |
| Answer `-32600` to `server/discover` or unknown methods before `initialize` | M08 |
| Echo `id` as a string, or use `0` / the visible id on parse errors | M11, M13 |
| Treat `"id": null` as a notification, or refuse a second `initialize` | M22 |
| Process batch elements | M12 |
| Drop `additionalProperties: false`, or change an enum or annotation | M14 |
| Accept unknown argument keys, `reason: null`, or a `reason` with `working` | M17, M18 |
| Answer -32602 for missing keys or non-object `arguments` | M17, M18 |
| Echo the input (or a key name) in the `isError` text | M17, M18, M20, M21 |
| Say "sent" or "delivered" in the success text | M15, M16 |
| Return `isError: false` when hooks are not installed | M20 |
| Check the hooks state before validating, or hide tools without hooks | M20 |
| Log the method name or the request line to stderr | every M vector with `stderrForbidden` |
| Match javi's tools by prefix, case-insensitively, or by Gemini `tool_name` | H07, H08 |
| Canonicalize Gemini's `tool_name` to `mcp_javi_<tool>` | H07 |
| Map javi's tools only when `--self-report` is registered | every H vector with a self-report |
| Emit a generic `task.completed` next to the self-report | H01, H02, H03 (I4) |
| Emit a generic tool event for invalid input | H05 |
| Map pre-tool hooks for javi's tools | H04 |
| Let a sub-agent set the status | H06 |
| Read `tool_response` instead of `tool_input` | H10 |
| Copy `tool_input` of other tools | H07, H08, H10 |
| Map `PostToolUseFailure` of javi's tool to `task.failed` from the failure | H09 |
| Use a random ULID for Claude Code / Codex, or leave the platform or session out of the HMAC | H11, H12 |
| Take the ULID time from the Gemini payload `timestamp` | H11 |
| Clear the agent status on collector `heartbeat idle`, `usage.reported` or `error` | R01, R02, R10 |
| Keep the agent status on `attention.requested` | R02, R13 |
| Never clear it on `task.*`, `session.*` or `agent.*` | R03–R06, R16, R18 |
| Show the agent's own status after a status-less clearing event | R16, R17, R18 |
| Match `statusSource` on tool names | R11 |
| Accept any reason text, or ignore the prefix | R09 |
| Count collector-only `blocked` as attention | R08 |
| Order by insertion instead of `received_at`, `sequence` | R12 |

## Not covered

| Contract item | Why |
|---|---|
| Prompt delivery (decision 3: urgent flush for status ≠ `working`, `task.failed`, end-of-turn `idle`) | Observable only as "spawnFlush called"; TEST_PLAN §S5d places it in a `runHook` unit test. |
| The read-trap (a Proxy recording property reads on the mapper) | TEST_PLAN §S5d unit test; this suite checks outputs only. H07, H08 and H10 catch a copied value, not a read. |
| `init --self-report` files, `--allow-self-report`, `--allow-tracked-config`, uninstall, `javi status`, `javi-mcp.mjs` launcher (decision 5) | File-level behaviour with no JGR output (TEST_PLAN §S5d process rows). |
| SDK-client interop, spawn of the built `javi.mjs mcp` | TEST_PLAN §S5d process rows; the process layer of this suite exercises the same stdio rules. |
| Pill text "Blocked · missing credentials · reported by agent" and its accessible name (decision 6 UI) | Component test (TEST_PLAN §S5d). |
| End to end hook → spool → ingest → reader | T6 end-to-end test. |
| `tools/list` before `notifications/initialized`; a valid JSON line that is neither object nor array (`42`); `params` that is not an object; a tool name that is not a string; a second `initialize` with a different version | Still unspecified (rest of G14). |
| A payload `tool_name` longer than 128 characters on javi's tool | "up to 128 characters" (G19) does not say whether a longer name is cut or dropped. |
| A collector heartbeat with a status other than `working` / `idle` after an agent status | In neither list of decision 6 (G18, "no change" in the QA spec gaps entry). |
| Gemini sub-agents | No `agent_id` field in the documented Gemini payloads (G13). |
| `/clear` in Claude Code, real CLI runs, Windows spawn, protocol versions clients actually send | Runtime, owner steps (ADR-0017 Verification; NOT RUN until then). |

## Ambiguities

### Spec gaps (G)

Raised by the first QA pass against ADR-0017 at `2d4dcc2`; resolved by the orchestrator in ADR-0017 Changes "QA spec gaps" and the amended decisions 1–3 and 6. Each row gives the resolution and the vectors that now encode it.

| Id | Question at `2d4dcc2` | Resolution (ADR-0017 amended) | Vectors |
|---|---|---|---|
| G1 | `server/discover` or an unknown method before `initialize`: -32600 or -32601? | -32601 before `initialize` too; only `tools/list` and `tools/call` get -32600 there. | M07, M08 |
| G2 | Missing required key, missing or non-object `arguments`: `isError` or -32602? | `isError` with the constant. | M17, M18 |
| G3 | Hooks not installed and invalid input; `tools/list` without hooks | Validation first, then the hooks check; `tools/list` independent of the hooks state. | M20 |
| G4 | Does the `isError` text name every allowed value? | No change. The vectors require every status (report_status) and every phase and kind (report_task); reasons are not required. | M17, M18, M20, M21 |
| G5 | TEST_PLAN L320 said invalid input keeps the normal tool event; ADR decision 3 said no record | TEST_PLAN fixed to match the ADR: no record at all. | H05, H09 |
| G6 | Clearing event without a status | The latest non-null status among events that are not agent statuses, source `collector`; null if none. | R16, R17 |
| G7 | Does a self-reported `task.*` clear an agent status? | Yes. | R18 |
| G8 | Agent status kept on `attention.requested` would hide a real permission prompt | `attention.requested` clears it: collector `waiting`, attention. | R02, R13 |
| G9 | `error_code` prefix different from the status | `statusReason` only when the prefix equals the status; otherwise null. | R09 |
| G10 | `reason: null` | A wrong type: `isError`. | M17 |
| G11 | Is hook mapping conditional on `--self-report`? | No. | All H vectors (fixed environment without `--self-report`) |
| G12 | Hook time from the clock or the Gemini payload `timestamp`? | javi's own clock. | H11 |
| G13 | Gemini sub-agents | No change: no documented `agent_id`; N/A. | — |
| G14 | `"id": null`; a second `initialize`; other malformed requests | `"id": null` → -32600 with `id: null`; a repeated `initialize` is answered like the first. The rest stays open ([Not covered](#not-covered)). | M22 |
| G18 | A collector heartbeat with another status after an agent status | No change; still open. | — |
| G19 | `attributes.tool_name` for a Gemini call matched on `mcp_context` | The payload's tool name as given, up to 128 characters. | H07 |

### Readings (Y)

Choices the suite makes where the text is clear in intent but needs an operational rule.

| Id | Reading |
|---|---|
| Y1 | A batch's `-32600` response carries `id: null`: an array has no id, and JSON-RPC 2.0 §5 requires `null` when the id cannot be determined. It is one response object, not an array. |
| Y2 | The declared `inputSchema` carries `additionalProperties: false`, exact `enum`s and `required`. ADR-0017's Research table says Gemini strips `additionalProperties`, which presumes the server declares it; strictness is still enforced by the server (M17, M18). |
| Y3 | **No delivery claim** (decision 2 "It never claims delivery"): the lower-cased success text MUST NOT match `\b(sent\|delivered\|delivering\|uploaded\|published\|synced\|synchronized\|live\|updated\|visible\|displayed\|shown)\b` and MUST NOT start with `not recorded`. Words such as "noted", "recorded", "javi's hooks record it for the dashboard" remain allowed. "live" also follows CLAUDE.md §3 ("Never call a connection live … until runtime evidence proves it"). |
| Y4 | A self-reported `task.*` carries no checked status (ADR-0017 is silent); H03 and H09 leave `status` unchecked. In H09 the record type follows the `phase`, not the failure hook (decision 3 Mapping is per input). |
| Y5 | Codex `PermissionRequest` for javi's tool may keep `tool_name` (optional `prefixOf` matcher, as the Codex suite's H09 allows); Claude Code and Gemini permission notifications carry no `tool_name`. |
| Y6 | Claude Code records may omit `attributes.platform` (ADR-0010 does not name it); when present it is `claude-code`. Codex and Gemini records MUST carry it (ADR-0016). |
| Y7 | R17: with no status at all the reader returns `status: null`, `statusSource: "collector"` (the amended "Otherwise" rule names `collector` as the source), `statusReason: null` and no attention. |

## Changes

- 2026-10-30 — Created for S5d T5 from ADR-0017 at `2d4dcc2` (QA lane, before any implementation).
- 2026-10-30 — Updated to ADR-0017 Changes "QA spec gaps": single outcomes for G1, G2 and G10 (M08, M17, M18); new cases for G3 (M20), G14 (new M22), G12 (H11), G19 (H07), G9 (R09), G6 (new R16, R17), G7 (new R18); G8 inverted (R02, R13); hook setup without `--self-report` (G11); schema allows a null reader `status`.
