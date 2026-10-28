---
'@javis-dog/jgr-sdk': minor
'@javis-dog/collector-claude-code': minor
---

S3e token usage (ADR-0011): `RecordInput.event_id` (optional, caller-supplied ULID/UUID for idempotent re-sends); `javi` gains a local OTLP/HTTP JSON receiver that maps Claude Code `claude_code.token.usage` / `cost.usage` to `usage.reported`, plus opt-in `javi usage on|off`.
