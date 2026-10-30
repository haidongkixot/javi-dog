---
'@javis-dog/realtime': minor
'@javis-dog/web': minor
---

S5d agent self-report (ADR-0017 §6): JD-M07 threads and activity items gain `statusSource` (`agent` / `collector`) and `statusReason` (a listed reason or null). A self-reported status (a `heartbeat` with a status and a `tool_name`) holds until later collector activity (`task.*`, `session.*`, `agent.*`, or a `heartbeat working` without a `tool_name`). A thread needs attention when its status is `waiting`, or `blocked` from the agent. New export `STATUS_REASONS`. JD-APP `ThreadStatusPill` takes `source` and `reason`: an agent's report reads "Blocked · missing credentials · reported by agent" in the thread lists and the activity feed.
