# ADR-0003: Translate the Concept 0.1 brand into theme-scoped design tokens

- Status: Accepted
- Date: 2026-10-20
- Deciders: Project owner (Hai), Claude (implementer)
- Modules: JD-M13 (`packages/ui`), JD-APP

## Context and problem statement

The owner supplied a creative proposal (14-slide PDF) and an interactive HTML prototype that define the Javi's Dog palette, typography, shape language, voice, information architecture and UX principles. We need one machine-readable source of truth that the web app, emails (Resend/React Email) and docs can share, and that can evolve (dark theme, official logo) without rewriting components.

Measured contrast (see `docs/brand/BRAND_GUIDE.md` §3) shows the prototype's secondary text, status-pill text and white-on-violet button fail WCAG 2.1 AA for normal text, and the prototype uses 9–10px text.

## Decision drivers

- Fidelity to the owner's brand; brand hues must not drift.
- Accessibility (WCAG 2.1 AA) for an operational dashboard read under pressure.
- One token source shared by Tailwind, React components and email templates.
- Future dark theme without component changes (owner decision: light-only MVP).

## Considered options

1. Copy the prototype CSS verbatim into the app.
2. Tokens in TypeScript as the single source, emitted to CSS custom properties scoped by `[data-theme]`, consumed by Tailwind v4 `@theme` — with AA-adjusted *text* tokens.
3. Adopt a third-party design system (e.g. stock shadcn theme) and only recolor it.

## Decision outcome

Chosen: **option 2**.

- `packages/ui/src/tokens.ts` holds the palette, semantic roles, status colors, radius, shadow, spacing and type scale.
- A generated `packages/ui/src/styles/tokens.css` exposes them as CSS variables under `:root, [data-theme="light"]`. Components only use semantic variables (`--jd-text`, `--jd-surface`, `--jd-status-ok-text`…), never raw hex.
- Brand hues stay exact. Text-on-tint tokens are darkened by the minimum same-hue step reaching ≥ 4.6:1; primary button background is `#6A5DF6`.
- A unit test asserts AA contrast for every declared text/background pair.
- Radix primitives (via shadcn-generated sources) are restyled to these tokens; no stock theme ships.

### Consequences

- Good: single source; accessible by default; dark theme becomes a new token set plus review.
- Good: emails and OG images can import the same TS tokens.
- Bad: small visible difference from the prototype in secondary text and pill text (slightly darker). Owner decision **D1** accepted this on 2026-10-20.
- Bad: one build step (token → CSS generation) to maintain; guarded by a CI check that the CSS is up to date.

## Links

- `docs/brand/BRAND_GUIDE.md`, `docs/brand/PROVENANCE.md`
- Orcasus readiness item B0 / D1 in `docs/agent-ops/READINESS_MATRIX.md`
