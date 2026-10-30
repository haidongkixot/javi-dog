---
name: guard-redirectable-tool-config
description: Guard a user-level opt-in that makes a third-party tool send telemetry, logs or webhooks to your local endpoint — the "detect, refuse, warn" pattern. Every source that can override the setting you wrote (environment variables, `.env` files the tool loads, project or workspace settings merged over user settings, command-line flags, HTTP proxy variables including the operating system's proxy settings, header variables, environment inherited from a parent tool) can redirect the data and your bearer secret somewhere else, or leak your secret into the tool's own vendor export. Covers building the override inventory from the tool's source, probing the tool's real matcher at its pinned dependency versions (for example `NO_PROXY=*` and `localhost` do not exempt `127.0.0.1` in some HTTP clients), refusing at setup with names and paths only, re-checking at every session start from a hook, showing warnings first in status, documenting what you cannot see, and preferring over-refusal to a miss. Use when a CLI, collector, IDE helper or agent companion edits another tool's config (`~/.<tool>/settings.json`, `config.toml`, OpenTelemetry/OTLP exporter settings, webhook URLs), when your local receiver authenticates with a bearer that the tool sends, when the tool honours `HTTP_PROXY`/`ALL_PROXY`/`NO_PROXY`, `.env` files or workspace overrides, or when someone asks "can this telemetry be redirected?".
metadata:
  version: "0.1.0"
  origin: "javis-dog G4"
  confidence: "medium (override inventory from source, setup refusal and session-start re-check: built for two tools, adversarially reviewed with compiled probes, covered by conformance vectors); low (behaviour in real user sessions and of OS system proxies at runtime: NOT RUN)"
---

# Guard redirectable tool config

You opt a third-party tool into sending data to `http://127.0.0.1:<port>` by writing a user-level setting, with a bearer secret so only your receiver accepts it. The tool, not you, decides where the data finally goes. Anything with higher precedence than your setting — an environment variable, a `.env` file it loads, a workspace settings block, a proxy — can send that data (which may include content you never wanted to leave the machine) plus your bearer to another endpoint. You cannot prevent this from outside the tool. You can detect it, refuse to enable the feature while it is present, and warn every time it appears later.

The rule: **inventory every override from the tool's source, refuse at setup, re-check at every session start, report names only, and prefer a false refusal to a missed redirect.**

## Forces

- **Your setting vs. the tool's precedence.** The tool merges several sources; the one you wrote is rarely the strongest.
- **Detection vs. privacy.** To detect a redirect you read environment and config files that may hold other secrets. Never record or print a value.
- **Strictness vs. usability.** Checking every possible source causes refusals the user did not expect; missing one leaks data. Origin choice: over-refuse, explain how to fix.
- **Assumed vs. real semantics.** "`NO_PROXY=localhost` covers loopback" is a guess until you run the tool's own matcher.

## 1. Build the override inventory from the tool's source

Docs list the common sources; the source code shows the precedence. For each tool, write a table and keep it in the decision record:

| Source | Example | Precedence vs. your setting | Visible to you? | Check |
|---|---|---|---|---|
| Process environment | `OTEL_EXPORTER_OTLP_ENDPOINT`, tool-specific `<TOOL>_TELEMETRY_*` | higher | at setup (your shell) and in hooks (the tool's env) | refuse / warn |
| `.env` files the tool loads | the lookup chain from cwd upwards, then the tool home, then the user home | higher | yes, by reading the same chain | refuse / warn |
| Project or workspace settings | a `telemetry` block deep-merged over user settings | higher | only for folders you know about | refuse / warn |
| Proxy variables | `HTTP_PROXY`, `http_proxy`, `ALL_PROXY` not covered by `NO_PROXY` for your loopback address | redirects the transport | yes | refuse / warn |
| OS proxy settings | macOS SystemConfiguration, Windows Internet Settings, when the HTTP client reads them | redirects the transport | via OS commands (read-only) | refuse / warn |
| Header variables | `OTEL_EXPORTER_OTLP_HEADERS`, signal-specific variants (the specific one wins) | replaces your bearer | yes | warn: your receiver will reject (no leak, but no data) |
| Inherited environment | your own exporter variables set for another tool, inherited by this tool when started inside it | may merge your secret into the tool's own vendor export | in hooks | warn |
| Command-line flags, system/managed settings | `--telemetry-*`, organization-pushed config | higher | **no** | document |

Read the actual lookup functions (for example the tool's `findEnvFile`, its config loader's denylist of project-level keys, its HTTP client's proxy builder). Record the source commit you read.

## 2. Probe the matcher, at the tool's versions

Precedence and matching rules live in dependencies. Find the exact versions in the tool's lockfile and compile or run a minimal probe against them:

- Does `NO_PROXY=*` exempt `127.0.0.1`? Does `localhost`? (In the origin, the tool's HTTP client matched an IP host only against IP or CIDR entries: both were proxied.)
- Which variable wins when both `NO_PROXY` and `no_proxy` are set, and when one is set but empty? (Origin: the first one *set* wins, even when empty.)
- Does the client also apply OS proxy settings, and do their bypass lists (`<local>`, exception lists) match an IP? (Origin: no.)

Record the dependency name, version, probe input and output in the decision record. Implement your check with the probed semantics, not the documented intent. See `review-design-before-code` for when to run probes.

## 3. Refuse at setup, with names only

The enabling command (`<cli> usage on`) checks every visible source in the inventory **before** writing anything:

- Any override present → refuse, change nothing, print the **key names and file paths** that caused it and how to fix them (remove the key, set `NO_PROXY=127.0.0.1`, or do not enable).
- Check **every** file in a lookup chain, even those the tool might skip under conditions you cannot see (folder trust, flags). Extra refusals are acceptable; misses are not.
- Exempt your own values only by exact comparison in memory (a tool started inside another tool you configured inherits your variables).
- An existing, foreign configuration of the same feature (the user's own collector) is also a refusal: never take it over (see `local-companion-process-hardening` §5).

## 4. Re-check at every session start, warn first

Setup is one moment; `.env` files and proxies change later. If you already run a hook at session start:

1. Check the hook's own environment (the tool passes its loaded env to hooks, possibly redacted in some modes — so also read the `.env` chain and project settings yourself).
2. On a hit, write a local warning record: key names, source paths, project reference, time. **No values.**
3. A clean session start clears the record; disabling the feature clears it too.
4. The status command shows warnings **before** anything else, with the fix.

The hook must stay silent and fast while doing this (see `local-companion-process-hardening` §4).

## 5. Say plainly what you cannot see

Output and docs state: the setting is user-wide (every folder, not just this project); which sources you cannot observe (flags, managed settings, folders without your hooks); and what the tool will send to your receiver (which you drop in memory). A "secure" or "private" claim needs runtime evidence; until then say "guarded against the sources listed".

## Pitfalls

- **Trusting `NO_PROXY` by reading.** Domain entries may never match an IP address.
- **Checking only the first `.env` file the docs mention.** The tool may walk a chain.
- **Checking only at setup.** The redirect can appear tomorrow.
- **Printing the offending value "for debugging".** It may be a secret or an internal hostname.
- **Treating a header override as harmless without saying so.** It silently turns your feature off (401s).
- **Forgetting your own exported variables.** A child tool can carry your secret to its vendor.

## Evidence from origin project

Javi's Dog, Sprints 5b and 5c (2026-10-29): a CLI that opts Gemini CLI and Codex CLI into exporting OTLP to a loopback receiver. Confidence **medium** for the pattern (source-derived inventory, reviewed, vector-tested, two tools); **low** for runtime behaviour (no real Gemini or Codex session yet; macOS/Windows system proxies UNVERIFIED at runtime).

- Gemini (S5b review R1, high, privacy): telemetry keys from a trusted project's `.env` chain and a workspace `telemetry` block override the user setting and could send logs (tool arguments, response text, user email) plus the bearer elsewhere. Owner decision "Detect, refuse, warn"; setup refusal over every file in the chain, session-start re-check, warning file with names only, own-value exemption by in-memory comparison (`docs/adr/0016-gemini-and-codex-collectors.md` *Changes*, S5b review and review fixes; fix `5e2bd33`).
- Codex (S5c design review D0 H1, high): the OTLP HTTP client uses proxy variables with no loopback bypass; refusal and session-start warning. Code review V1-H1 (high): probe compiled against the tool's pinned HTTP-client version showed `NO_PROXY=*` and `localhost` do **not** exempt `127.0.0.1`; only `127.0.0.1` or an IPv4 CIDR containing it counts; first set variable wins, even empty. V1-M3: the client also reads macOS and Windows system proxies, whose bypass lists do not match an IP → `scutil --proxy` / `reg query` checks, names only (ADR-0016 *Changes* D0 and V1; fix `ffd1bdd`; `collectors/claude-code/src/codex-config.ts`; README "NO_PROXY" paragraph).
- Header override (D0 M5) and inherited-secret leak (D0 H2: the CLI's own exporter header variable for another tool is merged by a child Codex into its vendor export) → warnings, not refusals; owner "Detect and warn" (ADR-0016 *Changes* D0).
- Vectors: Gemini H19/H20 (session start with telemetry or endpoint env), Codex H18 (proxy and header env in hook) (`docs/jgr/conformance/gemini/`, `…/codex/`); runners 54/54 and 41/41 after fixes (`docs/sprints/SPRINT-05b.md`, `SPRINT-05c.md` Test evidence).
- Accepted over-refusal: `HTTPS_PROXY` alone also refuses (ADR-0016 *Changes* V1, "Accepted as is").
- Not verified: that the guard catches a real user's `.env` setup (readiness row "Gemini runtime checks"); that probed semantics match the released binaries (probes used the lockfile versions of the source at the commit read).
