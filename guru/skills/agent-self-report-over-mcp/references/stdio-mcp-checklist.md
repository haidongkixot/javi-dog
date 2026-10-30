# Hand-written stdio MCP server — protocol checklist

Rules a minimal, dependency-free stdio MCP server needs so that several real clients (with different protocol versions) can use it. Each line became a request → exact-response vector in the origin's conformance suite. Re-check against the MCP specification version you target; the origin read the spec repository at its 2025-11-25 and 2026-07-28 revisions.

## Transport

- [ ] Newline-delimited JSON-RPC 2.0 on stdin/stdout; each response is one line ending in `\n`.
- [ ] **stdout carries only protocol messages.** No banners, no logs, no runtime warnings (start the runtime with warnings off, for example `node --no-warnings`). A test spawns the built entry point and parses every stdout line as JSON-RPC.
- [ ] **stderr carries only fixed strings** — no method names, request text, parse excerpts, stack traces or paths. Clients copy server stderr into their own log files. Cap the number of stderr lines per run.
- [ ] The launcher that clients register prints one fixed line and exits non-zero when the real program is missing (no stack trace).

## Lifecycle and versions

- [ ] `initialize` returns `protocolVersion`, `capabilities`, `serverInfo` and (optionally) `instructions`.
- [ ] Version negotiation: echo a version you implement; for any other requested version answer your newest implemented version (never echo an unknown one, never claim a newer one).
- [ ] `capabilities.tools` present (at least one client in the origin required it; `{ "listChanged": false }`).
- [ ] A repeated `initialize` is answered like the first.
- [ ] Newer discovery methods you do not implement (the origin: `server/discover` from the stateless 2026 revision) get `-32601` **before and after** `initialize`; clients then fall back to `initialize`.
- [ ] Requests other than `initialize` and `ping` that arrive before `initialize` get `-32600` (only for methods you know); unknown methods get `-32601` at any time.

## Message rules

- [ ] A notification (no `id`) never gets a response — not even an error.
- [ ] `id` is echoed exactly, with its JSON type (string stays string, number stays number).
- [ ] `"id": null` → `-32600` with `id: null`.
- [ ] Malformed JSON → `-32700` with `id: null`.
- [ ] A JSON array (batch) → `-32600`; elements are not processed.
- [ ] A JSON-RPC **response** object sent by the client (`result` or `error` with an `id`) is ignored.
- [ ] Unknown tool name in `tools/call` → `-32602`.

## Tools

- [ ] Input schemas use `additionalProperties: false` and enums, **and the server validates arguments itself** — at least one client strips `$schema` and `additionalProperties` before showing schemas to the model.
- [ ] Missing or non-object `arguments`, unknown keys, wrong types (including `null` for an optional key), values outside the lists, and cross-field rule violations → a tool result with `isError: true`, not a protocol error.
- [ ] Validation runs before any state check (for example "is the recording path installed?"); `tools/list` never depends on that state.
- [ ] The `isError` text is a constant per tool that names the allowed values and never echoes the input or a key name.
- [ ] Success text never claims delivery the server cannot see ("noted", not "sent").
- [ ] Annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) are true statements about what the tool does; some clients auto-approve from them.
- [ ] `instructions` stay short (the origin capped them at 1 000 characters) and say when *not* to call.

## Tests that guard the checklist

- Unit tests over in-memory streams: request → exact response, notifications → no output (use a `ping` after the notification as a barrier to prove "nothing was written").
- Sentinel strings planted in every request field must not appear in stdout, stderr or `isError` text.
- Interoperability: the official SDK **client**, pinned as a dev dependency only, connects to the built server process, lists tools and calls them valid and invalid. Re-run when that pin moves; it is the early warning that a client dropped a fallback you rely on.
- Mutation checks: echo any version; answer a notification; serve `tools/list` before `initialize`; echo the input in `isError` — each must fail its vectors.
