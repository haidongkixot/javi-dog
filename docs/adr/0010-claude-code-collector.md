# ADR-0010: Claude Code collector — command hooks, local mapping, detached delivery

- Status: **Accepted** 2026-10-23 (owner asked for "javi init, hooks to JGR"; mapping follows spec §12)
- Date: 2026-10-23
- Deciders: Project owner (Hai), Claude (implementer)
- Modules: JD-C01 (new), JD-M02; consumes JD-M01

## Context and problem statement

The first real producer: Claude Code. Facts verified on 2026-10-23 against `code.claude.com/docs/en/hooks` and `/settings` (via a docs agent plus a direct fetch): hook input arrives as JSON on stdin with `session_id`, `transcript_path`, `cwd`, `hook_event_name`, and event fields such as `tool_name`, `tool_input`, `tool_response`, `prompt`, `notification_type`, `agent_id`, `duration_ms`. Several of these carry **content** (prompt, tool input/response, assistant message, error text, transcript path). Hooks can run `async: true` (non-blocking); exec form (`command` + `args`) spawns without a shell on every platform; on Windows shell form runs in Git Bash or PowerShell. Plain stdout of `SessionStart`/`UserPromptSubmit` is added to Claude's context; exit 2 blocks several events. `.claude/settings.local.json` is only auto-git-ignored when Claude Code itself created it.

## Considered options

1. **Command hooks → local `javi hook` maps to JGR → file spool → detached `javi flush`.**
2. HTTP hooks posting raw hook JSON to Javi's Dog (the server would strip content).
3. OpenTelemetry export only (`claude_code.*` metrics/events).

## Decision outcome

**Option 1.** Option 2 sends prompts and tool inputs over the network before anything strips them — it contradicts *privacy by minimization*. Option 3 gives token usage but not lifecycle/attention signals; it is added later for `usage_delta` (follow-up below).

- **Mapping (allowlist, spec §12):** SessionStart → `session.started` (working) · SessionEnd → `session.ended` (completed) · UserPromptSubmit → `heartbeat` working (prompt never read) · Pre/PostToolUse/PostToolUseFailure → `task.started/completed/failed` with `tool_name` (+ `duration_ms`) · Notification `permission_prompt|idle_prompt|elicitation_dialog|agent_needs_input` → `attention.requested` (waiting) · SubagentStart/Stop → `agent.started/stopped` · Stop → `heartbeat` idle. `thread_ref`/`agent_ref` = HMAC-SHA-256 of `session_id`/`agent_id` with a per-installation salt. Nothing else from the hook input is copied.
- **Hook registration:** `javi init` writes exec-form hooks (`command` = absolute node path, `args` = CLI path + `hook --project <slug> --source javi-collector`) into the project's `.claude/settings.local.json`, merged with existing settings; `async: true` everywhere except SessionEnd (synchronous, 5 s, because async hooks may be cancelled at teardown). The file is added to `.git/info/exclude` when not already ignored. `javi uninstall` removes only entries carrying the marker.
- **Neutral hooks:** `javi hook` prints nothing and exits 0 in every case (bad input, unknown project, errors).
- **Secrets and state:** the ingest token is read from `JAVI_INGEST_TOKEN` or stdin (never argv) and stored in `~/.javi/credentials.json` (0600), never in the repository. `~/.javi` also holds the installation (`producer_id`, salt), per-thread sequence counters (directory locks, so concurrent hook processes never reuse a number), the per-project spool and the last flush result.
- **Delivery:** recording is local; a hook starts a detached `javi flush` for urgent events (attention, session start/end), a backlog ≥ 25, or when the last flush is older than 30 s, debounced to one spawn per 3 s (urgent events bypass the debounce). One flusher per project (lock); a busy flusher retries once after 1 s. JD-M02 gains a per-request timeout (10 s).
- **Verification:** `javi init` sends one `x.javi.collector.installed` event and reports whether the receiver accepted it.

## Consequences

- Positive: no content leaves the machine; Claude Code is never slowed down or influenced by the collector; works on Windows without shell quoting concerns; offline work is spooled.
- Negative: the hook command points at this repository checkout (no packaged `npx javi` yet); each hook starts a Node process (async, so off the critical path); `-p` (non-interactive) runs may cancel async hooks at teardown; no token usage yet.
- Follow-up (S3d): OTel `claude_code.token.usage` / `cost.usage` → `usage.reported` through a local OTLP receiver in the collector or the server-side OTLP receiver; package the CLI for `npx`; Guru G2.
