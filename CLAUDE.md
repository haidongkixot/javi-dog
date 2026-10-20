# Javi's Dog — Agent Instructions

> **Every agent. One clear signal.** Javi's Dog is a privacy-aware observability companion for vibe coders: it turns scattered coding-agent signals (status, heartbeats, token usage) into one trustworthy operating picture.

All documentation, code comments, commit messages and specs in this repository are written in **English**.

## 0. Start of every session (mandatory)

1. Read `docs/memory/PROJECT_MEMORY.md` (current state, decisions, open questions).
2. Read the current sprint file in `docs/sprints/` and the latest entries of `docs/memory/SESSION_LOG.md`.
3. Check `docs/agent-ops/READINESS_MATRIX.md` for blockers that affect your task.
4. Before ending a session: update `PROJECT_MEMORY.md`, append to `SESSION_LOG.md`, commit and push.

## 1. Rule precedence

When instructions conflict, apply them in this order:

1. **Orcasus** rules (this file §2, `.claude/skills/project-discovery`, `.claude/skills/efficient-testing`) — source: [haidongkixot/orcasus](https://github.com/haidongkixot/orcasus) v1.2.1.
2. **Project rules** in this file and **brand rules** (`docs/brand/BRAND_GUIDE.md`, `.claude/skills/javis-dog-brand`).
3. Imported third-party skills listed in `.claude/skills/SOURCES.md`.

Example: the Orcasus screenshot budget (0 by default) overrides any imported skill that suggests screenshot-based verification.

## 2. Orcasus Agent Operating Contract (adopted)

Full text: `docs/agent-ops/ORCASUS_AGENT_OPERATING_CONTRACT.md`. Task records live in `docs/agent-ops/` (`READINESS_MATRIX.md`, `DISCOVERY_SUMMARY.md`, `TEST_PLAN.md`); ADRs live in `docs/adr/`.

For every new feature, redesign, integration, migration or material bug fix:

1. **Discover before designing.** Invoke `/project-discovery`. Inspect repo, stack, assets, integrations, tests, environments, credentials (names/presence only — never values), permissions and budget.
2. **Keep a readiness record** in `docs/agent-ops/READINESS_MATRIX.md`. AVAILABLE needs evidence; UNKNOWN is not AVAILABLE.
3. **Stop at real blockers.** Report BLOCKED, give 2–3 options with trade-offs and a recommendation, continue only independent reversible work. Never silently substitute or degrade.
4. **Approve before risky implementation.** Record significant decisions as ADRs (`docs/adr/`, MADR format). No major dependencies, costs, permission expansion or production changes without authorization.
5. **Plan tests before implementing.** Invoke `/efficient-testing`; write/refresh `docs/agent-ops/TEST_PLAN.md`. Lowest-cost reliable layer first.
6. **No screenshot-first testing.** Screenshot budget is **0** by default. Never use AI-generated imagery as evidence.
7. **Bound visual artifacts** (question, matrix, max count, output path, retention) before any visual run.
8. **Diagnose before retry.** No blind reruns, no skipped tests, no softened assertions, no snapshot updates just to go green.
9. **Verify resources at runtime**; if an assumption fails, update the readiness matrix and return to the owner.
10. **Report truthfully** with commands, exit codes, counts and gaps. PASS / FAIL / BLOCKED / NOT RUN / SKIPPED are distinct.

Stop conditions: missing credentials/accounts/permissions; conflicting requirements or material quality/cost/security trade-off; a workaround that changes product behavior, data fidelity or supported platforms; a test environment that cannot validate the claim; a visual test without a question and budget.

## 3. Product rules (from the brand's UX principles)

These are acceptance criteria for every UI, API and email change:

1. **Signal before spectacle** — critical status (health, attention, capacity) is visible within a ~3-second scan without hunting.
2. **Live means verified** — every "live" value shows its source, last heartbeat/update time and a stale state. Never label data live without a fresh signal.
3. **Privacy by minimization** — default JGR payloads carry operational metadata only. No prompts, source code or secrets unless the user opts into a stronger privacy class.
4. **No mock masquerading as product** — any surface without a real backend must say so (demo banner / toast pattern). Sample data is always labelled as sample.

Voice: attentive, smart, playful, trustworthy. Be warm, brief and concrete. **Never call a connection live, encrypted or secure until runtime evidence proves it.** Avoid hype, alarm fatigue, cartoon overload and false certainty. See `docs/brand/BRAND_GUIDE.md`.

The **Token network / Pack Pool** space is **CONCEPT ONLY**. Never build credential sharing, raw-key lending or token transfer between users. Research is gated by ADR + legal review (readiness item B7).

## 4. Architecture rules

- Modular monolith: pnpm workspace + Turborepo, deployed to Vercel. See `docs/adr/0001-modular-monolith.md` and `docs/adr/0002-technology-stack.md`.
- Every module is a package with a `module.json` (`id`, `name`, `version`, `status`, `provides`, `consumes`). Module IDs: `JD-APP`, `JD-M01`…`JD-M13`, `JD-C01`…`JD-C03`. Registry: `docs/modules/REGISTRY.md` (generated — run `pnpm modules:registry`).
- Modules import each other **only** through their public `src/index.ts`. Never deep-import another module's internals.
- A module's public contract changes require a changeset (`pnpm changeset`) and a docs update in the same commit.
- Reference modules and decisions by ID in commits and docs (e.g. `feat(JD-M05): ...`, "see ADR-0004").

## 5. Documentation = second memory

Docs-as-code, organized by Diátaxis (`docs/tutorials`, `docs/how-to`, `docs/reference`, `docs/explanation`) plus:

| Path | Purpose |
|---|---|
| `docs/memory/PROJECT_MEMORY.md` | Single source of current state; keep it short and current |
| `docs/memory/SESSION_LOG.md` | Append-only handoff log, newest first |
| `docs/sprints/SPRINT-NN.md` | Sprint goal, backlog, log, test evidence, retro |
| `docs/adr/` | Architecture decisions (MADR) |
| `docs/agent-ops/` | Orcasus readiness/discovery/test records |
| `docs/jgr/` | Javi Grande Rules protocol: research, spec versions, conformance |
| `docs/brand/` | Brand guide and archived source assets |
| `guru/` | Javi's Guru output: generalized, reusable skills |

Rules: update docs in the same commit as the code they describe; write facts with evidence, label hypotheses as hypotheses; never paste secret values.

## 6. Git workflow

- Conventional Commits with module scope: `feat(JD-M13): add StatusPill`, `docs(adr): ADR-0004 realtime transport`.
- Commit after every coherent unit of work; push frequently to the working branch.
- Never commit secrets, `.env*` files (except `.env.example`), screenshots or transient test artifacts.

## 7. Javi's Guru checkpoints

Invoke the `javi-guru` agent (or `/guru-checkpoint`) at: sprint start, architecture/protocol decisions, feature/test completion, incident review, sprint end, pre-release. Guru output goes to `guru/`; candidate skills for Orcasus are proposed via PR only at G2 and G4, after owner review.

## 8. Commands

```bash
pnpm install          # install workspace dependencies
pnpm lint             # ESLint across workspace
pnpm typecheck        # tsc --noEmit across workspace
pnpm test             # Vitest across workspace
pnpm build            # Turborepo build
pnpm docs:check       # markdownlint + module registry + doc-drift checks
pnpm modules:registry # regenerate docs/modules/REGISTRY.md
```
