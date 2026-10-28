---
name: local-companion-process-hardening
description: Harden a local companion process for a developer tool — a CLI that registers hooks in another tool, edits a user-level config file, and runs a background HTTP receiver on localhost (for example an OpenTelemetry/OTLP, webhook or metrics receiver). Covers the listener checklist (loopback bind, bearer secret compared in constant time, Host-header allowlist against DNS rebinding, media-type/encoding/size caps with bounded decompression, non-default port, idle exit only on authenticated traffic), process identity before trusting or signalling a pid, visible port conflicts, neutral hooks that never block or talk to the host tool, and reversible opt-in edits of user config (backup once, refuse on conflicts, revert only unchanged own keys, write through symlinks, fail loudly on unreadable files). Use when building a local agent, collector, daemon, sidecar, IDE/CLI helper, or anything that listens on 127.0.0.1, writes to `~/.<tool>/settings`, `.bashrc`-like files or another tool's config, starts detached background processes, stores a token locally, or sends signals to pids read from a file.
metadata:
  version: "0.1.0"
  origin: "javis-dog G2"
  confidence: "medium (built, adversarially reviewed with probes, conformance- and mutation-tested); low (behaviour inside a real host-tool session: not yet observed)"
---

# Local companion process hardening

A companion process that sits next to a developer tool looks harmless: it only listens on localhost and only edits the user's own config. Both are attack and failure surfaces. Any web page the user visits can send requests to `127.0.0.1`; DNS rebinding can make them look same-origin; a different program can hold your port and receive what the host tool sends you; a pid file can name a process that has since been reused; and a config edit can silently take over or break the user's existing setup.

The rule: **authenticate every local request, confirm identity before trusting a process, and make every change to the user's environment opt-in, reversible and refusable.**

## 1. Listener checklist

Apply all of these; each one closed a real gap in the origin's review or vectors.

| Control | Rule | Why |
|---|---|---|
| Bind | `127.0.0.1` only, never `0.0.0.0` | Not reachable from the network |
| Port | A fixed non-default port with an override flag, not the protocol's well-known port | The user's own collector on the default port keeps working |
| Authentication | Bearer secret generated at setup, stored with the user's config, compared in constant time on a digest; missing or wrong → 401 | Any local page or program can reach localhost |
| Host header | Allow only `127.0.0.1:<port>` and `localhost:<port>`; anything else → 403 | DNS-rebinding guard: a rebinding page sends its own host name |
| Media type and encoding | Accept only the encodings you implement (for example `application/json`, `identity`/`gzip`); others → 415 | A producer can tell "unsupported" (fix config, keep data) from "malformed" (drop) |
| Size | Cap declared length, bytes read and **decompressed** bytes (pass a max output length to the decompressor) → 413 | Gzip bombs |
| Errors | Malformed → 400; internal errors → 503 (retryable) with no partial state change | Producers retry 5xx; state stays consistent |
| Unknown path/method | 404 / 405 with `Allow` may be answered before auth — they reveal nothing | Simpler, documented choice |
| Lifetime | Exit after an idle period; only **authenticated** requests reset the idle timer | Unauthenticated noise cannot keep the process alive |

Write black-box vectors for each row (see `independent-conformance-vectors`) and a mutation check for the Host guard: disable it and expect exactly the foreign-Host vector to fail.

## 2. Process identity before trust or signals

A pid file says which process *was* yours. Before trusting a running receiver, and before sending it any signal:

1. Check the pid is alive.
2. Probe the port with the secret; the receiver answers with its own pid in a response header.
3. Trust and signal only if the probed pid equals the recorded pid. Otherwise mark the record stopped and send nothing.

## 3. Port conflicts are visible, not silent

If the port is held by another program, that program receives whatever the host tool exports to it (in the origin: telemetry with identity attributes). Record the conflict with a timestamp, back off from re-spawning for a while, and show it in the status command with the fix (`--port`). A second instance of your own receiver exits quietly when the port is taken by the first.

## 4. Neutral hooks

Hooks run inside someone else's loop. Make them:

- **Silent:** no stdout (some hosts add hook stdout to the model's context) and exit 0 on every path, including bad input and internal errors.
- **Non-blocking:** asynchronous where the host allows; synchronous only where the host may cancel async work (session end), with a short timeout.
- **Shell-free:** exec form (command + args array), not a shell string — portable across shells and immune to quoting.
- **Secret-free in argv:** read tokens from an environment variable or stdin, store them in a user-only file (mode 0600) outside the repository; never print them.
- **Detached for slow work:** record locally (file spool), spawn a detached flusher, debounce spawns, one flusher per target under a lock.
- **Minimal by allowlist:** copy only the fields you map; hash session identifiers with a per-installation salt.

## 5. Reversible opt-in edits of user config

When your feature needs a user-level config change (the host ignores the setting at project level, for example):

1. Only on an explicit command (`<tool> feature on`), never as a side effect of install or tests (tests use a temporary home directory).
2. Back up the file once, before the first edit.
3. **Refuse and change nothing** when the file cannot be parsed, or when any key you would set is already set by someone else — in the file or in the current shell environment. Do not take over an existing setup.
4. Save your own state (what you wrote) **before** editing, and restore it on refusal or error.
5. Write through symlinks to the target; keep the link a link.
6. Tighten permissions when rewriting a file that holds a secret.
7. Revert (`off`) removes only keys whose values are still exactly what you wrote.
8. If the file is unreadable at revert time, **fail loudly** with the file name (never values), keep your state, and tell the user how to fix it — no silent success.
9. Document what you cannot see: organization-managed or server-pushed settings that override or disable your change.

## Pitfalls

- **"It's only localhost."** Browsers and other local programs can reach it.
- **Pid files as identity.** Pids are reused.
- **A taken port treated as "already running".** It may be someone else.
- **Silent success on revert.** The user believes the change is gone.
- **Hooks that print.** Output can end up in the host tool's context or block it.

## Evidence from origin project

Javi's Dog, Sprints 3c and 3e (2026-10-23, 2026-10-28): a CLI that registers Claude Code hooks and receives Claude Code's OTLP/HTTP JSON metrics on localhost. Confidence **medium** for the controls (implemented, reviewed adversarially with probes, covered by vectors and mutation checks); **low** for real-session behaviour — the first real run with the host tool is still pending, and one design fact (that the telemetry session id equals the hook session id) is UNVERIFIED.

- Decisions: hooks design in `docs/adr/0010-claude-code-collector.md` (exec form, async, neutral, token never in argv, 0600 credentials); receiver and user-config edit in `docs/adr/0011-local-otlp-usage-receiver.md` (Decision outcome and *Changes*).
- Listener code: `collectors/claude-code/src/receiver.ts` — 1 MiB cap (l. 17) with bounded gunzip (l. 218), pid header (l. 27), port-conflict backoff (l. 142–160), constant-time bearer check (l. 373), Host allowlist (l. 380–382), idle timer (l. 298–302).
- Vectors and mutation: 40 OTLP receiver vectors incl. foreign Host → 403 (vector 09); disabling the Host check failed exactly vector 09 (`docs/sprints/SPRINT-03e.md` Test evidence).
- Review: 3 majors reproduced with probes — silent success of revert on an unreadable settings file, pid-only liveness (lost data or a signal to a reused pid), a foreign program on the port receiving identity data — fixed in `95a4b5a` with 24 tests run red first (24 FAIL / 251 PASS → 275 green). The orchestrator re-read the signal path: "the only signal follows an authenticated probe that returned the recorded pid" (`SPRINT-03e.md` team log).
- Hook process tests: real `node` hook processes exit 0 with empty stdout/stderr and deliver through a detached flusher (`collectors/claude-code/test/process.test.ts`, `SPRINT-03c.md`).
- Documented, not fixed: settings `env` may reach programs the host runs; managed settings can override the export unseen (`docs/adr/0011-local-otlp-usage-receiver.md` *Changes*).
- Open: a receiver process test is intermittent in CI (see `diagnose-red-ci-from-history`, G2 finding); idle-timer timing on slow machines is a plausible cause, not established.
