---
name: local-companion-process-hardening
description: Harden a local companion process for a developer tool — a CLI that registers hooks in another tool, edits a user-level config file, and runs a background HTTP receiver on localhost (for example an OpenTelemetry/OTLP, webhook or metrics receiver). Covers the listener checklist (loopback bind, bearer secret compared in constant time, Host-header allowlist against DNS rebinding, media-type/encoding/size caps with bounded decompression, non-default port, idle exit only on authenticated traffic), process identity before trusting or signalling a pid, visible port conflicts, neutral hooks that never block or talk to the host tool, reversible opt-in edits of user config (backup once, refuse on conflicts, revert only unchanged own keys, write through symlinks, fail loudly on unreadable files), hook silence that survives runtime startup warnings and unhandled promise rejections, and edits of files the host tool also rewrites or trusts by position (append-only, never write the host's trust state, a stable unversioned launcher, blocks identified by content not by an end marker, backups that never hold your own secret, origin records so uninstall never deletes the user's file), and registrations in project-level files that may be committed (git-tracked refusal that fails closed, local git excludes for files you create, uninstall that survives a foreign unparsable file, table placement that later user keys cannot join, control characters stripped from repo-controlled values in status output, a launcher that fails with one fixed line). Use when building a local agent, collector, daemon, sidecar, IDE/CLI helper, or anything that listens on 127.0.0.1, writes to `~/.<tool>/settings`, `.bashrc`-like files or another tool's config, starts detached background processes, stores a token locally, or sends signals to pids read from a file, or when hook stderr shows Node/Python/runtime warnings, or when it asks the user for a secret (a recovery key, a passphrase, a token) while coding agents may be running the terminal, or when it registers itself in a project file such as `.mcp.json`, `.gemini/settings.json`, `.codex/config.toml`, `.vscode/*.json` or `.tool-versions`.
metadata:
  version: "0.4.0"
  origin: "javis-dog G2; updated G4, ad-hoc-self-report (S5d), ad-hoc-privacy (S5f)"
  confidence: "medium (controls: built for three host tools, adversarially reviewed with probes, conformance- and mutation-tested; hook silence under a proxy env: found and fixed by a production end-to-end run; project-file registration: one iteration, code review reproduced on the built bundle, fixed red-first; secret input next to coding agents: one iteration, pty process tests, security review fixed red-first); low (behaviour inside a real host-tool session and on Windows: not yet observed)"
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

Silence is about the **whole process**, not only your code:

- **Runtime warnings come before your code runs.** An environment variable your users set (in the origin: a proxy switch) makes the runtime print an experimental warning at startup. Start the runtime in the registered hook command with warnings off (for Node, `node --no-warnings <cli> hook …`), and test hook silence **with** the environment variables real users have, not only a clean CI env.
- **No floating promises.** A promise started eagerly (for example `const ready = mkdir(home)`) and awaited only later becomes an unhandled rejection when it fails first: the runtime prints to stderr and may change the exit code. Mark it handled at creation (`ready.catch(() => {})`) and keep awaiting it where the result matters. Then search the workspace for the same pattern.
- **Treat "unhandled rejection" in a test run as a product bug candidate,** even when every test passed.
- **Stdout may become model context.** Some hosts pass plain hook stdout to the model, or treat non-JSON stdout as an error. Shell profile output (login shells, `BASH_ENV`, `.zshenv`) can appear even when your program prints nothing: at setup, run the host's shell the way it will run your hook (`$SHELL -c true`, `$SHELL -lc true`) and warn when it prints.

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

## 6. Editing files the host also rewrites or trusts

Some hosts rewrite their config files themselves (approvals, project lists) and trust hooks by **position plus a hash** of the command. Then:

1. **Append only.** Never reorder or rewrite existing entries; a moved entry loses its approval. Uninstall removes only your entries and tells the user which of theirs shifted and need review again.
2. **Never write the host's trust state** (approved hashes, trust levels). Approval is the user's decision; your status command reads it (read-only) and says "waiting for approval" until the first event arrives.
3. **Keep the registered command stable.** Register an unversioned launcher (`~/.<cli>/bin/<cli>-hook` plus a `.cmd` twin on Windows) that calls the current version; upgrades rewrite the launcher, not the host's config, so no re-approval is needed. Refuse launcher paths with spaces or shell metacharacters rather than quoting them per shell.
4. **Parse comment-preserving formats with a real parser** (TOML, YAML) before and after your edit; refuse when your section already exists in any syntactic form (table, dotted key, inline table); write atomically, keep the file mode.
5. **Identify your block by its content, not by its end marker.** The host's rewriter may move a trailing comment marker to the end of the file when it appends tables. Remove your lines from the start marker through your last key, remove one standalone end marker wherever it sits, keep what the host added.
6. **Never claim "off" when you could not remove your block** (it was edited): say what remains and which lines to remove.
7. **A backup never holds your own secret.** Take it only when the file has no block of yours; remove it after a successful restore.
8. **Record the file's origin.** If you created the file (or a key in it), record that; uninstall restores from the record and never deletes a file it has no record of creating.

## 7. Registering in project files that may be committed

Some features need an entry in a **project-level** file the host reads (an MCP server list, a workspace settings file, a project TOML). Those files are often committed and shared, and your entry holds machine-specific paths. In addition to §5 and §6:

1. **Refuse git-tracked files** unless the user passes an explicit flag (`--allow-tracked-config`): a committed absolute path breaks teammates. The tracked check is three-valued — tracked, untracked, **unknown** — and unknown (git missing, "dubious ownership" exit 128, timeout) refuses too, with a message that says git could not be checked. Run git without a shell, with a timeout and a fixed locale; make the runner injectable for tests. See `fail-closed-checks`.
2. **Refuse to write a file you cannot parse.** But **do not let a foreign unparsable file block uninstall**: if your records say you never wrote to it, warn with its name, remove the rest of your installation and leave the file byte for byte; abort only where your records say you wrote.
3. **Keep a file you created out of commits.** Add a root-anchored line (`/<path>/<file>`) to the repository's local exclude file (`.git/info/exclude`, not the shared `.gitignore`), record that you added it, and remove exactly that line on uninstall. Leave pre-existing files and already-ignored paths alone.
4. **Place a table where later user keys cannot join it.** In TOML, keys appended after your `[table]` belong to your table — and on uninstall they move to the table above. Insert your block before the first table header that follows the root keys, and verify by parsing that the file reads exactly as before plus your table; otherwise try the next header, and append only when there is no table. When bare keys already follow your end marker, refuse `init` and `uninstall` and name the line numbers.
5. **Status output treats repository content as untrusted.** Values you print from a project file (command, arguments, project name) pass through a printable filter that strips C0 and C1 control characters: a planted entry can otherwise send terminal escape sequences. Read files whose path came from a project file only if they are small regular files with the expected name (never `/dev/zero`).
6. **A launcher that fails, fails in one line.** If the registered launcher cannot find the installed program, print one fixed line ("not installed here; run `<cli> init`") and exit non-zero — no stack trace with home-directory paths into the host's log. Have the status command check that the launcher's target exists.
7. **Byte-exact round trip.** A test runs install then uninstall on files with the user's own entries, comments, odd formatting and a BOM, and compares bytes. Record any accepted cosmetic deviation (line endings, quoting) with its reason.

## 8. Accepting a user secret next to coding agents

A CLI that asks for a secret (an encryption recovery key, a passphrase) is now often started **by** a coding agent, or in a terminal an agent controls. Anything typed or passed there can end up in the model provider's transcript.

1. **Never from argv.** Offer three inputs: a hidden prompt read from the terminal device itself (`/dev/tty`, `CONIN$` on Windows), a key file (`--key-file <path>`), or an environment variable.
2. **Refuse the prompt where an agent may be listening.** Before opening the terminal or setting raw mode, refuse when a known agent marker is in the environment (keep the list with its sources, for example the variables each agent CLI sets) or when stdin, stdout or stderr is not a terminal. The refusal points to the **key file** only — an agent told about the environment variable will put the secret into its own command line.
3. **Say it in the output and the docs:** "run this yourself in a terminal; never paste the key into an agent's chat or command".
4. **Restore the terminal on every exit path** (Ctrl-C, SIGINT, SIGTERM, SIGHUP) and test it with a pseudo-terminal (`script` on Linux) and `stty -a` after exit.
5. **Environment hygiene:** delete the variable from the process environment right after reading it, and give every child process (flush, receiver, git) an **explicit** environment without it. Test with the children's `/proc/<pid>/environ`.
6. **Key file checks:** read the opened file's own `stat`; warn (names only, never content) when group/other bits are set or the owner is another user.
7. **Storage:** mode 0600 on POSIX (Windows: the profile's ACLs, and say it is untested if it is); never print the secret — status shows only a key id. Warn before any command deletes the stored copy, and say what becomes unreadable.
8. **Test from the built bundle.** If the bundle swaps a module (a loader), a test must run the bundled CLI end to end; in the origin the bundled loader was covered by no test until the review.

A piped token on stdin and a hidden prompt conflict: once the prompt needs all three streams to be terminals, take the other credential from an environment variable or file and document the change.

## Pitfalls

- **A secret prompt inside an agent's terminal.** The transcript is outside your control.
- **Pointing an agent at an environment variable for a secret.** It will write it into a command.
- **Children inheriting your secret.** Pass an explicit environment.
- **"Non-zero means untracked."** Exit 128 means git could not tell.
- **An appended TOML table.** The user's next key joins it.
- **Uninstall that stops at someone else's broken file.** The user cannot remove your tool.
- **"It's only localhost."** Browsers and other local programs can reach it.
- **Pid files as identity.** Pids are reused.
- **A taken port treated as "already running".** It may be someone else.
- **Silent success on revert.** The user believes the change is gone.
- **Hooks that print.** Output can end up in the host tool's context or block it.
- **"My code prints nothing."** The runtime and the shell can.
- **Finding your block by its end marker.** The host may move it.
- **Uninstall that deletes the whole file.** It may be the user's.
- **Redirectable opt-ins.** A user-level setting can be overridden by env files, workspace settings or proxies; see `guard-redirectable-tool-config`.

## Evidence from origin project

Javi's Dog, Sprints 3c and 3e (2026-10-23, 2026-10-28): a CLI that registers Claude Code hooks and receives Claude Code's OTLP/HTTP JSON metrics on localhost. Confidence **medium** for the controls (implemented, reviewed adversarially with probes, covered by vectors and mutation checks); **low** for real-session behaviour — the first real run with the host tool is still pending, and one design fact (that the telemetry session id equals the hook session id) is UNVERIFIED.

- Decisions: hooks design in `docs/adr/0010-claude-code-collector.md` (exec form, async, neutral, token never in argv, 0600 credentials); receiver and user-config edit in `docs/adr/0011-local-otlp-usage-receiver.md` (Decision outcome and *Changes*).
- Listener code: `collectors/claude-code/src/receiver.ts` — 1 MiB cap (l. 17) with bounded gunzip (l. 218), pid header (l. 27), port-conflict backoff (l. 142–160), constant-time bearer check (l. 373), Host allowlist (l. 380–382), idle timer (l. 298–302).
- Vectors and mutation: 40 OTLP receiver vectors incl. foreign Host → 403 (vector 09); disabling the Host check failed exactly vector 09 (`docs/sprints/SPRINT-03e.md` Test evidence).
- Review: 3 majors reproduced with probes — silent success of revert on an unreadable settings file, pid-only liveness (lost data or a signal to a reused pid), a foreign program on the port receiving identity data — fixed in `95a4b5a` with 24 tests run red first (24 FAIL / 251 PASS → 275 green). The orchestrator re-read the signal path: "the only signal follows an authenticated probe that returned the recorded pid" (`SPRINT-03e.md` team log).
- Hook process tests: real `node` hook processes exit 0 with empty stdout/stderr and deliver through a detached flusher (`collectors/claude-code/test/process.test.ts`, `SPRINT-03c.md`).
- Documented, not fixed: settings `env` may reach programs the host runs; managed settings can override the export unseen (`docs/adr/0011-local-otlp-usage-receiver.md` *Changes*).
- Open: a receiver process test is intermittent in CI (see `diagnose-red-ci-from-history`, G2 finding); idle-timer timing on slow machines is a plausible cause, not established.

### Update at G4 (Sprints 5a–5c, 2026-10-28/29)

Same CLI extended to two more host tools (Gemini CLI, Codex CLI). Confidence unchanged for real sessions (**low**: no real run with either host yet).

- Runtime warning: the production end-to-end smoke's first run found every hook writing to stderr; with `NODE_USE_ENV_PROXY=1` Node prints the `UNDICI-EHPA` warning before the CLI runs (177 B reproduced directly). Gemini shows hook stderr. Fix red-first: registered commands start Node with `--no-warnings` (`183c83d`; `collectors/claude-code/src/settings.ts` l. 41–43, `gemini-settings.ts` l. 113–127, `codex-hooks.ts` l. 58, 71; `test/hook-silence.test.ts`) (`docs/sprints/SPRINT-05a.md` Log).
- Unhandled rejection: CI run 40878049774 failed with all 440 collector tests passing — vitest reported `ENOENT mkdir` from an eager `mkdir(home)` promise in `createState()`; fix `ready.catch(() => {})` (`d3ebf6d`, `state.ts` l. 193), red first (1 rejection → 0). Twin in the SDK spool fixed next (`ce3f3f7`, `packages/jgr-sdk/src/spool.ts` l. 56) (`SPRINT-05b.md` Log).
- Position-trusted hooks and host rewrites (Codex): append-only `hooks.json`, never write `[hooks.state]`/`trusted_hash`, unversioned launcher with `node --no-warnings`, launcher-path refusal, shell-output warning at setup (ADR-0016 *Changes* C1, D0 H4/H5, M3). Code review V1-H2: the host's TOML rewriter (toml_edit, probed at the host's lockfile version) moved the `# <<< javi` end marker after appended tables, so "off" falsely claimed success → block identified by content (`codex-config.ts` l. 114–138, 270; `test/codex-config.test.ts` "after Codex rewrote config.toml"). V1-L5: uninstall deleted a user's `hooks.json` → origin record, restore from it (`ffd1bdd`) (ADR-0016 *Changes* V1 and review fixes).
- Backup holding the CLI's own secret: S5b review R7 for the new host, and the same defect in the original host's path ("R7 twin"), both fixed red-first (`5e2bd33`, `c0bfde2`).
- Not verified: Windows `cmd.exe`/PowerShell quoting of the launcher; whether login-shell output reaches hook stdout in practice (readiness rows "Codex runtime checks", "Gemini runtime checks").

### Update at ad-hoc-self-report (Sprint 5d, 2026-10-30)

Same CLI registers a local MCP server in three hosts' project files (`.mcp.json`, `.gemini/settings.json`, `.codex/config.toml`; ADR-0017 decision 5). Code review of `2d4dcc2..08f7b2e`: 0 high, 3 medium, 5 low, "all Mediums were reproduced against a built bundle"; fixes red-first, merged `0a0c7e9` (`docs/sprints/SPRINT-05d.md` Team log; ADR-0017 *Changes* "Code review").

- Tracked-file refusal from the design review (D0 M7: "tracked files refused"); M3: the check "mapped every git failure (exit 128 for dubious ownership, git missing) to 'untracked'" → tri-state, `spawnSync` without a shell, 5 s timeout, `LC_ALL=C`, injectable runner (`567422e`). Behaviour change recorded: "on a machine without git, `--self-report` needs `--allow-tracked-config`" (`SPRINT-05d.md` Log). Twin in the Codex hooks installer's tracked check (warning only) logged as follow-up F3.
- M2: "`uninstall` is blocked by a user's unparsable `.mcp.json`, even without self-report" → warning, hooks removed, file untouched; abort only with a recorded registration (`eb2896d`).
- L2: a javi-created `.mcp.json` was not git-excluded → root-anchored line in `info/exclude`, recorded, removed on uninstall (`3a5e241`).
- L4: "javi appended its `[mcp_servers.javi]` block at the end … so a key the user later appended joined javi's table, and uninstall then handed it to the table above" → placement before the first table header after the root keys, verified by parsing; bare keys after the end marker refuse `init` and `uninstall` with line numbers (`eab49c8`).
- L3: `javi status` printed repository-controlled values → control characters stripped; launcher target read only from a small regular file named `javi-mcp.mjs` (`80c0d05`).
- L1: launcher stack trace on stderr → one fixed line; status warns when the target bundle is missing (`3831752`).
- Byte-for-byte: review focus "an existing `.mcp.json` with the user's servers and odd formatting → kept byte-for-byte except javi's entry"; L5 (mixed line endings, lone-surrogate quoting) accepted: "no data loss, and the round trip is byte-exact" (ADR-0017 *Changes*).
- Not verified: behaviour with the real host CLIs (approval prompts per project server, trusted folders) — owner runs NOT RUN.

### Update at ad-hoc-privacy (Sprint 5f, 2026-10-30/31)

`javi init --privacy L1|L2` stores a project recovery key (ADR-0018 decision 6, design review D0 M3, security review M3, L4, L7, L8; amendment "Decision 6 amended").

- D0 M3: "The key could leak through env inheritance, shell history, agents and stdin" → `/dev/tty` prompt or key file, variable deleted from the env, explicit child env, guidance (`3258c54`: "Every child process gets an explicit env without JAVI_PRIVACY_KEY").
- Security review M3 → `a8a123d`: refuses "when an agent marker is in the environment (CLAUDECODE, CLAUDE_CODE_ENTRYPOINT, CODEX_THREAD_ID, CODEX_SESSION_ID, CODEX_SANDBOX, CODEX_SANDBOX_NETWORK_DISABLED, GEMINI_CLI; sources in AGENT_ENV_MARKERS) or when stdin, stdout or stderr is not a TTY"; "SIGINT, SIGTERM and SIGHUP cancel a waiting prompt, and the terminal mode is restored"; pty tests "through util-linux script … with stty -a checked after exit".
- Amendment: "The no-terminal message points only to `--privacy-key-file`, because an agent would put `JAVI_PRIVACY_KEY` into its own command"; "A token can no longer be piped on stdin when the prompt is used".
- L8 `f98723d` (mode & 0o077 or another owner → fixed warning); L4 `944ef73` (warning before deleting the stored key); L7 `2cb41d9` ("The bundle swaps crypto-loader.ts for crypto-loader.bundle.ts, which no test ran"; a throwing bundled loader "fails only this test (mutation check, reverted)").
- NOT RUN: Windows hidden prompt and file modes (readiness row "L1/L2 runtime"; owner how-to step 7).
