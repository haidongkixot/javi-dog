---
'@javis-dog/collector-claude-code': patch
---

Registered hook commands (Claude Code and Gemini CLI) start Node with `--no-warnings`, so startup warnings (for example the `UNDICI-EHPA` warning under `NODE_USE_ENV_PROXY=1`) never reach a hook's stderr. Re-run `javi init` to update existing hooks.
