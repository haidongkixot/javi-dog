---
'@javis-dog/collector-adapters': minor
'@javis-dog/collector-claude-code': minor
---

S5c code review fixes (ADR-0016 Changes S5c, S5c design review).

JD-C02: **Breaking:** `codexEventIdInput` is removed (it was unused); JD-C01's kind-tagged `codexTokenEventId` / `codexCostEventId` are the single Codex event-id formula.

JD-C01: `noProxyCoversLoopback` follows hyper-util: only `127.0.0.1` or an IPv4 range holding it covers the loopback endpoint (`*` and `localhost` no longer count), and `NO_PROXY` is read first-set (a set `NO_PROXY`, even empty, hides `no_proxy`). `codexEnvRisks` takes an optional `system` probe and reports OS proxy settings (macOS `scutil --proxy`, Windows Internet Settings; 2 s timeout, names only) as source `system settings`; new exports `systemProxyFindings`, `runCommand`, `SYSTEM_PROXY_SOURCE`, types `CommandRunner`, `SystemProxyProbe`; `Io.systemProxy` and `HookDeps.systemProxy`. `usage on --platform codex-cli` refuses an OS proxy and explains `HTTPS_PROXY`-only refusals. `disableCodexOtel` / `enableCodexOtel` find javi's block by its start marker through `log_sse_deltas = false` and remove one standalone `# <<< javi` line wherever toml_edit moved it; `usage off` on an edited block keeps Codex usage on, exits 1 and names only javi's lines (new export `CODEX_OTEL_KEYS`). The Codex receiver path appends each event on its own (no rollback; a failed append answers 503 and keeps what was written) and skips event ids it already spooled (state `acceptedEventIds` / `recordAcceptedEventIds`, `ACCEPTED_IDS_MAX` 20 000, 7 days; `ReceiverInfo.duplicates`). `installCodexHooks` takes the previous origin and returns `origin` (type `CodexHooksOrigin`); `uninstallCodexHooks(projectDir, origin)` restores the user's file and deletes it only when javi created it; state `codexHooksOrigin` / `saveCodexHooksOrigin` / `removeCodexHooksOrigin` (type `CodexHooksOriginRecord`).
