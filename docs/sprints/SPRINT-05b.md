# Sprint 05b — Gemini CLI collector (hooks, usage, estimated cost)

- Dates: 2026-10-29 (timebox 30 min, parallel lanes) · Status: **ACTIVE**
- Goal: `javi init --platform gemini-cli` and `javi usage on --platform gemini-cli` let Gemini CLI sessions appear in Javi's Dog with status, attention, tools, tokens and an **estimated** cost, without any prompt, response, tool I/O or path leaving the machine.
- Modules touched: JD-C02 (new), JD-C01, JD-M01 (spec §12 changelog), docs
- Readiness gate: `docs/agent-ops/READINESS_MATRIX.md` rows "Gemini CLI surfaces", "Gemini price source", "Gemini runtime checks"
- Test plan: `docs/agent-ops/TEST_PLAN.md` §S5b
- ADR: `docs/adr/0016-gemini-and-codex-collectors.md`

## Global constraints

- Owner decisions 2026-10-29: Gemini OTel is a **user-level opt-in**, with `logPrompts: false` forced. Cost comes from a **dated price table and is labelled estimated**. Codex follows in S5c.
- Privacy by minimization: allowlist mapping only. The receiver answers `/v1/logs` and `/v1/traces` without parsing the body.
- Claude Code installs keep working unchanged (`--platform` defaults to `claude-code`).
- No new external package; no server or schema change; screenshot budget 0.

## Backlog

| # | Task | Module | Interfaces (consumes → produces) | Acceptance criteria | Status |
|---|---|---|---|---|---|
| A1 | Gemini hook mapper | JD-C02 | Gemini hook stdin → `mapGeminiHook` → `RecordInput \| null` | ADR-0016 §2 mapping; `gm_` thread refs; `platform: gemini-cli`; no content keys read; `ToolPermission` → attention | Done |
| A2 | Gemini OTLP parser | JD-C02 | OTLP/HTTP JSON → `parseGeminiMetrics` → points | `gemini_cli.token.usage` Sum only; `session.id` (point, else resource), `model`, `type`; `tool` ignored; cumulative temporality kept | Done |
| A3 | Delta rule + price table | JD-C02 | group delta → `geminiUsageDelta`; `GEMINI_PRICES` from the Vertex AI page (read 2026-10-29) | input − cache clamped; cost = Σ counters × price; `estimated: true` only when priced; unknown model → no cost; intro-price date windows | Done |
| B1 | `javi` platform wiring | JD-C01 | `--platform gemini-cli` on `init`, `uninstall`, `status`, `hook`, `usage on/off` | `.gemini/settings.json` hooks (backup, merge, marker, uninstall); `~/.gemini/settings.json` telemetry block (backup, refusal on conflicts, `off` restores); trust notice | Done |
| B2 | Receiver and usage pipeline | JD-C01 | `/v1/metrics` → both parsers; `/v1/logs`, `/v1/traces` → `200 {}` unparsed | Gemini points → baselines → groups → `geminiUsageDelta` → `usage.reported` with `gm_` ref and `reasoning_tokens`; unknown session dropped; hook latency bound | Done |
| Q1 | Conformance vectors | docs | ADR-0016 + Gemini docs text → `docs/jgr/conformance/gemini/` | Hook vectors (incl. privacy sentinels) and OTLP vectors (cumulative, resets, input − cache, tool ignored, unknown session, cost) | Done (40 vectors) |
| R1 | Runner | JD-C01 | README runner rules → `collectors/claude-code/test/gemini-conformance.test.ts` | Every vector PASS; mutation checks | Planned (orchestrator) |
| V1 | Review | all | read-only | Findings fixed or logged | Planned |

## Review focus

- A Gemini hook payload carrying `prompt`, `prompt_response`, `tool_input`, `tool_response`, `transcript_path`, `cwd` or `details` → none of it reaches the spool or the network (A1/B2, Q1 sentinels).
- `~/.gemini/settings.json` already has a `telemetry` block (for example the user's own collector) → `usage on` refuses with a clear message, and never overwrites it (B1).
- Gemini cumulative counters restart (new process, same session id) → no negative or double-counted delta (A2/B2).
- `javi hook` is slow or prints to stdout under Gemini's synchronous hooks → the agent stalls or Gemini warns. The hook must return quickly with empty stdout (B2).

## Team

Roster per `docs/agent-ops/TEAM.md`.

| Role | Agent | Lane / paths |
|---|---|---|
| Orchestrator + Secretary | main session | ADR, scaffold, spec §12, R1 runner, merges, docs, push |
| Researcher | general-purpose | done: S5b research (scratch notes); orchestrator spot-checked 3 facts |
| Developer A | general-purpose, worktree | A1–A3: `collectors/adapters/src/**`, `collectors/adapters/test/**` |
| Developer B | general-purpose, worktree | B1–B2: `collectors/claude-code/src/**`, `collectors/claude-code/test/**` (not `gemini-conformance*`), README |
| QA | general-purpose, worktree | Q1: `docs/jgr/conformance/gemini/**` |
| Reviewer | general-purpose, read-only | V1 |

Team log, newest first:

- 2026-10-29 — Orchestrator — Merged A (`41f179b`), Q1 (`184c4fd`) and B (`092c0f2`).
  - **Cross-checks.**
    - Developer A's price table and QA's independently derived prices agree on gemini-2.5-pro/flash/flash-lite and gemini-3.8-flash before and after 2027-01-01.
    - The orchestrator found two fragments verbatim and exactly once in the page text.
    - The thread-ref seam is checked: JD-C02 `mapGeminiHook` / `geminiThreadRef` equals JD-C01 `opaqueRef('gm', …)`.
  - **QA decisions.**
    - G5: a new sibling series counts from 0, decided by the orchestrator and written into ADR-0016 Changes. U20 is updated.
    - G15: OTLP vector 21 is superseded and now expects `200 {}`. Holding it back from the push was justified: before B it failed with `expected 404 to be 200`.
  - **Gate.** The forced full gate passed with 1367 tests and 0 failed packages, then `8e8c5a9` was pushed. Collector tests: 359/359 against the real adapters.
  - **Process slip.** The `8baec90` push command ran `git push` after a `;`, so it was not gated. The gate was re-run afterwards and passed, so no harm was done. Pushes are chained with `&&` again.
- 2026-10-29 — Developer B — B1–B2. `--platform gemini-cli` covers `init`, `uninstall`, `status`, `hook` and `usage`, including exact restore and refusals. The receiver sinks logs and traces without parsing them and keeps separate baselines per platform. 359 tests; hook latency 363–406 ms.
- 2026-10-29 — QA — 40 vectors (H01–H18, U01–U22), a schema, a runner README and 20 ambiguities stated. Prices were derived from the page text, not from `GEMINI_PRICES`.
- 2026-10-29 — Developer A — A1–A3: 75 tests. The price table has 13 rows, each with a quoted fragment; ambiguous rows were left out and listed.

- 2026-10-29 — Orchestrator — Plan, ADR-0016 and the JD-C02 scaffold are in place: contract types and stubs, the `planned.json` entry replaced by a real package, and JD-C01 depending on JD-C02.
  - Spot checks, re-fetched by the orchestrator:
    - Gemini `logPrompts` defaults to `true` (`docs/cli/telemetry.md`).
    - Codex `PROJECT_LOCAL_CONFIG_DENYLIST` includes `otel` and `notify` (`codex-rs/config/src/loader/mod.rs:89-102`).
    - `promptTokenCount` includes cached tokens (`googleapis/js-genai` `src/types.ts:3782`).
  - Blocked hosts: `docs.cloud.google.com`, `ai.google.dev` and `developers.openai.com`. `cloud.google.com/vertex-ai/generative-ai/pricing` is reachable and was saved for the price lane.
- 2026-10-29 — Owner — Decisions: Codex "Opt-in logs, allowlist"; Gemini "Price table, estimated"; Gemini "User-level opt-in"; slicing "S5b Gemini, S5c Codex".

## Log

- 2026-10-29 — `8e8c5a9` pushed after the full gate passed. CI on `8c8c864` (40858390962) and `8baec90` (40859738459): **PASS**.

## Test evidence

| Command | Exit | Duration | PASS | FAIL | SKIPPED | BLOCKED | NOT RUN | Artifacts |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| `collectors/adapters` contract test (scaffold) | 0 | 0.3 s | 2 | 0 | 0 | 0 | 0 | — |

## Decisions and deviations

- ADR-0016 (accepted). JD-C02 is renamed from the planned "otel-bridge" to `@javis-dog/collector-adapters`, which holds pure adapters only.

## Retro

- Went well:
- Hurt:
- Change next sprint:

## Guru checkpoint

G4 at the S5 release gate.
