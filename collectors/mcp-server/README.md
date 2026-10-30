# JD-C03 · `@javis-dog/collector-mcp-server` — javi's MCP server for agent self-report

Status: **in-progress** (S5d). A hand-written stdio MCP server that lets a coding agent report its own state with two tools, `report_status` and `report_task`. It records nothing itself: javi's post-tool hooks (JD-C01, via JD-C02 `selfReportRecord`) turn each call into a JGR event. Decision: [ADR-0017](../../docs/adr/0017-agent-self-report-mcp-server.md).

No runtime dependency beyond JD-C02 and no `process` globals in the core: `javi mcp` (JD-C01) connects it to stdin, stdout and stderr.

| Export | Contract |
|---|---|
| `createMcpServer({ version, hooksInstalled, write, log })` | `{ handleLine(line): Promise<void>, rejectLine(): void }`. `write` gets one serialized JSON-RPC message ending in `\n`; `log` gets one string from `MCP_LOG_MESSAGES`; `hooksInstalled()` (sync or async, a throw counts as `false`) decides the honest answer |
| `serveStdio(stdin, stdout, stderr, { version, hooksInstalled, maxLineLength? })` | Pumps newline-delimited JSON-RPC through `createMcpServer`, one message at a time, in order. Resolves when stdin ends. Lines over `maxLineLength` (default `MCP_MAX_LINE_LENGTH`, 1 MiB) are dropped unread and answered `-32700` |
| `MCP_TOOLS`, `MCP_TOOL_ANNOTATIONS`, `MCP_INSTRUCTIONS` | `tools/list` entries (schemas from `SELF_REPORT`), the annotations, the `initialize` instructions (≤ 1 000 chars) |
| `MCP_RESULT_TEXTS`, `MCP_LOG_MESSAGES`, `JSON_RPC_ERRORS` | Every string the server can write. None contains request text |
| `MCP_PROTOCOL_VERSIONS`, `MCP_DEFAULT_PROTOCOL_VERSION` | `2025-11-25`, `2025-06-18`, `2025-03-26`; default `2025-11-25` |

## Protocol (ADR-0017 §1)

| Request | Answer |
|---|---|
| `initialize` | `protocolVersion` (a known version is echoed, anything else gets `2025-11-25`), `capabilities: { tools: { listChanged: false } }`, `serverInfo: { name: "javi", version }`, `instructions` |
| `ping` (also before `initialize`) | `{}` |
| `tools/list` | the two tools with `inputSchema` from JD-C02 and annotations `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false` |
| `tools/call`, valid arguments, hooks installed | constant "noted: javi's hooks record this … for the dashboard" (no delivery claim) |
| `tools/call`, invalid arguments | `isError: true`, a constant per tool naming the allowed values |
| `tools/call`, hooks not installed | `isError: true`, "not recorded: javi hooks are not installed for this project" |
| `tools/call`, unknown tool or bad `params` | `-32602` |
| `tools/list` or `tools/call` before `initialize` | `-32600` |
| `server/discover` or any other method, at any time | `-32601` (modern clients then fall back to `initialize`) |
| malformed JSON | `-32700`, `id: null` |
| a batch (array) or a non-object | `-32600`, `id: null` |
| a notification (no `id`) or a response | nothing |

- `id` is echoed exactly (string or number); a request whose `id` is neither gets `-32600` with `id: null`.
- stdout carries only newline-terminated JSON-RPC messages; stderr only `MCP_LOG_MESSAGES` (`javi mcp: started`, `stopped`, `malformed message ignored`, `invalid request`, `message too large`, `hooks check failed`). Method names, request text and parse excerpts are never written anywhere.
- Arguments are validated by JD-C02 `validateSelfReport`, the same check the hooks use; Gemini strips `additionalProperties` from tool schemas, so the server cannot rely on the client.

## Tests

- `test/server.test.ts`: request → exact response for every row above, sentinel strings in every request field (except `id`) absent from every written line and log, `serveStdio` over in-memory streams (split chunks, split UTF-8, oversized lines).
- `test/interop.test.ts`: the official SDK client (`@modelcontextprotocol/sdk`, pinned `1.32.2`, dev dependency only) against `test/fixtures/stdio-entry.ts` run as a real `node --no-warnings` process; and a raw process run asserting every stdout line is one JSON-RPC 2.0 message and every stderr line is a fixed string. Re-run whenever the SDK dev dependency is upgraded.
