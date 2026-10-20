---
name: honest-empty-states
description: Build dashboards, admin consoles and app shells before real data or a backend exists without faking anything — missing values render as "No signal yet" (never 0 or a sample number), a global disclosure banner says what is not connected, planned features are labelled planned or concept-only, actions that cannot work yet are visibly disabled with a reason, design targets are labelled as hypotheses, and static guard tests (no sample numbers in rendered text, no raw color literals) are proven able to fail. Use when porting a design mockup or template with illustrative numbers into a real app, building a UI shell ahead of the API, writing empty, loading, not-connected or demo states, reviewing copy that says live, connected, secure or encrypted, or adding tests that keep mock data out of production UI.
metadata:
  version: "0.1.0"
  origin: "javis-dog G1"
  confidence: medium
---

# Honest empty states

Design templates are full of illustrative numbers: 12 active projects, 67% capacity, 4.8K tokens per second. Ported into a real app before the backend exists, those numbers become claims the product cannot back. Users screenshot them, stakeholders quote them, and the first real (smaller) number looks like a regression. A shell built before data exists should look finished *and* tell the truth.

The rule: **no value without a source; anything not real says so on the surface where it appears.**

## 1. Strip illustrative data when porting a template

Inventory every number, name, chart and list in the mockup and classify it:

| Kind | In the shipped shell |
|---|---|
| Layout, labels, column headers, icons | Keep |
| Illustrative values (counts, rates, percentages, names of fake projects or agents) | Remove; render the empty state |
| Interactive controls with no backend (toggles, create buttons) | Read-only list of "planned defaults", or a disabled control with a reason |
| Design targets (latency, payload size) | Keep only labelled as targets or hypotheses |

Record the removal as a decision in the iteration record so nobody "restores the missing data" from the mockup later.

## 2. Make "missing" a first-class value

- Model missing as `null` (or `None`, `nil`, an `Option`), never as `0`. A zero claims a measurement that never happened.
- The metric component renders a placeholder glyph plus a fixed phrase ("No signal yet") when the value is missing, and **suppresses the secondary line** too: "67% capacity" under an empty value is still a fake.
- Persisted models keep "last signal at" nullable, and only the trusted ingest path sets it — never the client.
- Each empty panel says what will fill it and what triggers that ("Agents appear when a coding tool sends its first heartbeat"), and links to the next real step when one exists.

## 3. Disclose at three levels

1. **Global:** a persistent banner in the layout, announced as a status region: "Preview build. No projects, agents or backend are connected yet. Values appear only after a verified signal arrives." Plus a short status in the top bar ("Preview build · no backend").
2. **Per item:** every integration or connection shows its real state ("Planned · Sprint 3", "Connection not verified yet"), not a green "Connected".
3. **Per concept:** spaces that are research-only carry a "Concept only" badge in navigation and on the page, and state the safety boundary in plain words.

Never call something live, connected, encrypted or secure until runtime evidence proves it. Copy describing planned capabilities must match the current spec version; see Pitfalls.

## 4. Disable actions honestly

A primary action that cannot work yet stays visible (users learn the product's shape) but:

- is visibly disabled and announced as disabled (`aria-disabled="true"` or the native `disabled` attribute), and
- points to a visible reason via `aria-describedby` ("Creating projects needs sign-in, which arrives in Sprint 2").

With `aria-disabled` alone the control is still focusable and clickable, so do not attach a handler that pretends to work.

## 5. Enforce it with cheap tests, then prove the tests can fail

Lowest-cost layers first; no screenshots needed:

- **Component tests:** the metric component with `value = null` renders the placeholder phrase, renders no `0`, and hides the secondary line; with a value it renders value, unit and meta.
- **Page tests:** every KPI on the overview renders the placeholder phrase (assert the exact count); the nav marks concept-only spaces; the connection indicator never says connected.
- **Built-output assertions:** after a static build, scan the rendered HTML of every route for the disclosure banner, the badges and the absence of sample-looking numbers.
- **Static brand guard:** UI source contains no raw color literals (semantic tokens only).

**A guard regex is code; test it.** In the origin, both static guards passed while being weaker than their names:

- The "no sample numbers" pattern ended with a word boundary after the unit alternation. After `%` (a non-word character) that boundary only matches when a letter or digit follows, so `67%` and `67% capacity` were never matched. The component test caught the fake separately; the page-level guard would not have.
- The "no raw hex" pattern matched 3- and 6-digit hex only; `#rrggbbaa`, `#rgba` and `rgb()`/`oklch()` literals passed.

Ship each pattern with must-match and must-not-match probes and run them before the scan. Template: [`templates/honesty-guards.mjs`](templates/honesty-guards.mjs) (`--self-test`, `html <dir>`, `colors <dir>`). Its first run on the origin's built HTML produced one false positive ("03" step number before a "Token deltas" title), fixed by making word units case-sensitive and adding that string as a must-not-match probe. Expect to tune the unit list and allowlist for your product.

## 6. Label targets and estimates

- Performance and size goals appear under a heading such as "Design goals, not measured SLAs" with "hypotheses until load-tested".
- Any value that is estimated rather than measured carries an "estimated" label in data (a boolean on the record) and in the UI.

## Pitfalls

- **Zero as default.** Database defaults, `?? 0` and empty-array sums all produce confident zeros. Grep for them in data-to-UI mappers.
- **Secondary text survives.** Trend lines, deltas and "vs. yesterday" captions under an empty value.
- **Toggles without a backend.** A switch that flips but persists nothing is a mock; render the planned defaults read-only.
- **Copy ahead of the spec.** The origin's integration directory described a "Signed event ingestion endpoint" while the protocol draft had bearer tokens only and signing planned for the next version. Review capability copy whenever the spec changes.
- **Visual-only verification.** Responsive collapse and screen-reader labels can be checked in code and built HTML; record them as "verified in code, not visually" rather than taking screenshots by default.

## Evidence from origin project

Javi's Dog, Sprint 1a (2026-10-20), commit `0235df1`. Confidence **medium**: the pattern was implemented and tested once; user-facing effects are not yet observed (no users, nothing deployed).

- Components: `packages/ui/src/components/primitives.tsx` — `MetricCard` (`value: string | null`, "No signal yet", meta suppressed), `DemoBanner` (`role="status"`), `EmptyState`, `StatusPill` (text label, not color alone).
- Shell and pages: `apps/web/src/app/layout.tsx` (global banner), `apps/web/src/components/topbar.tsx` ("Preview build · no backend"), `apps/web/src/app/projects/page.tsx` (disabled "Create project" with `aria-describedby`), `apps/web/src/app/integrations/page.tsx` ("Connection not verified yet", "Design goals, not measured SLAs"), token-network page with "Concept only".
- Data model: `packages/projects/src/schema.ts` — `lastSignalAt` nullable, "set only by a verified signal"; test in `packages/projects/test/schema.test.ts`.
- Tests: `packages/ui/test/components.test.tsx`, `apps/web/test/shell.test.tsx`, `apps/web/test/brand-static.test.ts`. Recorded: `pnpm test` exit 0, 62 passed (ui 33, web 17, projects 12); built-HTML assertions on all 5 routes (disclosure once each, "Concept only" badge, KPI "No signal yet"); screenshots 0 (`docs/sprints/SPRINT-01a.md`). GitHub Actions CI succeeded on `0235df1` (`gh run list`, read at G1).
- Decision: template's illustrative numbers and privacy toggles intentionally not ported (`docs/sprints/SPRINT-01a.md`, Decisions).
- G1 probes (read-only, Node 22.22.0, 2026-10-20): the origin's sample-number regex returned no match for `67%` and `67% capacity`; the origin's hex regex returned no match for `#7c5cff80` and `#ffff`. `templates/honesty-guards.mjs`: self-test PASS; `html` scan of the 7 built pages 0 findings after the case-sensitivity fix; `colors` scan of the app and component sources 0 findings; scratch negative fixtures exit 1 with the expected findings.
- Hypotheses: that honest empty states improve user trust or reduce support questions — not measured; the origin has no users yet.
