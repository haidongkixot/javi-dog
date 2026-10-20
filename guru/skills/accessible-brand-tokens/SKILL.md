---
name: accessible-brand-tokens
description: Turn a brand kit, style guide, Figma file or HTML/CSS design prototype into accessible, theme-scoped design tokens with one source of truth. Use when you set up a design system or token package, translate a designer's palette into code, add a theme (dark mode, high contrast), find that brand colors fail WCAG contrast, need to "fix contrast without changing the brand", or want CI to keep generated CSS/Tailwind/native token files in sync — even if the request only says "add the brand colors" or "build the UI from this mockup".
metadata:
  version: "0.1.0"
  origin: "javis-dog G0"
  confidence: medium
---

# Accessible brand tokens

Brand kits and design prototypes are usually drawn for impact, not measured for readability. Copying their CSS verbatim ships whatever contrast failures they contain into every screen. This skill turns the kit into tokens in a way that keeps the brand recognizable, makes text accessible by default, and stops the generated outputs from drifting.

The core idea: **measure first, keep the brand hues, move only text colors, and by the smallest amount that passes; then let a test and a generator enforce it.**

## When this applies

- A designer or owner hands over a palette, prototype or style guide and asks for "the UI".
- You are creating the token layer (CSS variables, Tailwind theme, iOS/Android color assets, email styles).
- Someone reports low-contrast text, or an accessibility audit is coming.
- You need a second theme later and want components untouched.

## Workflow

### 1. Inventory the kit's real values

Extract every color the source actually uses, not only the named brand palette: neutrals, tints, status/badge colors, button states, sidebar or dark-surface colors. Record where each value came from (file, slide, CSS selector) so later questions ("is this hex official?") have an answer. Archive the source files with checksums if they arrived outside version control; brand files get revised and you need to know which version you implemented.

### 2. Measure contrast before designing anything

List every **text-on-background pair** the design implies — body text on page and card backgrounds, secondary text, text on buttons, status-pill text on its tint, labels on dark navigation, and so on. Compute the WCAG 2.1 contrast ratio of each (use [`references/contrast.mjs`](references/contrast.mjs) or any equivalent implementation).

Write the results into the brand/design guide as a table with PASS/FAIL against the threshold you target (AA: 4.5:1 normal text, 3:1 large text; AAA: 7:1). Also note sizes: prototypes often use 9–10px text as a density sketch; set a product minimum explicitly.

Why first: a measured table turns "the colors look a bit light" into a concrete, reviewable decision for the brand owner, before any component depends on the values.

### 3. Separate brand hues from text tokens

Keep the brand palette **exact** — those are identity colors and owners notice drift. Instead, introduce *text* tokens (and, where needed, a button-background token) that are derived from the brand hue:

- Keep hue and saturation; change only lightness — darker on light surfaces, lighter on dark ones.
- Take the **smallest** step that clears the threshold on *every* background the token will sit on (its tint and the plain surface). A tiny margin above the threshold (for example 4.6 instead of 4.5) is cheap insurance against rounding when values are converted between formats; the margin itself is a judgement call, not a standard.
- If no same-hue lightness passes, or the result no longer reads as that color, the hue is a **fill**, not a text color. Pastels are the usual case: use them as backgrounds and put dark ink on them.
- Keep the original value documented next to the adjusted one, so reviewers can see the delta.

`adjustToContrast(fg, [bg1, bg2], 4.6)` in the reference file implements exactly this search.

### 4. Ask the owner, but ship the accessible default

The adjusted tokens are a visible (if small) change to the brand. Record it as an explicit decision with options — e.g. A) accessible text tokens with unchanged hues (recommended), B) exact prototype colors (fails the target), C) designer revises the palette — and use option A as the default until the owner answers. Do not silently change brand colors, and do not silently ship failing contrast.

### 5. Structure tokens in three layers

1. **Palette** — raw brand and neutral values, exact.
2. **Semantic roles per theme** — `text`, `text-muted`, `surface`, `border`, `primary-bg`, `status-ok-text`, … mapped to palette values. Components use only these.
3. **Outputs** — CSS custom properties scoped by theme selector (`:root, [data-theme="light"]`), framework theme config, native color assets, email constants.

Scope even a single theme by selector from day one. Adding dark mode later then means adding one role map (plus review), not touching components. Assert in a test that every theme defines the same set of roles.

### 6. Enforce with a unit test over declared pairs

Keep an explicit list of text/background pairs per theme in the token source (label, foreground role, background role). A parameterized test asserts each pair meets the threshold. Also test the contrast function itself against known values (black on white = 21, a color on itself = 1, symmetry, malformed input throws), because a wrong luminance formula would make every other assertion meaningless.

```ts
// Example with Vitest/Jest; adapt to your runner.
describe.each(themeNames)('theme %s', (theme) => {
  it.each(textPairs(theme))('%s meets AA', (_label, fg, bg) => {
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });
});
```

Add a second test that the raw palette still equals the brand kit values, so an "accessibility fix" cannot quietly recolor the brand.

When a new component introduces a new pairing, add it to the list in the same change. The test protects only the pairs it knows about.

### 7. Generate outputs from one source, with a staleness check

Write tokens once (TypeScript, JSON, YAML — whatever your stack reads easily) and generate the CSS/native/email files with a script. Mark generated files with a "do not edit" header. Give the generator a `--check` mode that renders in memory, compares with the committed file and exits non-zero if they differ; run it in CI. Committing the generated file (rather than generating only at build time) keeps diffs reviewable and lets non-JS consumers use it directly.

```text
generate-tokens          # writes the output file
generate-tokens --check  # CI: exit 1 with "stale, run generate-tokens" if output differs
```

If the generator relies on a runtime feature (for example running TypeScript directly), declare the minimum runtime version in the project's engine/version files; otherwise contributors on older runtimes get a confusing failure.

## Pitfalls

- **Testing hex values instead of roles.** Test what components consume (semantic roles), or a remap can bypass the test.
- **Fixing contrast by changing the brand color.** It spreads to fills, charts and logos. Change the text token only.
- **Color as the only signal.** Status tokens are for pill + text label; never rely on hue alone.
- **Screenshots as proof of contrast.** Contrast is arithmetic; a unit test is cheaper and exact.

## Evidence from origin project

Javi's Dog, Sprint 0 (2026-10-20). Confidence **medium**: applied once, with tests passing; owner confirmation of the adjusted tokens (decision D1) was still pending at G0.

- Measured before building: `docs/brand/BRAND_GUIDE.md` §3 (commit `f89e605`) recorded that the prototype's secondary text (4.00:1), all five status-pill text colors (3.21–4.08:1) and white on the primary violet (4.43:1) fail AA; pastels on white are 1.28–2.20:1.
- Decision with options and an accessible default: `docs/adr/0003-brand-to-design-tokens.md` (`f89e605`), readiness item D1 in `docs/agent-ops/READINESS_MATRIX.md` (`7a501a3`).
- Implementation (`d011b8d`): `packages/ui/src/tokens.ts` (palette exact, AA text tokens, `textPairs()`), `packages/ui/src/contrast.ts`, `packages/ui/src/css.ts`, `packages/ui/scripts/generate-tokens-css.ts` (`--check`), tests in `packages/ui/test/contrast.test.ts` and `tokens.test.ts`.
- Recorded result: `pnpm test` exit 0, 29 tests in 2 files; `docs:check` reported tokens.css in sync (`docs/sprints/SPRINT-00.md`, Test evidence).
- Retro (`docs/sprints/SPRINT-00.md`): measuring contrast first surfaced the gap early, with a fix that kept brand hues unchanged.
- Reproduction at G0: the `adjustToContrast` search in `references/contrast.mjs` (HSL lightness, step 0.005, target 4.6) reproduces all eight adjusted values in the origin token file (six text tokens, one dark-surface label, one button background). This shows the method is consistent with the origin values; the origin commits do not record which tool produced them.
