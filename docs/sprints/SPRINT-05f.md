# Sprint 05f — Privacy classes L1/L2 (JD-M11)

- Dates: 2026-10-30 → 2026-10-31 · Status: CLOSED (code complete; owner browser and machine runs pending)
- Goal (one sentence): a project owner can turn on L1/L2 with a recovery key only they hold. javi then sends keyed hashes and encrypted repo/branch names, and the dashboard shows the names only in a browser that has the key, saying honestly what Javi's Dog can and cannot see.
- Modules touched: JD-M11 (new), JD-M01, JD-C01, JD-M04, JD-M07, JD-APP
- Readiness gate: `docs/agent-ops/READINESS_MATRIX.md` rows "L1/L2 crypto primitives", "L2 key custody", "Browser key exposure", "L1/L2 runtime"
- Test plan: `docs/agent-ops/TEST_PLAN.md` §S5f

## Global constraints

- ADR-0018 is the contract.
- WebCrypto only; no new runtime dependency.
- The secret never reaches server code, logs, SSR output or argv.
- No migration.
- Screenshot budget 0.
- Never call anything encrypted before a decryption in the browser proves it.

## Backlog

| # | Task | Module | Acceptance criteria | Status |
|---|---|---|---|---|
| K1 | `@javis-dog/crypto`: recovery key format, HKDF derivations, `kid`, L1 HMAC, L2 encrypt/decrypt with AAD | JD-M11 | QA known-answer vectors pass in Node; same code in the browser | DONE (`e1ff72c`) |
| K2 | Spec §7 wording (HMAC), `iv` exactly 12 bytes in spec, validator and ingest | JD-M01 | tests; changelog | DONE |
| K3 | `javi init --privacy`, key storage, L1/L2 fields on the named events, canary | JD-C01 | TEST_PLAN collector rows | DONE (`58c55d2`, fixes `9805ba9`) |
| K4 | Class change action, reader fields, key setup + decrypt UI, honest labels, Integrations copy | JD-M04, JD-M07, JD-APP | TEST_PLAN reader, browser, key-never-on-server and role rows | DONE (`0b2179d`, fixes `e8fb1bc`) |
| K6 | Nonce CSP for all app routes; then "Remember on this device" | JD-APP | zero CSP violations in a bounded browser run | CSP DONE (`ae27c91`); remember BLOCKED on the owner's signed-in run |
| K5 | QA vectors (`docs/jgr/conformance/privacy/`) and runner; end-to-end test | QA, all | every vector passes, mutation-checked | DONE: 153 vectors, 145 pass + 8 NOT RUN with reasons, P03/P04 pass in the web app, end-to-end test `cde4614` (lockfile `991926a`) |

## Review focus

- A recovery key pasted with a typo → refused by the checksum, never stored.
- An L2 event copied to another project → decryption fails (AAD), shown as "can't decrypt".
- A server action, log or SSR page receiving the key → must be impossible; tested with a sentinel key.
- A project lowered to L0 while collectors still send L2 → rejected events, explained on the project page and in `javi status`.

## Log

Newest first: date — what changed — commit SHA.

- 2026-10-31 — Close-out against the Guru findings:
  - **PV-F1:** test evidence completed (table below).
  - **PV-F2:** QA's reference programs `ref.mjs` and `check.py` lived in the session scratchpad, which no longer exists. The 366-check cross-check cannot be re-run, so its result stands as recorded evidence only. Next time, reference programs are committed under the suite (`docs/jgr/conformance/<suite>/reference/`).
  - **PV-F3:** cross-lane API break. The end-to-end lane's test (written on `0b2179d`) used `resolveIdentity` and the old label props, and the web fix lane's M1 change renamed and extended them. At `e8fb1bc` and `3020b10` the gate's typecheck failed, the gate blocked the push, and `29a6b8a` fixed the test. No broken commit was pushed on its own.
  - **PV-F5:** ADR-0018 decisions 4 and 6 and the TEST_PLAN padding row now point to the binding Changes.
  - **PV-F7:** end-to-end SHAs corrected.
  - **PV-F4:** the push step stays on the GitHub MCP check, per this session's tool rules (no `gh`).
  - **PV-F6:** a follow-up (gate script clears the Vitest cache; the registry generator escapes `|`).
- 2026-10-31 — Security review (0 High, 3 Medium, 9 Low) and its fixes merged: collector `9805ba9` (M3, L4, L7, L8 and env typing), web `e8fb1bc` (M1, M2, L1–L7, L9). "Remember on this device" stays off until the owner's signed-in CSP run.
- 2026-10-30 — End-to-end test merged (`javi init --privacy L2` → hook → ingest → reader → the web app's decryption): names show only with the key; another project's key and a flipped byte fail; lowering to L0 keeps the status signal and shows the rejection — test `cde4614`, lockfile `991926a`.
- 2026-10-30 — K3 collector (`58c55d2`) and K4 web (`0b2179d`) merged; K5 runner (`ee8c600`): 145 PASS, 0 FAIL, 8 NOT RUN, 38 of 38 mutations caught.
- 2026-10-30 — K5 vectors merged:
  - QA wrote 17 vectors with 153 cases, computed with two independent reference methods (Node WebCrypto; Python stdlib with `cryptography` and the OpenSSL CLI), 366 checks and 0 mismatches.
  - 14 spec gaps were resolved in ADR-0018 (G4 and G6 were real defects).
  - Developer A was told the binding rules mid-lane.
  - Spec §7 now requires HMAC and a 12-byte `iv`.
- 2026-10-30 — K6 CSP merged and pushed (`ae27c91`):
  - full gate: 2225 tests;
  - local `csp:check`: 12 of 12 routes PASS (red-first: without the nonce 1 of 12; with pages left static 8 of 12);
  - production: the header is live on `ae27c91`, and a browser load of 6 public routes gave 0 CSP violations with the Next runtime started.

  Signed-in data views were not loaded (owner).
- 2026-10-30 — Discovery, research, owner decisions, ADR-0018, TEST_PLAN §S5f, readiness rows.

## Test evidence

| Command | Exit | Duration | PASS | FAIL | SKIPPED | BLOCKED | NOT RUN | Artifacts |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| `pnpm -s test --force` after the K6 merge | 0 | — | 2225 | 0 | 0 | 0 | 0 | 15 packages |
| `pnpm --filter @javis-dog/web csp:check` (local `next start`, no DB env) | 0 | — | 12 | 0 | 0 | 0 | 0 | per-route JSON |
| Production browser load of 6 public routes (scratch script, no screenshots) | 0 | — | 6 | 0 | 0 | 0 | signed-in views | 0 violations |
| QA reference cross-check (`ref.mjs` + `check.py`) | 0 | — | 366 | 0 | 0 | 0 | 0 | scratch, not committed; cannot be re-run (PV-F2) |
| Privacy runner `pnpm --filter @javis-dog/crypto test` (`ee8c600`) | 0 | — | 232 | 0 | 8 (NOT RUN, reasons in test names) | 0 | 8 | 38 of 38 mutations caught |
| End-to-end `apps/web/test/privacy-e2e.test.tsx` (`29a6b8a`) | 0 | — | 1 | 0 | 0 | 0 | 0 | the whole chain |
| Security-review fix lanes: collector `9805ba9` / web `e8fb1bc` | 0 | — | 2685 / 555 (web) | 0 | 0 | 0 | 0 | red-first per finding |
| Final gate before `29a6b8a` | 0 | — | 2725 | 0 | 0 | 0 | 0 | 16 packages; build, drift, docs, `csp:check` 12/12, secret scan |
| CI `ae27c91`, `a0d2b08`, `e9ca110`, `ee8c600`, `0b2179d`, `991926a`, `9805ba9`, `29a6b8a` | success | — | — | — | — | — | — | runs 41133018018, 41134131598, 41135320764, 41137592015, 41141058555, 41142840509, 41144802179, 41146639862 |
| Production after `29a6b8a`: health + 6 public routes in a browser | 0 | — | 6 | 0 | 0 | 0 | signed-in views | 0 CSP violations |

## Team

| Role | Agent | Lane / paths |
|---|---|---|
| Orchestrator | Claude (this session) | ADR, merges, gate, push |
| Reviewer (design) | read-only agent | ADR-0018 before code |
| QA | worktree agent | `docs/jgr/conformance/privacy/` |
| Developers | worktree agents | per wave |

Team log, newest first:

- 2026-10-30 — Reviewer — Design review D0 of ADR-0018: 3 High (identifiers on status events, a class check that did not exist, the AAD `project_ref` ambiguity), 8 Medium, 12 Low. The orchestrator verified H1 and H2 in code. All were folded into ADR-0018 (Changes D0). Owner: add the CSP this sprint, then "Remember on this device".
- 2026-10-30 — Orchestrator — Rule 9 slip again: `b8c8e59` was pushed before CI on `c1178c0` was read. That run was green (41126438258). The shell has no GitHub API access, so no script can enforce the rule; reading CI now comes first in every push step.
- 2026-10-30 — Orchestrator — The research agent read primary texts through their source repositories (many hosts are blocked). The orchestrator re-checked three facts: the `iv` schema gap, X25519 on Node 22.22, and OWASP's PBKDF2 600 000 iterations.

## Decisions and deviations

- Owner 2026-10-30: recovery key; L1 keyed by the L2 key; repo and branch names; L1 and L2 end to end (ADR-0018).
- Owner 2026-10-30 (after the design review): add the CSP this sprint, then remember keys on the device.

## Retro

- **Went well:**
  - Four independent checks each caught a different class of defect before users could hit it:
    - the design review found identifiers on status events and a class check that didn't exist;
    - QA found byte-level gaps, including a real HMAC key-length divergence and padding that couldn't hold;
    - the security review found a row swap and keys outliving the session;
    - the end-to-end test found a typing break across packages.
  - Two reference implementations agreed on all 366 known-answer checks.
- **Hurt:**
  - Rule 9 slipped twice before it became habit.
  - One gate run broke on a shared Vitest cache while lanes ran tests in parallel.
  - A module description broke the registry table.
  - The sprint ran far past the 30-minute timebox; this was a large, security-sensitive feature split only into lanes, not into sprints.
- **Change next sprint:**
  - Clear `node_modules/.vitest-cache` before the gate when lanes are running.
  - Keep `|` and code spans out of `module.json` descriptions.
  - Split security-sensitive features into smaller sprints with their own gates.

## Guru checkpoint

`ad-hoc-privacy` (`b88a307`): 2 new skills (`client-held-key-encryption`, `nonce-csp-rollout`) and 9 updated; findings PV-F1 to PV-F7 in `guru/WISDOM_LOG.md`.
