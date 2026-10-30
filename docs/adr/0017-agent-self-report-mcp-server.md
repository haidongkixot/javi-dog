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
   - **Handshake.** It answers `initialize`. A known protocol version (2025-11-25, 2025-06-18, 2025-03-26) is echoed; any other gets `2025-11-25`.
   - **Methods.** It handles `ping`, `tools/list` and `tools/call`, and ignores notifications.
   - **Errors.** `server/discover` and any other method get `-32601`, which makes modern clients fall back to `initialize`. Malformed JSON gets `-32700`. A JSON array (batch) gets `-32600`.
   - **stdout purity.** stdout carries only newline-terminated JSON-RPC messages; logs go to stderr. `javi mcp` (JD-C01) connects it to stdin and stdout.
   - **Tests.** The official SDK *client* is used only as a dev dependency, to test interoperability.
   - **Spec tracking.** We follow spec changes ourselves (see Consequences).
2. **Two tools, fixed vocabularies** (JD-C02 `SELF_REPORT`, shared by the server and the hook mappers):
   - **`report_status`** `{ status, reason? }`:
     - `status` ∈ `working`, `waiting`, `blocked`, `idle`, `completed`, `failed`.
     - `reason` is allowed only with `waiting`, `blocked` or `failed`. It is one of `needs_input`, `needs_approval`, `missing_credentials`, `missing_access`, `tests_failing`, `ci_failing`, `rate_limited`, `dependency_down`, `conflicting_requirements` or `other`.
   - **`report_task`** `{ phase, kind }`:
     - `phase` ∈ `started`, `completed`, `failed`.
     - `kind` ∈ `plan`, `research`, `implement`, `test`, `debug`, `review`, `docs`, `build`, `deploy` or `other`.
   - **Strict arguments.** Unknown keys, wrong types, values outside the lists, or a `reason` with another status are rejected. The tool result has `isError: true` and a message that names the allowed values and never echoes the input.
   - **Annotations:** `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`. These are honest: the tool writes only to javi's local spool, and `javi` delivers it later to the user's own project. They also let Codex skip its approval prompt in Auto mode. Claude Code and Gemini still ask (decision 5).
   - **Instructions.** The `initialize` result carries short `instructions` (≤ 1 000 characters). They say when to call each tool: on a change of state, when blocked or waiting for the user, at task phase changes. They also say that only the listed values exist.
   - **Honest answer.** A successful `tools/call` says the report was noted and that javi's hooks record it for the dashboard. It does not claim delivery, because the server cannot see it.
3. **The hook emits the event (correlation), for all three CLIs.**
   - **Match.** The post-tool hook that already runs for every tool call maps a self-report only when the tool is javi's:
     - Claude Code and Codex: `tool_name` is exactly `mcp__javi__report_status` or `mcp__javi__report_task`.
     - Gemini: `mcp_context.server_name` = `javi` and `mcp_context.tool_name` ∈ {`report_status`, `report_task`}.
   - **Validation.** It validates `tool_input` with the same strict validator. Invalid input produces no self-report event; the normal tool event is unchanged.
   - **Mapping.**
     - `report_status` maps to `heartbeat` with `status`, plus `attributes.error_code` = `<status>.<reason>` (for example `blocked.missing_credentials`) when a reason is given.
     - `report_task` maps to `task.started`, `task.completed` or `task.failed` with `attributes.task_kind` = `kind`.
     - Both carry `attributes.tool_name` = the tool name as the agent saw it. That is their provenance (decision 6).
   - **Thread and ids.** The event uses the hook's own thread ref, agent ref and sequence, so it joins the session's thread for free, including after `/clear`. Its `event_id` is derived from (platform, session id, `tool_use_id`) where the payload has a call id (Claude Code, Codex). Gemini's `AfterTool` has none, so it gets a fresh ULID.
   - **The one exception.** This is the only place where a hook reads `tool_input`, and only for javi's own two tools. Every other tool's `tool_input` stays unread. A test passes a trap object that throws on any property read for other tools.
   - **Rejected alternatives.**
     - The server emits events itself (Codex `_meta.sessionId`): this would mean a second code path, and the server would need state and the token.
     - Ticket injection by a pre-tool hook rewriting arguments: more moving parts, and argument rewriting for MCP tools is unverified at runtime.
     - A separate thread per MCP process: two threads for one session.
4. **Reason in `error_code`.** No spec or server change: `error_code` and `task_kind` are already on the L0 allowlist. Spec §12 (informative collector mappings) documents the `<status>.<reason>` form in a Changes entry. A dedicated `status_reason` attribute is deferred to JGR v0.2.
5. **Opt-in registration; no permission pre-granted.**
   - **Where.** `javi init --self-report` (with any `--platform`) adds a server named `javi` to the platform's project file:
     - Claude Code: `.mcp.json` `mcpServers.javi`;
     - Gemini: `.gemini/settings.json` `mcpServers.javi`;
     - Codex: `.codex/config.toml` `[mcp_servers.javi]`, edited with smol-toml inside javi's marked block, as for the S5c `[otel]` block.
   - **Command.** `command` is the absolute Node path (`process.execPath`). `args` are `--no-warnings`, the stable `~/.javi/bin/<version>/javi.mjs`, and `mcp`. No `.cmd` shim is involved, so Windows needs no `cmd.exe` in between.
   - **No secret.** The entry holds no secret and no environment variables.
   - **Shared files.** These files are often committed and the entry holds a machine path. So `init` warns when git tracks the file (the S5c precedent) and never writes a file it cannot parse.
   - **Uninstall.** `javi uninstall` removes only javi's entry. Running `init` again does not duplicate it.
   - **Permissions.** No allow rules and no Gemini `trust: true` are written: the agent's CLI asks the user, who can choose "always allow".
   - **Requirements and status.** `--self-report` requires the platform's hooks, because the hook is the emitter, so `init --self-report` installs both. `javi status` reports whether self-report is registered.
   - **Rejected registration paths.**
     - `claude mcp add --scope local`: needs the `claude` binary on PATH and a subprocess; it keeps the path out of git.
     - Editing `~/.claude.json` directly: a large file Claude Code owns, with concurrent writers.
6. **The dashboard says who reported it.**
   - **Reader.** The JD-M12 thread reader returns `statusSource`: `agent` when the event that supplied the thread's current `status` has a `tool_name` from decision 3; otherwise `collector`.
   - **UI.** `ThreadStatusPill` (JD-M13) shows "reported by agent" next to an agent-reported status, in text and with an accessible name, not by colour alone.
   - **Unchanged.** Freshness and `stale` derivation stay as they are. A self-report is a signal like any other.

## Consequences

- Good:
  - an agent can say "blocked: missing credentials" or "now testing" without any free text leaving the machine;
  - no new runtime dependency (0 KB of SDK in `javi.mjs`);
  - one correlation path, built on the verified hook session id, for all three CLIs;
  - no ingest, schema or production change.
- Bad:
  - **Hooks are required.** Self-report works only while javi's hooks run: Codex hooks need the user's approval (S5c), and Gemini needs a trusted folder. If the hooks do not run, the tool still answers "noted", but nothing reaches the dashboard. `javi status` shows when hooks were last seen, and the ADR-0016 how-to covers approval.
  - **Spec tracking is ours.** We must follow MCP spec changes ourselves. If a client ever drops the `initialize` fallback, the server stops working there. The interop test with the pinned SDK client is the early warning; it is re-run whenever that dev dependency is upgraded.
  - **A reported state is the agent's claim.** Prompt injection could make an agent report `completed` falsely. Decision 6 labels the source, and the hook-derived events stay next to it.
  - **Name collisions.** Another MCP server the user names `javi` would have its tool calls mapped, but only values from the fixed lists pass. For Gemini, `mcp_context.command` and `args` could also be checked; that is deferred.
- Neutral:
  - `report_status` with `waiting` marks the thread as needing attention through the existing reader rule (`status = waiting`).

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
