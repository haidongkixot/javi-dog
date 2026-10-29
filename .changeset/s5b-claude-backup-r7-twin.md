---
'@javis-dog/collector-claude-code': minor
---

Claude Code usage backup never holds javi's secret (R7 twin, ADR-0016 Changes R7). `enableUsageEnv` backs `~/.claude/settings.json` up only while it has none of javi's keys; `EnableResult.backup` is now a `SettingsBackup` (`{ path, status: 'created' | 'kept' | 'skipped' } | null`) instead of a path. `disableUsageEnv` removes the backup after a full removal of javi's keys and reports it in the new `DisableResult.backupRemoved`. `javi usage on|off` say what happened to the backup. New export: type `SettingsBackup`.
