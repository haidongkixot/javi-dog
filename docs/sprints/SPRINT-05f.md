# Sprint 05f — Privacy classes L1/L2 (JD-M11)

- Dates: 2026-10-30 → · Status: ACTIVE
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
| K1 | `@javis-dog/crypto`: recovery key format, HKDF derivations, `kid`, L1 HMAC, L2 encrypt/decrypt with AAD | JD-M11 | QA known-answer vectors pass in Node; same code in the browser | PLANNED |
| K2 | Spec §7 wording (HMAC), `iv` exactly 12 bytes in spec, validator and ingest | JD-M01 | tests; changelog | PLANNED |
| K3 | `javi init --privacy`, key storage, L1/L2 fields on the named events, canary | JD-C01 | TEST_PLAN collector rows | PLANNED |
| K4 | Class change action, reader fields, key setup + decrypt UI, honest labels, Integrations copy | JD-M04, JD-M07, JD-APP | TEST_PLAN reader, browser, key-never-on-server and role rows | PLANNED |
| K6 | Nonce CSP for all app routes; then "Remember on this device" | JD-APP | zero CSP violations in a bounded browser run | PLANNED |
| K5 | QA vectors (`docs/jgr/conformance/privacy/`) and runner; end-to-end test | QA, all | every vector passes, mutation-checked | PLANNED |

## Review focus

- A recovery key pasted with a typo → refused by the checksum, never stored.
- An L2 event copied to another project → decryption fails (AAD), shown as "can't decrypt".
- A server action, log or SSR page receiving the key → must be impossible; tested with a sentinel key.
- A project lowered to L0 while collectors still send L2 → rejected events, explained on the project page and in `javi status`.

## Log

Newest first: date — what changed — commit SHA.

- 2026-10-30 — Discovery, research, owner decisions, ADR-0018, TEST_PLAN §S5f, readiness rows.

## Test evidence

| Command | Exit | Duration | PASS | FAIL | SKIPPED | BLOCKED | NOT RUN | Artifacts |
|---|---:|---:|---:|---:|---:|---:|---:|---|

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

- Went well:
- Hurt:
- Change next sprint:

## Guru checkpoint

—
