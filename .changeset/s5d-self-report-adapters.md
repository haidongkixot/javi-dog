---
'@javis-dog/collector-adapters': minor
---

Agent self-report (ADR-0017 S5d): `SELF_REPORT` (frozen vocabularies, tool names, server name and the two MCP input schemas), `validateSelfReport` (strict, never echoes input), `matchJaviTool` (Claude Code, Codex and Gemini pre/post-tool hooks for javi's two tools), `selfReportRecord` (one JGR record per post-tool hook: `heartbeat` + status + `error_code` `<status>.<reason>`, or `task.*` + `task_kind`) and `selfReportEventId` (HMAC-seeded ULID).
