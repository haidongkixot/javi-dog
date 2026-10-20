# Risk-Based Test Plan — Sprint 0 (Foundations)

> Orcasus template v1.2.1. Default screenshot budget: **0**.

## 1. Change and acceptance criteria

- Feature / change: repository bootstrap — agent-ops docs, brand guide, monorepo scaffold, design tokens (JD-M13), minimal web app shell (JD-APP), CI, docs checks, Guru agent.
- Owner: Hai (project owner); implementer: Claude.
- Risk level: LOW (no user data, no external integrations, no production resources).
- Primary user journeys: none user-facing yet; developer journey "clone → install → lint/typecheck/test/build → docs:check" must pass.
- In-scope platforms: Node 22 on Linux (CI: GitHub Actions `ubuntu-latest`).
- Out of scope: auth, database, ingest, deployments.
- Existing test runner/config: none before S0 (empty repository).

## 2. Test selection matrix

| Requirement / acceptance criterion | Risk | Lowest-cost reliable layer | Test case / assertion | Higher-cost test needed? | Result |
|---|---|---|---|---|---|
| Design tokens mirror the brand palette exactly | Medium | Unit | Each brand hex in `tokens.ts` equals the BRAND_GUIDE value | No | see SPRINT-00 |
| Every declared text/background pair meets WCAG AA (≥ 4.5:1) | Medium | Unit | Contrast function over all `textPairs` | No | see SPRINT-00 |
| Generated `tokens.css` is in sync with `tokens.ts` | Low | Static (script `--check`) | Re-generate and diff | No | see SPRINT-00 |
| Contrast math is correct | Low | Unit | Known pairs: black/white = 21, white/white = 1 | No | see SPRINT-00 |
| Web app compiles and renders a page that discloses no backend is connected | Medium | Static (`next build`) | Build succeeds; page source contains the demo-banner disclosure | E2E not needed in S0 | see SPRINT-00 |
| Module registry is current | Low | Static (`modules:registry --check`) | Generated registry equals committed file | No | see SPRINT-00 |
| Markdown is well-formed and internal links resolve | Low | Static (markdownlint, link check script) | No errors | No | see SPRINT-00 |
| Lint + typecheck clean | Low | Static | `pnpm lint`, `pnpm typecheck` exit 0 | No | see SPRINT-00 |

## 3. Visual/screenshot authorization

- Is visual verification necessary? **NO** (no visual question in S0).
- Maximum screenshots: 0. Capture policy: NONE.

## 4. Resource and access check

| Resource | Required? | Available? | Evidence |
|---|---|---|---|
| Node 22 + pnpm | Yes | Yes | shell |
| npm registry | Yes | Yes | `npm view` succeeded |
| Browser / device | No | — | — |
| Credentials / third-party services | No | — | — |

## 5. Execution sequence

1. `pnpm lint` and `pnpm typecheck`
2. `pnpm test` (JD-M13 unit tests)
3. `pnpm build`
4. `pnpm docs:check`

## 6. Failure policy

Preserve the first failure output, diagnose before retrying, never weaken assertions.

## 7. Results and evidence

Recorded in `docs/sprints/SPRINT-00.md` §Test evidence.
