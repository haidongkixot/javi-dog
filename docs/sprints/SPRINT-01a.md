# Sprint 01a — Brand shell & registry

- Dates: 2026-10-20, 18:51 → 19:00 UTC (timebox 30 min) · Status: **CLOSED**
- Goal: a brand-true five-space app shell with honest empty / not-connected states, plus the draft project registry model.
- Modules touched: JD-M13, JD-APP, JD-M04 (new)
- Split: roadmap S1 = S1a (this) + S1b (JGR research + spec v0.1, JD-M01) — owner's 30-minute timebox.

## Global constraints

- Brand Concept 0.1; semantic tokens only (no raw hex); text ≥ 11px; AA contrast via JD-M13 tokens (D1 accepted).
- Product rule 4: no sample data in the shell. Missing values render "No signal yet", never zero.
- Token network stays CONCEPT ONLY.

## Backlog

| # | Task | Module | Acceptance criteria | Status |
|---|---|---|---|---|
| 1 | Components ported from the template | JD-M13 | StatusPill, DemoBanner, PageHead, Card, CardHead, MetricCard, EmptyState, RuleList, EndpointBlock, Icon, BrandTile; Tailwind theme exported as `theme.css` | Done |
| 2 | Five-space shell: sidebar (WORKSPACE / CONTROL PLANE), topbar breadcrumb, global disclosure | JD-APP | 5 routes build statically; active link has `aria-current`; responsive at 1150/850px | Done |
| 3 | Honest states on every page | JD-APP | No numbers without a signal; integrations say "Connection not verified yet." | Done |
| 4 | Draft project schema | JD-M04 | Zod input/stored schemas, slug rules (Vietnamese-safe), L0 default, https-GitHub-only repo URL | Done |
| 5 | Vercel project (B2, rolled over from S0) | — | Project linked | **BLOCKED** — owner creates via dashboard |

## Review focus

- A Vietnamese project name with diacritics must produce a readable slug → covered (`Đồ án Vibe Coding` → `do-an-vibe-coding`).
- A name made only of symbols must not create an empty slug → covered (rejected).
- At 850px the sidebar collapses to an icon rail; labels stay available to screen readers (`sr-only`) — verified in code, not visually (screenshot budget 0).
- Primary "Create project" button is visibly disabled and explains why (`aria-describedby`).

## Log

- 18:51 — Sprint start.
- Components + `theme.css` moved into JD-M13; apps import tokens + theme.
- Shell, five pages, tests; JD-M04 schema + tests.
- Found and fixed: Vitest 5 rejects `esbuild.jsx` in config (typecheck error, removed; automatic JSX is the default); two 10px labels raised to the 11px brand minimum.
- 19:00 — Sprint closed (≈ 9 minutes).

## Test evidence

Fresh run after clearing `.turbo` and `.next` (Node 22.22.0):

| Command | Exit | Duration | PASS | FAIL | SKIPPED | BLOCKED | NOT RUN | Artifacts |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| `pnpm format:check` | 0 | 1.4s | all files | 0 | — | — | — | none |
| `pnpm lint` | 0 | 4.0s | 3 packages + scripts | 0 | — | — | — | none |
| `pnpm typecheck` | 0 | 4.2s | 3 packages | 0 | — | — | — | none |
| `pnpm test` | 0 | 3.3s | 62 (ui 33 · web 17 · projects 12) | 0 | 0 | 0 | — | none |
| `pnpm build` | 0 | 10.4s | 5 static routes + icon | 0 | — | — | — | `.next/` (gitignored) |
| `pnpm docs:check` | 0 | 3.1s | lint, links, registry, tokens | 0 | doc-drift (no `main`) | — | — | none |
| Built-HTML assertions (all 5 routes) | 0 | — | disclosure ×1 each; 5 nav targets; "Concept only" badge; KPI "No signal yet" on Overview/Agents | 0 | — | — | — | none |

Screenshots / traces / videos: **0 / 0 / 0**. NOT RUN: E2E (no user journey with data yet); visual comparison with the template (no approved visual question).

## Decisions and deviations

- Tailwind theme mapping moved from `apps/web` into JD-M13 (`@javis-dog/ui/theme.css`) so every consumer shares one mapping.
- Template's illustrative numbers (sample projects, agents, pool capacity) intentionally **not** ported — they would violate product rule 4 in a real app.
- Template privacy toggles rendered as a read-only "planned defaults" list (toggles without a backend would be a mock).
- Radix/shadcn not added yet: no interactive primitive (dialog, menu) needed so far.

## Retro

- Went well: the typecheck gate caught a config option the test runner silently ignored.
- Hurt: nothing blocking; B2 still needs the owner.
- Change next: S1b is research-heavy — keep the spec small (v0.1) and test vectors executable.

## Guru checkpoint

None planned (G1 follows S1b, the protocol decision).
