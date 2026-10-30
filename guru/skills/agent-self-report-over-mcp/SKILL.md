---
name: agent-self-report-over-mcp
description: Let AI coding agents report their own state ("blocked — missing credentials", "now testing", "done") through a small local MCP server, and record it in the same session thread as the agent's measured activity — without free text, without a runtime SDK dependency, and without letting the claim hide real signals. Covers deciding between the official SDK and a hand-written stdio server (bundle size, dependency count, spec tracking; the SDK client as a pinned dev-only interop oracle), JSON-RPC and stdout/stderr rules several clients need, fixed-vocabulary tools validated by the server itself, honest tool annotations and answers that never claim delivery, correlating reports to sessions through the host's post-tool hooks when the host gives session ids only to hooks, one record per hook call and silent pre-tool hooks, sub-agents that cannot set the session's status, idempotency for re-fired hooks when the event id embeds a clock, proving the hook never reads other tools' arguments, and opt-in registration in project config files. Use when building an MCP server for agent status, progress, heartbeat or task reporting; when correlating MCP tool calls with hook or telemetry sessions in Claude Code, Codex CLI, Gemini CLI or similar hosts; when an agent's self-report must appear on a dashboard; when choosing between an MCP SDK and a hand-written server; or when asked for "agent self-report", "report_status tool", "MCP status server" or "let the agent tell us it is blocked".
metadata:
  version: "0.1.0"
  origin: "javis-dog ad-hoc-self-report (S5d)"
  confidence: "medium (design reviewed before code, 54 independent vectors with 71 of 74 mutations caught, SDK-client interop test, end-to-end hook → spool → ingest → reader on an embedded database, code review with reproductions on the built bundle: one iteration); low (behaviour with real host CLIs: NOT RUN; which protocol version one client sends first and which failure hook it fires: UNVERIFIED)"
---

# Agent self-report over MCP

Hooks and telemetry show what an agent **does**: tool calls, prompts, permission waits, tokens. They cannot show what the agent **thinks its state is** — "blocked: missing credentials", "waiting for your decision", "testing now". An MCP tool the agent can call fills that gap. It also opens three risks: free text leaving the machine, a second, uncorrelated "session" on the dashboard, and an agent's claim overriding what was measured.

The rule: **fixed vocabularies only; correlate through the channel that already carries the session id; record exactly one event per call; label it as the agent's claim and let measured evidence win where they conflict.**

## Forces

- **Expressiveness vs. privacy.** A `message` field is the most useful and the one that carries prompts, code and secrets.
- **Second process vs. one thread.** The MCP server is a separate process the host spawns; it may not know which session called it.
- **SDK vs. hand-written.** The SDK tracks the spec for you and brings its runtime dependencies into your bundle; a hand-written server is small and makes spec tracking your job.
- **Claim vs. measurement.** "Working" from the agent and a permission prompt from the host can both be true reports of different things; the UI must not let one hide the other.

## 1. Decide what the agent may say

Two tools are enough in most designs:

- `report_status { status, reason? }` — status from a closed list (`working`, `waiting`, `blocked`, `idle`, `completed`, `failed`); `reason` from a closed list, allowed only with `waiting`, `blocked` or `failed` (`needs_input`, `needs_approval`, `missing_credentials`, `missing_access`, `tests_failing`, `ci_failing`, `rate_limited`, `dependency_down`, `conflicting_requirements`, `other`).
- `report_task { phase, kind }` — `started` / `completed` / `failed` × a closed list of work kinds (`plan`, `research`, `implement`, `test`, `debug`, `review`, `docs`, `build`, `deploy`, `other`).

Carry the values in fields your event protocol already allows (in the origin: the reason as `<status>.<reason>` in an existing error-code attribute, documented as a spec note) rather than adding a free-text field. Keep one shared, frozen vocabulary module that the server, the hook mapper and the reader all import, and test that the reader's list equals it.

**Instructions** returned at `initialize` (short): call only when the state really changes; report tasks at phase changes of meaningful work, never per tool call; only the listed values exist. Each call may cost the user a permission prompt.

## 2. Build the server small, test it against the real client

Measure before choosing: in the origin the official SDK had 17 runtime dependencies and bundled to 235–347 KB minified, for a server that needs three methods. The owner chose a hand-written stdio server with no runtime dependency, and the official SDK **client** as a pinned dev dependency for an interoperability test against the built process.

Protocol rules that real clients need — version negotiation, `-32601` for discovery methods so modern clients fall back to `initialize`, notifications never answered, ids echoed with their type, stdout for protocol only, fixed-string stderr — are in [`references/stdio-mcp-checklist.md`](references/stdio-mcp-checklist.md).

Tool-level rules:

- The server validates arguments itself; some clients strip `additionalProperties` from the schema.
- Invalid input → `isError: true` with a constant text naming the allowed values; never echo input.
- **Honest answers.** The server cannot see delivery: answer "noted; the hooks record it", never "sent". When the recording path is not installed for this project, answer `isError` "not recorded: hooks are not installed".
- **Honest annotations.** `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false` for a tool that writes only to a local spool. At least one client auto-approves calls from these hints, so a wrong hint is a permission decision made for the user.

## 3. Correlate through the hook, not the server

Research, per host, **which channel carries the session id**. In the origin (primary sources, three hosts): every host ran its post-tool hook for MCP tools with the session id and the tool arguments; only one passed a session id to the MCP server; one exposed it as an environment variable that goes stale when the user clears the conversation; one passed none. So the existing hook emits the event, and the server only validates and answers.

Hook rules:

- **Exact, structural match** of your tools: the full namespaced tool name (`mcp__<server>__<tool>`), or the host's structured server/tool fields where the flat name is ambiguous. Look-alike names (`<server>_x`, prefixes, other cases) are ordinary tools.
- **One record per call.** For your tools emit only the self-report (or nothing for invalid input), never the generic tool event too — otherwise every report also counts as a completed task.
- **Pre-tool hooks stay silent** for your tools, or the session shows a `task.started` without an end. Permission prompts for your tools still map as before: that wait is real.
- **Mapping does not depend on registration state**, and the event time is your hook's clock, never a time from the payload.
- **Read only what you need.** For your tools: the tool name, the arguments and the server/tool identity fields. Never the tool response, never any other tool's arguments. Prove it with a recording `Proxy` passed to the mapper itself (a wrapper with a catch-all would swallow the throw).
- **Sub-agents** may report task phases (kept with their agent ref) but not the session's status.
- **Deliver state changes promptly.** A report of `blocked` that waits in a batch spool until the next interval is late exactly when it matters; flush non-`working` statuses, failed tasks and the end-of-turn idle at once.
- **Document host divergence on failed calls** (one host fires its post-tool hook only after success, another also after errors).

## 4. Make re-fired hooks idempotent — and test it with a moving clock

If the event id is derived from (platform, session id, call id), a re-run hook produces the same id and the receiver's dedupe drops it. If you put the hook time into the id (a ULID whose time part keeps the spool ordered), **a re-run a few milliseconds later gets a new id** and is recorded twice. Then:

- keep a small local **seen-call marker**: keyed HMACs of (platform, session id, call id), newest N kept, atomic write under a lock, a corrupt file counts as empty, no raw ids on disk;
- if the marker cannot be read or written, **record anyway** — a duplicate is recoverable, a lost report is not;
- hosts without a call id get a fresh id each time; say so.

Test idempotency by running the same call twice **with the clock advanced between runs**. In the origin, the unit test and the conformance vectors both pinned one clock for both runs, so the duplicate was invisible to them; a code reviewer found it on the built bundle.

## 5. Show the claim as a claim

The reader exposes `statusSource` (`agent` | `collector`) and `statusReason` (only from the closed list, only when its prefix equals the status). The UI says it in words: "Blocked · missing credentials · reported by agent". The precedence between the agent's claim and measured signals — what clears a claim, what does not, and why a real permission prompt must win — is in `truthful-live-status` §9. An agent under prompt injection can claim `completed`; the label and the measured events next to it are the defence.

## 6. Register opt-in, per project

- Only on an explicit flag (`init --self-report`), in each host's project registration file; the recording hooks are installed with it, because they are the emitter.
- Register the absolute runtime path and a stable, **unversioned** launcher, so upgrades never change the registered command.
- No secrets and no environment variables in the entry.
- Pre-approval of your tools is a separate opt-in that allows exactly your tools and nothing else; uninstall removes exactly what you added.
- Project registration files are often committed: refuse git-tracked files unless overridden, with a check that fails closed; refuse unparsable files; exclude a file you created from git; keep the user's bytes on uninstall. Details: `local-companion-process-hardening` §7 and `fail-closed-checks`.

## 7. Test plan by layer

| Claim | Cheapest reliable layer |
|---|---|
| Vocabulary and validation, nothing echoed | Unit (validator table, sentinel strings) |
| Protocol rules | Unit over in-memory streams; independent request → response vectors |
| stdout purity, interop | Process: spawn the built entry point; official SDK client (dev dependency) |
| Hook mapping for each host, one record per call, silent pre-tool, sub-agents | Unit (mappers) + vectors through real hook processes |
| No other tool's arguments read | Unit with a property-read recorder |
| Re-fired hook recorded once | Process, clock advanced between runs |
| Claim precedence, source and reason | Reader on an embedded database + vectors; mutation per clearing rule |
| End to end | hook → spool → flush → real ingest handler → reader |
| Real host clients (versions, approval prompts, Windows spawn) | Runtime, by the owner — NOT RUN until then |

## Pitfalls

- **A free-text field "just for the reason".** It becomes the prompt-leak channel.
- **The server emitting events itself** with whatever session hint it gets: a second code path, state and a token in the server, and a thread per process.
- **Matching tools by prefix** or by a flat name the host builds differently.
- **Two records per call** (the self-report and the generic tool event).
- **"Sent" in the success text.**
- **Idempotency tested under a frozen clock.**
- **Precedence that lets the agent's "working" hide a real permission prompt.**

## Evidence from origin project

Javi's Dog S5d (2026-10-30): local MCP server for agent self-report next to hook collectors for Claude Code, Gemini CLI and Codex CLI. Decision record ADR-0017; sprint record `docs/sprints/SPRINT-05d.md`; vectors `docs/jgr/conformance/self-report/`. Confidence **medium** for the design (one iteration, five independent checks); **low** for real-client behaviour.

- Research (ADR-0017 "Research"): upstream repositories cloned read-only (`gemini-cli` at `b633c07`, `codex` at `55c099a`, the MCP spec and TypeScript SDK), a static string scan of one closed-source client binary. Post-tool hooks fire for MCP tools in all three hosts (cited file and line per host); session id in the server: one host via `_meta.sessionId`, one via an environment variable documented to go stale after `/clear`, one none. The orchestrator re-checked hook firing in two hosts' sources, which "led to a uniform 'hook emits' design" (`SPRINT-05d.md` Team log). One client strips `additionalProperties` from tool schemas (docs line cited); one auto-approves from annotations (source line cited).
- SDK measurement: 17 runtime dependencies, 235–347 KB minified bundle (throwaway bundle; ADR-0017). Owner: "Hand-written". Interop test with SDK client 1.32.2 as a dev dependency of the server package only (`d1ebc8b`).
- Design review before code: 2 high (end-of-turn idle overwrote every self-report; reports waited in the spool), 7 medium (incl. two records per hook, sub-agents setting status), 5 low; the orchestrator also found unmatched `task.started` from pre-tool hooks (ADR-0017 *Changes* D0; `2d4dcc2`).
- Vectors: 54 (22 protocol, 14 hook, 18 reader) from the decision record only; 19 spec gaps resolved in the record (`c25cf2d`, `781c561`). Runners: protocol 22/22, reader 18/18, hook 14/14 through real hook processes; mutations 51/54 and 20/20 caught; survivors logged as coverage gaps (`a78066b`, `08a33bc`; `SPRINT-05d.md` T5). End-to-end hook → spool → ingest on PGlite → reader for two hosts (`08a33bc`).
- Proxy read recorder on the mapper: "a Proxy read recorder proving only the match fields are read for other tools and `tool_response` / other `mcp_context` fields never are for javi's tools" (`1600c47`).
- Re-fire duplicate: code review M1 — "the event id's time part is the wall clock"; pre-fix test `now: () => CLOCK` for both runs, vectors H11/H12 "the same salt and clock"; fix `d6c989b` seen-call marker (512 keys, HMAC, lock, atomic write, corrupt = empty; "a duplicate is better"), test advances the clock by 50 ms. The D0 remedy for spool order (M5) had put the clock into the id while the record still said "dedupes a re-run hook" (ADR-0017 at `2d4dcc2`, l. 105–106).
- Not verified: real CLI runs (how-to step 6, owner); which protocol version Claude Code sends first; whether Claude Code fires `PostToolUse` or `PostToolUseFailure` for an `isError` result (both are mapped); behaviour on Windows.
