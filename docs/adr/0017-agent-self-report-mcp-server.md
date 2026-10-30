# ADR-0017: Agent self-report through a local MCP server (`javi mcp`)

- Status: **Accepted** 2026-10-30. Owner answers:
  - "JD-C03 MCP server" as the next sprint (S5d).
  - "Hook emits" for correlation.
  - "Hand-written" server instead of the SDK.
  - "Reuse error_code" for the blocked reason.
  - "Opt-in, ask each time" for registration.
- Date: 2026-10-30
- Deciders: Project owner (Hai), Claude (orchestrator)
- Modules: JD-C03 (new, `@javis-dog/collector-mcp-server`, `collectors/mcp-server`); JD-C02 (self-report mapper); JD-C01 (`javi mcp`, `init --self-report`, hook wiring); JD-M12 and JD-M13 (status source on the dashboard); consumes JD-M01

## Context and problem statement

Hooks show what an agent **does**: tool calls, prompts, permission waits. They cannot show what the agent **thinks its state is**. Examples: "blocked: missing credentials", "waiting for the owner's decision", "now testing", "done". The roadmap's S5 lists JD-C03, an MCP server for agent self-report. The agent calls a tool, and the dashboard shows the reported state.

Constraints:

- **Privacy.** JGR L0 (spec §7) allows operational metadata only, from a fixed attribute allowlist. It allows no free text. A self-report can therefore carry only values from fixed lists.
- **One thread per session.** Hooks derive `thread_ref` = HMAC(per-installation salt, the CLI's session id) (ADR-0010). A self-report must land in that same thread, or the dashboard shows two threads for one session.
- **Live means verified** (CLAUDE.md §3). A state the agent reports about itself is a claim, not a measurement. The dashboard must say who reported it.

### Research (2026-10-30, primary sources)

Sources:

- upstream repositories cloned read-only: `modelcontextprotocol/modelcontextprotocol`, `modelcontextprotocol/typescript-sdk`, `google-gemini/gemini-cli` at `b633c07`, `openai/codex` at `55c099a`;
- npm metadata;
- code.claude.com docs;
- a static string scan of the Claude Code 2.1.312 binary.

`modelcontextprotocol.io` and `developers.openai.com` are blocked from the sandbox.

| Fact | Evidence |
|---|---|
| The current MCP spec is 2026-07-28: stateless, with `server/discover`. A client falls back to `initialize` when `server/discover` returns an error. | `docs/2026-07-28/learn/versioning.mdx:27`; `docs/2026-07-28/basic/transports/stdio.mdx:121-141` |
| stdio is newline-delimited JSON-RPC. stdout carries only MCP messages; stderr is for logs. | `docs/2025-11-25/basic/transports.mdx:28-33` |
| Gemini CLI (SDK 1.23.0) and Codex (legacy mode, the default) send protocol `2025-06-18`. Claude Code knows 2025-11-25, 2025-06-18 and 2025-03-26 plus a modern path. Which one it sends first is UNVERIFIED. | `codex-rs/rmcp-client/src/protocol_mode.rs`; binary strings |
| Gemini strips `$schema` and `additionalProperties` from tool schemas, so the server must validate arguments itself. | `gemini-cli docs/tools/mcp-server.md:707-713` |
| **Every client runs its post-tool hook for MCP tools, with the session id and the tool arguments.** | Claude Code `PostToolUse`: `tool_name` `mcp__<server>__<tool>`, `tool_input`, `tool_use_id` (code.claude.com hooks docs). Gemini `AfterTool`: `tool_name`, `tool_input`, `mcp_context.{server_name, tool_name}` (`packages/core/src/hooks/hookEventHandler.ts:100-119`, `hooks/types.ts:481-501`, `core/coreToolHookTriggers.ts:182`). Codex `PostToolUse`: `tool_name` `mcp__<server>__<tool>`, `tool_use_id`, `tool_input` (`codex-rs/core/src/tools/handlers/mcp.rs:526-544` and its test at `:777`). |
| Session ids inside the MCP process: Codex sends `_meta.sessionId` on `tools/call`. Claude Code sets `CLAUDE_CODE_SESSION_ID` at spawn, and the docs say it goes stale after `/clear`. Gemini passes none. | `codex-rs/core/src/mcp_tool_call.rs:552,1277`; code.claude.com env docs; `gemini-cli mcp-client.ts:2389-2430` |
| Registration: Claude Code reads the project's `.mcp.json` (approval prompt per project server). Gemini reads `.gemini/settings.json` `mcpServers` (stdio refused in untrusted folders). Codex reads `[mcp_servers.<name>]`; a project `.codex/config.toml` is loaded only for trusted projects. | Research report, Q3 |
| Codex auto-approves a call only when `readOnlyHint` is true, or when `destructiveHint` and `openWorldHint` are both false. | `codex-rs/core/src/mcp_tool_call.rs:2563` |
| SDK `@modelcontextprotocol/sdk` 1.32.2 (MIT, 2026-10-23): 17 runtime dependencies (express, ajv, zod, …). Measured minified esbuild bundle: 235–347 KB. Past advisories: none affect a stdio-only server today. | `npm view`; throwaway bundle in the scratchpad |
| The `instructions` returned by `initialize` reach the model in all three clients. | Research report, Q6 |

## Decision outcome

1. **A hand-written stdio server, no runtime dependency.** JD-C03 is a pure package with no I/O beyond the two streams it is given:
   - **Handshake.** `initialize` returns:
     - `protocolVersion`: a known version (2025-11-25, 2025-06-18, 2025-03-26) is echoed; any other gets `2025-11-25`;
     - `capabilities: { tools: { listChanged: false } }`, which Gemini requires (`gemini-cli tools/mcp-client.ts:1323`);
     - `serverInfo: { name: "javi", version }`;
     - `instructions`.
   - **Methods.** It handles `ping`, `tools/list` and `tools/call`.
   - **Message rules.**
     - A message without an `id` (a notification) never gets a response.
     - `id` is echoed exactly (string or number).
     - Any request other than `initialize` and `ping` that arrives before `initialize` gets `-32600`.
   - **Errors.**
     - `server/discover` and any other method get `-32601`, which makes modern clients fall back to `initialize`.
     - Malformed JSON gets `-32700` with `id: null`.
     - A JSON array (batch) gets `-32600`.
     - An unknown tool name gets `-32602`.
   - **stdout and stderr.**
     - stdout carries only newline-terminated JSON-RPC messages.
     - stderr carries only fixed strings: no method names, no request text, no parse excerpts. Clients copy a server's stderr into their own log files.
   - **Entry point.** `javi mcp` (JD-C01) connects the server to stdin and stdout.
   - **Tests.** The official SDK *client* is used only as a dev dependency, to test interoperability.
   - **Spec tracking.** We follow spec changes ourselves (see Consequences).
2. **Two tools, fixed vocabularies** (JD-C02 `SELF_REPORT`, shared by the server and the hook mappers):
   - **`report_status`** `{ status, reason? }`:
     - `status` ∈ `working`, `waiting`, `blocked`, `idle`, `completed`, `failed`.
     - `reason` is allowed only with `waiting`, `blocked` or `failed`. It is one of `needs_input`, `needs_approval`, `missing_credentials`, `missing_access`, `tests_failing`, `ci_failing`, `rate_limited`, `dependency_down`, `conflicting_requirements` or `other`.
   - **`report_task`** `{ phase, kind }`:
     - `phase` ∈ `started`, `completed`, `failed`.
     - `kind` ∈ `plan`, `research`, `implement`, `test`, `debug`, `review`, `docs`, `build`, `deploy` or `other`.
   - **Strict arguments.**
     - Unknown keys, wrong types, values outside the lists, or a `reason` with another status are rejected.
     - The tool result then has `isError: true`. Its text is a constant per tool that names the allowed values and never echoes the input.
   - **Annotations:** `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`. These are honest: the tool writes only to javi's local spool, and `javi` delivers it later to the user's own project. They also let Codex skip its approval prompt in Auto mode.
   - **Instructions.** The `initialize` result carries short `instructions` (≤ 1 000 characters):
     - call `report_status` only when the state really changes: blocked, waiting for the user, done, failed, or resuming work;
     - call `report_task` only at phase changes of a meaningful unit of work, never per tool call;
     - only the listed values exist.

     Each call may cost the user a permission prompt (decision 5).
   - **Honest answer.** `javi mcp --platform <p> --project <ref>` checks javi's local state.
     - When javi's hooks for that platform and project are installed, a valid call answers that the report was noted and that javi's hooks record it for the dashboard. It never claims delivery, because the server cannot see it.
     - When they are not installed, the call answers `isError` with a constant "not recorded: javi hooks are not installed for this project".
3. **The hook emits the event (correlation), for all three CLIs.**
   - **Match.** The post-tool hook that already runs for every tool call maps a self-report only when the tool is javi's:
     - Claude Code and Codex: `tool_name` is exactly `mcp__javi__report_status` or `mcp__javi__report_task`.
     - Gemini: `mcp_context.server_name` = `javi` and `mcp_context.tool_name` ∈ {`report_status`, `report_task`}. Gemini's `tool_name` is `mcp_javi_<tool>` (`mcp-tool.ts:725-731`). `server_name` is the raw config key, so `javi_x` cannot match.
   - **Only one record per hook call.** For javi's own tools, the hook emits only the self-report record, or nothing when the input is invalid. It emits no generic tool event: the call is the report, so `tasksCompleted` is not inflated (review L2), and no hook ever produces two records (review M5). Every other tool maps exactly as before.
   - **Pre-tool hooks stay silent for javi's tools.** Claude Code and Codex `PreToolUse` and Gemini `BeforeTool`, which carries `mcp_context` too (`hookEventHandler.ts` `fireBeforeToolEvent`), emit nothing for javi's two tools. They match the same way. So no `task.started` is left without a matching end. Permission prompts for these tools still map to `attention.requested` as before, because that wait is real.
   - **Validation.** It validates `tool_input` with the same strict validator as the server. Only the tool name, `tool_input`, `mcp_context.server_name` and `mcp_context.tool_name` are read. `tool_response` and the rest of `mcp_context` are never read.
   - **Mapping.**
     - `report_status` maps to `heartbeat` with `status`, plus `attributes.error_code` = `<status>.<reason>` (for example `blocked.missing_credentials`) when a reason is given.
     - `report_task` maps to `task.started`, `task.completed` or `task.failed` with `attributes.task_kind` = `kind`.
     - Both carry `attributes.tool_name` = the tool name as the agent saw it. That is their provenance (decision 6).
   - **Sub-agents.** When the hook payload carries an `agent_id` (a sub-agent), `report_task` is kept with its `agent_ref`, but `report_status` produces no record. A sub-agent must not set the whole thread's status (review M6).
   - **Thread, sequence and ids.**
     - The record uses the hook's own thread ref, agent ref and sequence, so it joins the session's thread for free, including after `/clear`.
     - Its `event_id` is a ULID: the time part is the hook time; the 80 random bits come from HMAC(salt, platform ‖ session id ‖ call id), where the payload has a call id (Claude Code `tool_use_id`, Codex `tool_use_id`). Gemini's `AfterTool` has no call id, so it gets a fresh ULID.
     - This keeps the spool's time order (review M5) and dedupes a re-run hook. No raw id leaves the machine.
   - **Prompt delivery.** These records are flushed at once, like the existing urgent events (review H2):
     - a self-reported status other than `working`;
     - a self-reported `task.failed`;
     - the end-of-turn `heartbeat idle` (Claude Code and Codex `Stop`, Gemini `AfterAgent`).
   - **The one exception.** This is the only place where a hook reads `tool_input`, and only for javi's own two tools. Every other tool's `tool_input` stays unread. A test passes a Proxy that records every property read, asserted on the mapper itself; the hook runner's catch-all would hide a throw.
   - **Divergence on failed calls** (review L5). Codex runs `PostToolUse` only after a successful call (`codex-rs/core/src/tools/registry.rs:977-983`); Gemini runs `AfterTool` even after an error. So with the server down, Gemini still records a valid report and Codex does not. Whether Claude Code fires `PostToolUse` or `PostToolUseFailure` for an `isError` result is UNVERIFIED; javi maps the self-report from both.
   - **Rejected alternatives.**
     - The server emits events itself (Codex `_meta.sessionId`): this would mean a second code path, and the server would need state and the token.
     - Ticket injection by a pre-tool hook rewriting arguments: more moving parts, and argument rewriting for MCP tools is unverified at runtime.
     - A separate thread per MCP process: two threads for one session.
4. **Reason in `error_code`.**
   - **No spec or server change.** `error_code` and `task_kind` are already on the L0 allowlist, and no consumer reads `error_code` today (review L4).
   - **Spec note.** Spec §4 ties `error_code` to the `error` type, and §12 says "`tool_name` only" for post-tool events. A Changes entry in §12 (informative collector mappings) documents both self-report uses.
   - **Deferred.** A dedicated `status_reason` attribute is deferred to JGR v0.2.
5. **Opt-in registration.**
   - **Where.** `javi init --self-report` (with any `--platform`) adds a server named `javi` to the platform's project file:
     - Claude Code: `.mcp.json` `mcpServers.javi`;
     - Gemini: `.gemini/settings.json` `mcpServers.javi`;
     - Codex: the project's `.codex/config.toml` `[mcp_servers.javi]`, edited with smol-toml inside a javi marker block. `mcp_servers` is not on Codex's project-local denylist (`codex-rs/config/src/loader/mod.rs:90-103`), so Codex reads it in trusted projects. (`otel` is on that list, which is why S5c edits `$CODEX_HOME/config.toml` instead.)
   - **Command and arguments.**
     - `command` is the absolute Node path (`process.execPath`).
     - `args` are `--no-warnings`, a stable **unversioned** `~/.javi/bin/javi-mcp.mjs`, then `--platform <p>` and `--project <ref>`. `init` rewrites that file to load the installed version, so an upgrade never changes the registered command; this is the S5c launcher lesson (`codex-hooks.ts:12-17`).
     - No `.cmd` shim is involved. If Node moves (for example after a version-manager switch), `javi init` must be run again; `javi status` reports a missing Node path.
   - **No secret.** The entry holds no secret and no environment variables.
   - **Shared files.**
     - **Git-tracked files are refused.** These files are often committed, and the entry holds machine paths that would break teammates. So `init --self-report` refuses to edit a git-tracked registration file unless the user passes `--allow-tracked-config` (review M7).
     - **Unparsable files are refused.** `init` never writes a file it cannot parse.
   - **Idempotent and reversible.**
     - Running `init` again does not duplicate the entry.
     - `javi uninstall` removes javi's MCP entry first, then the hooks, and leaves everything else as it was.
   - **Permissions (owner, 2026-10-30).**
     - **Default.** No allow rule and no Gemini `trust` are written: the agent's CLI asks the user each time, and the user can choose "always allow".
     - **Opt-in pre-approval.** `--allow-self-report` adds a narrow allowance for exactly javi's two tools:
       - Claude Code: the entries `mcp__javi__report_status` and `mcp__javi__report_task` in `permissions.allow` in `.claude/settings.local.json`. javi already writes that file, and javi's state records which entries it added.
       - Gemini: `trust: true` and `includeTools: ["report_status", "report_task"]` on the `javi` server entry only.
       - Codex: nothing to write; the annotations already apply.

       `javi uninstall` removes exactly what javi added.
   - **Requirements and status.** `--self-report` requires the platform's hooks, because the hook is the emitter, so `init --self-report` installs both. `javi status` reports whether self-report is registered and whether it is pre-approved.
   - **Rejected registration paths.**
     - `claude mcp add --scope local`: needs the `claude` binary on PATH and a subprocess; it keeps the path out of git.
     - Editing `~/.claude.json` directly: a large file Claude Code owns, with concurrent writers.
6. **The dashboard shows the agent's report, says who reported it, and keeps it until real activity.**
   - **Agent status.** An agent status is the latest self-reported status in a thread: a `heartbeat` that carries a `tool_name`. No collector heartbeat has a `tool_name` (review L1).
   - **Precedence** (review H1).
     - **What clears it.** The agent status stays the thread's status until a later piece of collector activity:
       - `task.*`;
       - `session.*`;
       - `agent.*`;
       - a `heartbeat` with status `working` and no `tool_name` (Claude Code and Codex `UserPromptSubmit`, Gemini `BeforeAgent`).
     - **What does not clear it.** A later collector `heartbeat idle` (end of turn), `attention.requested`, `usage.reported` or `error`.
     - **Otherwise.** The existing rule applies: the latest non-null `status`.
     - **Ordering.** The reader's existing order is used (`received_at`, then `sequence`, then row id).
   - **Reader** (JD-M12). The thread reader returns:
     - `statusSource`: `agent` or `collector`;
     - `statusReason`: the reason from `<status>.<reason>` in `error_code`, accepted only when it is in the `SELF_REPORT` list (review M2).

     No migration is needed: these are aggregates over existing columns.
   - **Attention (owner, 2026-10-30).** A thread needs attention when its status is `waiting`, as today, or when its status is `blocked` with source `agent` (review M1).
   - **UI** (JD-M13). Wherever a status pill appears, the pill shows the reason in words and "reported by agent", as text with an accessible name, never by colour alone. Example: "Blocked · missing credentials · reported by agent". That includes the activity feed (`overview-view.tsx:175`).
   - **Unchanged.** Freshness and `stale` derivation stay as they are.

## Consequences

- Good:
  - an agent can say "blocked: missing credentials" or "now testing" without any free text leaving the machine;
  - no new runtime dependency (0 KB of SDK in `javi.mjs`);
  - one correlation path, built on the verified hook session id, for all three CLIs;
  - no ingest, schema or production change.
- Bad:
  - **Hooks are required.** Self-report works only while javi's hooks run: Codex hooks need the user's approval (S5c), and Gemini needs a trusted folder. If the hooks are installed but do not run (for example, not yet approved), the tool answers "noted", but nothing reaches the dashboard. `javi status` shows when hooks were last seen, and the ADR-0016 how-to covers approval.
  - **Spec tracking is ours.** We must follow MCP spec changes ourselves. If a client ever drops the `initialize` fallback, the server stops working there. The interop test with the pinned SDK client is the early warning; it is re-run whenever that dev dependency is upgraded.
  - **A reported state is the agent's claim.** Prompt injection could make an agent report `completed` falsely. Decision 6 labels the source, and the hook-derived events stay next to it.
  - **Name collisions.** Another MCP server the user names `javi` would have its tool calls mapped, but only values from the fixed lists pass. For Gemini, `mcp_context.command` and `args` could also be checked; that is deferred.
  - **Permission prompts** (review M3). Without `--allow-self-report`, Claude Code and Gemini ask before each call. An unattended agent stops at that prompt, and the prompt itself shows on the dashboard as "waiting". The instructions keep calls to real state changes.
- Neutral:
  - A self-reported `waiting` or `blocked` marks the thread as needing attention, and so does a stale one, as for `waiting` today.

## Verification (TEST_PLAN §S5d)

- Conformance vectors written from this ADR by QA. They cover MCP request → response, and hook payload → events, for all three CLIs.
- An SDK-client interop test against the built `javi.mjs mcp`.
- A trap test proving no other tool's `tool_input` is read.
- An install round trip with git-tracked warnings.
- A reader and pill test for `statusSource`.
- An end-to-end run: hook → spool → ingest (PGlite) → reader shows `blocked`, "reported by agent".
- Real CLI runs are owner steps, added to `docs/how-to/run-first-real-sessions.md` (NOT RUN until then).

## Changes

- 2026-10-30 — Created (S5d discovery and owner decisions).
- 2026-10-30 — Design review D0, before any code. Findings and their fixes:

  | Finding | Problem | Fix |
  |---|---|---|
  | H1 | The end-of-turn `heartbeat idle` overwrote every self-reported status | Precedence rule, decision 6 |
  | H2 | Self-reports waited in the spool | Urgent flush, decision 3 |
  | M1 | Self-reported `blocked` did not count as attention | Now counts (owner) |
  | M2 | The reason was not shown | `statusReason` |
  | M3 | Every call could raise a permission prompt | Opt-in `--allow-self-report` (owner) |
  | M4 | The `initialize` shape and JSON-RPC rules were unspecified | Now specified |
  | M5 | One hook produced two records, and ids broke spool order | One record per hook, HMAC-seeded ULID |
  | M6 | A sub-agent could set the thread's status | Sub-agent status reports dropped |
  | M7 | Versioned path, tracked files, `[otel]` precedent | Unversioned `javi-mcp.mjs`; tracked files refused; precedent wording fixed |
  | L1 | `statusSource` matched on tool names | Structural match |
  | L2 | Each report counted as two tasks | Fixed by M5 |
  | L3 | Text could leak through stderr and `isError` | Fixed strings only |
  | L4 | `error_code` reuse | Spec note |
  | L5 | CLIs diverge on failed calls | Documented |
