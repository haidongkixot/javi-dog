---
name: javis-dog-brand
description: Apply the Javi's Dog brand (Concept 0.1) to any UI, copy, email, docs page, chart or asset. Use whenever you build or review a screen or component in apps/web or packages/ui, write user-facing text (labels, empty states, errors, toasts, emails), pick colors or type, design a chart, or produce a logo/OG/marketing asset — even if the request does not mention the brand.
---

# Javi's Dog brand

The brand is a product contract, not decoration: Javi's Dog earns trust through data fidelity, privacy boundaries and evidence. Source of truth: `docs/brand/BRAND_GUIDE.md` (read the relevant section before non-trivial work). Tokens: `packages/ui/src/tokens.ts` → `@javis-dog/ui/tokens.css` → Tailwind utilities in `apps/web/src/app/globals.css`.

## Before you start

1. Identify which of the five spaces the work belongs to (Overview, Projects, Live agents, Token network — concept only, JGR & Integrations) and the question that space answers (BRAND_GUIDE §8).
2. Check whether a real backend exists for what you are showing. If not, the surface must disclose it (DemoBanner / toast pattern).

## Visual rules

- Colors: semantic utilities only (`text-ink`, `text-muted`, `bg-surface`, `border-line`, `bg-ok-bg text-ok`, `bg-primary text-on-primary`…). No raw hex in components.
- Pastels (mint, yellow, sky, coral) are fills; text on them is Pack Night. Never pastel text on light surfaces.
- Status = pill + text label (`ok`, `warn`, `danger`, `info`, `protocol`); never color alone.
- Inter; headings bold with tight tracking; numbers `tabular-nums`; IDs/sequences/endpoints monospace.
- Minimum sizes: 12px body/table, 11px uppercase labels.
- Cards: `rounded-card` (18px), `border-line-card`, `shadow-card`. Controls `rounded-control`. 4/8px spacing rhythm.
- Light theme only (decision D2). Put new colors in `tokens.ts` as theme roles; the AA unit test must keep passing.

## Copy rules

- Voice: attentive, smart, playful, trustworthy — warm, brief, concrete. Sentence case.
- Use the pack metaphor sparingly: "Your pack is in motion.", "Agent squad", "Pack health".
- Name uncertainty: "Connection not verified yet.", "Last heartbeat 6 min ago — this agent may be stale."
- Never say live, encrypted or secure without runtime evidence. Label sample data "(sample)". Label targets "design goal, not a measured SLA".
- Avoid hype, alarm fatigue, cartoon overload and false certainty. Errors say what happened and what to do next; they do not apologize.

## Data display rules

- Every live value shows source + last update/heartbeat + stale state ("Live means verified").
- Critical status is visible within a 3-second scan ("Signal before spectacle").
- Default payloads exclude prompts and source code; UI must not invite pasting secrets ("Privacy by minimization").
- Charts: input tokens = violet, output = mint, failed/retry = coral dashed; legible units and legends.

## Token network / Pack Pool

Concept only: badge "CONCEPT ONLY", label "PHASE 2 · NOT LIVE", show the four safety principles. Never build key sharing or token transfer.

## Review checklist (run before committing UI)

- [ ] Only semantic token utilities; no raw hex.
- [ ] Text contrast AA (tokens guarantee it — do not override colors inline).
- [ ] Status pills carry text; icons have `aria-hidden` or labels.
- [ ] Disclosure present wherever backend/data is not real.
- [ ] Copy follows voice rules and sentence case.
- [ ] Live values show freshness; stale state designed.
- [ ] Responsive at 1150 / 850 / 560px breakpoints.
