---
'@javis-dog/collector-mcp-server': minor
---

New package JD-C03 (ADR-0017 S5d): hand-written stdio MCP server for agent self-report. `createMcpServer` (initialize, ping, tools/list, tools/call for `report_status` and `report_task`; constant texts, fixed stderr strings, never echoes input) and `serveStdio`. Interop-tested with the official SDK client 1.32.2 as a dev dependency only.
