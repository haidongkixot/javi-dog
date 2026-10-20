# Javi's Dog — Brand Guide

> Status: **Concept 0.1** · Source of truth for UI, copy, email and docs styling.
> Sources: [`source/javis-dog-creative-proposal-concept-0.1.pdf`](source/javis-dog-creative-proposal-concept-0.1.pdf) (14 slides, dated 21 October 2026) and [`source/javis-dog-design-template-concept-0.1.html`](source/javis-dog-design-template-concept-0.1.html) (interactive prototype). Provenance and open items: [`PROVENANCE.md`](PROVENANCE.md). Decision record: [ADR-0003](../adr/0003-brand-to-design-tokens.md).

## 1. Identity

| Item | Value |
|---|---|
| Name | **Javi's Dog** (always with the apostrophe; repository slug `javi-dog`) |
| Descriptor | AGENT OBSERVABILITY |
| Tagline | **Every agent. One clear signal.** |
| Mascot | *The Signal Hound*: a friendly dog face with alert ears, signal-dot eyes (mint), a coral nose, set on a mint tile |
| Positioning | For vibe coders who run multiple AI agents, Javi's Dog is the observability companion that turns fragmented execution signals into one clear operating picture. Unlike a task board, it watches the runtime signals beneath the work. |
| Core idea | *A companion, not another control panel.* The dog stands for alertness and loyalty; the product earns trust through data fidelity, privacy boundaries and evidence. |

### Audiences

| Audience | Need |
|---|---|
| Solo vibe coders | See agent status, context and spend without juggling tabs |
| Technical founders | Project health and visibility into resource risk |
| Small dev teams | Comparable signals across coding environments |
| Future contributors | May coordinate compliant capacity/credits — only after policy and economics are validated |

### The problem we name

1. **Hidden execution state** — is the agent working, waiting, looping or already failed?
2. **Invisible resource burn** — token and context limits can interrupt long-running work.
3. **Fragmented evidence** — the story is scattered across IDEs, terminals and Git history.

### Product promise — three jobs

| Job | Meaning | Signals |
|---|---|---|
| **Observe** | See every project, thread and agent in one place | Status · Heartbeat · Event timeline |
| **Understand** | Make resource consumption and failure patterns explainable | Token deltas · Retries · Budget guardrails |
| **Keep the flow** | Spot attention needs early and coordinate next steps | Stale-run alerts · Safe interventions · Future pool |

**MVP promise:** a trustworthy operating picture — *not* an unverified promise of autonomous orchestration.

## 2. Voice & personality

*Serious signals. Human language.*

| Trait | Means |
|---|---|
| Attentive | Notices drift and missing signals |
| Smart | Explains what happened, with evidence |
| Playful | Makes complex operations feel approachable |
| Trustworthy | Labels uncertainty and stale data honestly |

**Do:** be warm, brief and concrete. Use the *pack* metaphor sparingly and consistently (Pack health, your pack, Agent squad, Pack Pool).

**Voice examples**

- "Your pack is in motion."
- "One thread needs your attention."
- "Connection not verified yet."

**Never** call a connection *live*, *encrypted* or *secure* until runtime evidence proves it.

**Avoid:** hype, alarm fatigue, cartoon overload and false certainty.

### Copy patterns

| Situation | Pattern | Example |
|---|---|---|
| Healthy | Calm statement | "Your pack is in motion." |
| Needs attention | Count + object + ask | "One thread needs your attention." |
| Unverified / stale | Name the uncertainty | "Connection not verified yet." · "Last heartbeat 6 min ago — this agent may be stale." |
| No backend yet | Disclose plainly | "Preview only: this action is not connected to a backend yet." |
| Sample data | Label in place | "Illustrative sample data" · "(sample)" |
| Targets vs facts | Say which | "Initial design goal, not a measured SLA." |

## 3. Color

### Brand palette

| Token | Name | Hex | Role |
|---|---|---|---|
| `pack-night` | Pack Night | `#252347` | Ink, sidebar, dark surfaces, primary text |
| `signal-violet` | Signal Violet | `#6E62F6` | Primary action, focus, protocol/draft accents, primary chart series |
| `good-signal-mint` | Good Signal Mint | `#A0EBC2` | Brand tile, healthy signal, output series, active-nav marker |
| `alert-coral` | Alert Coral | `#FF907E` | Attention, failures/retries, the mascot's nose |
| `focus-yellow` | Focus Yellow | `#FFE18C` | Budget/threshold warnings, highlights |
| `clear-sky` | Clear Sky | `#91DEF3` | Informational, completed tasks, neutral data series |

### Neutrals and soft tints (from the template)

| Token | Hex | Use |
|---|---|---|
| `paper` | `#F6F7FB` | App background |
| `white` | `#FFFFFF` | Cards, topbar |
| `line` | `#E9EAF2` | Borders, dividers |
| `muted` | `#7D7D97` | Secondary text — **see accessibility note** |
| `muted-2` | `#A4A5BA` | Decorative/disabled only (2.42:1, never body text) |
| `violet-soft` | `#EFEDFF` | Violet tint surfaces |
| `mint-deep` | `#198F62` | Positive deltas |
| `coral-soft` | `#FFF0ED` | Coral tint surfaces |
| `yellow-soft` | `#FFF8DF` | Yellow tint surfaces |
| `sky-soft` | `#EAFAFF` | Sky tint surfaces |

Sidebar (on Pack Night): hover `#302E53`, active `#46416E` with an inset 3px mint bar, border `#42405F`, nav text `#BFBED4`, labels `#8987AA`.

### Status colors

Status is always **pill + text label**, never color alone.

| Status | Meaning | Background | Text (template) | Text (AA token) |
|---|---|---|---|---|
| `green` | On track / working / passed | `#E8F9EF` | `#25875F` | `#227D58` |
| `yellow` | At risk / needs review / threshold | `#FFF7DC` | `#AD841E` | `#8C6B18` |
| `red` | Blocked / failed | `#FFF0ED` | `#CE6558` | `#BC4637` |
| `blue` | Planning / idle / info | `#E9F9FF` | `#2186A0` | `#1E788F` |
| `violet` | Protocol / draft / proposed | `#EEECFF` | `#6B5DF0` | `#6051EF` |

### Accessibility rules (measured, WCAG 2.1 AA)

Measured contrast of the template's values (normal text needs ≥ 4.5:1):

| Pair | Ratio | Result |
|---|---|---|
| Pack Night on white / paper | 14.89 / 13.91 | PASS |
| Muted `#7D7D97` on white / paper | 4.00 / 3.73 | **FAIL** |
| Status pill texts on their tints | 3.21–4.08 | **FAIL** |
| White on Signal Violet `#6E62F6` | 4.43 | **FAIL** (passes large text ≥ 3:1) |
| Mint / Yellow / Sky / Coral on white | 1.28–2.20 | **FAIL** — never use as text on light |
| Pack Night on Mint / Yellow / Sky / Coral | 6.77–11.63 | PASS |
| Mint / Yellow / white on Pack Night | 10.75–14.89 | PASS |

Rules adopted for the design system:

1. **Brand hues are unchanged.** Only *text* tokens are darkened, by the smallest same-hue step that reaches ≥ 4.6:1 on both their tint and white (column "AA token" above; `muted-text` = `#6E6E8A`).
2. Primary button background is `#6A5DF6` (4.66:1 with white; visually indistinguishable from Signal Violet); hover `#5C50E7` (5.59:1).
3. Pastels (mint, yellow, sky, coral) are **fills**, never text on light surfaces. On pastel fills, text is Pack Night.
4. Minimum type size in the product: **12px** for body/table text, **11px** for uppercase labels. The prototype's 9–10px text is treated as a density sketch, not a spec.
5. These rules are enforced by a unit test in `packages/ui` (`JD-M13`) that checks every declared text/background pair.

> Owner decision recorded as READINESS item **D1**: adopt AA text tokens (recommended) vs. keep exact template text colors. Default until decided: AA tokens.

## 4. Typography

- **Inter** (SIL Open Font License), self-hosted via `next/font`. Fallback: `ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`.
- Headlines: bold (780–830 weight in the prototype → use 700/800), negative letter-spacing (≈ −0.04em at display sizes).
- **Metrics:** `font-variant-numeric: tabular-nums`.
- **IDs, sequences, endpoints, hashes:** monospace (`ui-monospace, SFMono-Regular, Menlo, monospace`).
- Eyebrows/labels: uppercase, letter-spacing ≈ 0.14em, weight 800, Signal Violet (on light) or Mint (on dark).

| Role | Size / weight |
|---|---|
| Page title (h1) | 29px / 800, −1.15px tracking (24px on mobile) |
| Metric value | 29px / 800, tabular |
| Card title | 14px / 800 |
| Body / table | 12–13px / 400–600 |
| Label / eyebrow | 11px / 800 uppercase |

## 5. Shape, space, elevation

- Cards: radius **16–20px** (default 18px), 1px border `#EBECF3`, shadow `0 8px 30px rgba(37,35,71,.045)` — restrained.
- Controls: radius 11px; small controls 8–9px; pills 7px; brand tile ~33% of its size.
- Spacing rhythm: **4 / 8px** multiples.
- Layout: sidebar 238px (210px ≤ 1150px, 65px icon rail ≤ 850px), content max-width 1600px, gutters 34 / 22 / 15 / 12px at the template's breakpoints **1150 / 850 / 560px**.

## 6. Logo

Files in `apps/web/public/brand/` (all **concept 0.1, trademark clearance pending**):

| File | Use |
|---|---|
| `javis-dog-mark.svg` | Dog mark on its own |
| `javis-dog-tile.svg` | App icon / favicon / avatar |
| `javis-dog-lockup-on-dark.svg` | Tile + wordmark + descriptor on Pack Night |
| `javis-dog-lockup-on-light.svg` | Tile + wordmark + descriptor on light |

Rules: keep the mint tile behind the mark at small sizes; minimum tile size 24px; clear space ≥ 25% of the tile; do not recolor, rotate, add effects, or animate beyond a subtle signal pulse. The prototype's mark uses `#282347`; it is normalized to Pack Night `#252347`.

## 7. UX principles (product acceptance criteria)

1. **Signal before spectacle** — critical status is visible without hunting (3-second scan).
2. **Live means verified** — show source, last heartbeat and stale state.
3. **Privacy by minimization** — no prompt or source code in the default payload.
4. **No mock masquerading as product** — actions disclose when a backend is absent.

*Playful outside. Precise where it counts:* the UI feels welcoming without sacrificing scannability during a failure or a quota spike.

## 8. Information architecture

*Five core spaces. One product story.* Daily loop: scan health → inspect a project → diagnose a thread → manage limits → configure the signal contract.

| # | Space | Question it answers | Sidebar group |
|---|---|---|---|
| 01 | Overview | What is happening now? | WORKSPACE |
| 02 | Projects | Where is risk building? | WORKSPACE |
| 03 | Live agents | Why is this thread stuck? | WORKSPACE |
| 04 | Token network | How might capacity be coordinated? — **CONCEPT ONLY** | WORKSPACE |
| 05 | JGR & Integrations | Can I trust the incoming signal? | CONTROL PLANE |

Navigation stays simple; complexity appears only on drill-down into a project, thread, usage or event. Drill-downs always retain event provenance and freshness.

**Hero screen — the Pack Dashboard:** four KPI cards (Active projects, Agents running *n / capacity*, Token burn rate, Tasks completed), Token consumption chart (input / output / failed-retry series) + Live activity list, Project health table + Agent squad list. Design intent: 3-second scan for health, capacity and attention.

### Component inventory (from the template)

Sidebar (brand, workspace switcher, nav with counts, pack-health mini-status, profile) · Topbar (breadcrumb, environment label, search, notifications, primary action) · DemoBanner · PageHead (eyebrow, title, description, actions) · MetricCard (icon, value, delta, decorative corner) · Card + CardHead · StatusPill · Legend + TokenChart · LiveActivityList · DataTable · ProjectCell · AgentRow · ThreadList / ThreadRow · ThreadInspector (hero, KPIs, EventTimeline) · TokenBanner (concept) · RuleList · IntegrationRow · EndpointBlock · PolicyToggle · ProgressBar · Toast.

## 9. Token network / Pack Pool (concept boundary)

Shown as "PHASE 2 · NOT LIVE". Safety principles that must be true before any launch:

1. Never lend raw provider keys — credentials stay with their owner and approved provider.
2. Check terms and legal feasibility — provider limits may not be transferable.
3. Use explicit quotas and revocation — caps, expiry, audit trails and a kill switch.
4. Measure value before tokenization — model a credit abstraction only after unit economics are validated.

## 10. JGR presentation

JGR is *the shared language beneath the UI*: Coding tool → JGR adapter → Ingress (auth · validate · dedupe) → State + metrics → Dashboard. Draft envelope fields: `event_id · protocol_version · producer_id · project_ref · thread_ref · agent_ref · sequence · status · occurred_at · usage_delta · privacy_class`. Delivery targets **p95 < 2s** and **payload < 4 KB** are hypotheses until measured under a defined load.

## 11. References

The proposal cites monday.com product positioning and design guidance as *inspiration for approachable work software*. Javi's Dog keeps its own original voice and visual grammar; do not copy third-party assets, layouts or copy.
