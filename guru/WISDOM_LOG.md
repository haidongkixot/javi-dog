# Wisdom Log

Newest checkpoint first. Each entry: date · checkpoint · commit window · lessons (verified / hypothesis) · skills created/updated · proposals for the owner.

## 2026-10-20 · G1 — protocol decision, end of Sprints 1a and 1b

- **Window:** `6cfe703` (G0) → `a789674` (HEAD), 4 commits: `57890b3` (owner decisions, provisioning guide), `0235df1` (S1a shell, components, project schema), `77579d9` (JGR v0.1 schemas, validator, vectors, spec, ADR-0004), `a789674` (research notes, spec mappings and edge rules).
- **Records read:** `docs/sprints/SPRINT-01a.md`, `SPRINT-01b.md`, `docs/memory/PROJECT_MEMORY.md`, `SESSION_LOG.md`, ADR-0004, `docs/jgr/spec/v0.1.md`, `docs/jgr/research/2026-10-20-sources.md`, `docs/jgr/conformance/vectors/` (20 files), `packages/jgr-spec/**`, `packages/ui/src/components/**`, `apps/web/src/**`, `apps/web/test/**`, `packages/projects/**`, `docs/how-to/provision-external-services.md`, `docs/agent-ops/READINESS_MATRIX.md`, `docs/explanation/roadmap.md` diff.
- **Re-runs by Guru:** none of the project suites. Read-only probes only: `gh run list` (CI status); the origin's two guard regexes against sample strings in `node -e`; `validateEvent` from `packages/jgr-spec/src/index.ts` against three hand-built events; the new templates against origin vectors, the existing built HTML (`apps/web/.next`, built 18:59 UTC in S1a; `apps/web` unchanged since) and scratch negative fixtures.

### Verified lessons

1. **Privacy enforced as validation, not cleanup.** The envelope rejects unknown top-level fields and any attribute outside the L0 allowlist with stable codes; L1 identifiers must be `sha256:` hashes; L2 requires an encrypted blob (`packages/jgr-spec/src/validate.ts`, `77579d9`). 20 shared JSON vectors (7 valid, 13 invalid) run through a filename-prefix-checking runner; `pnpm --filter @javis-dog/jgr-spec test` exit 0, 27 passed (`SPRINT-01b.md`). CI succeeded on `77579d9` and `a789674`.
2. **The privacy boundary covered the attribute map but not the reference fields.** G1 probe: `validateEvent` accepted `thread_ref` = a file path and `agent_ref` = an email address, although spec §3 says refs are "never a path". Root cause in code: the shared `REF` pattern allows `/`, `.` and `@` (`packages/jgr-spec/src/schema.ts`).
3. **Spec cross-references drifted within one sprint.** Spec §3 (JGR-R11) says unknown top-level fields MUST be rejected; §11 says they are rejected only when the version is unrecognized. `validate.ts` cites "spec §7" for error codes, which live in §13. Found by reading at G1.
4. **Research produced traceable design changes.** The research note lists a URL per item, the blocked sites with GitHub/source fallbacks, NOT VERIFIED marks, an orchestrator spot-check of items 1a–1d, and a findings-to-decisions table; `a789674` applied six of those changes to spec and schema (`reasoning_tokens`, CloudEvents-aligned dedupe, identity/content drop at the OTLP edge, prompt-off setup, informative Idempotency-Key, v0.2 signing design). One researcher suggestion (build on the CloudEvents envelope) was declined with the rationale recorded (`SPRINT-01b.md`, Decisions).
5. **Honest empty states held in a tested shell.** `MetricCard` takes `string | null` and renders "No signal yet" with the meta line suppressed; global `DemoBanner` (`role="status"`); disabled "Create project" with `aria-describedby`; "Connection not verified yet" per integration; targets labelled "Design goals, not measured SLAs"; illustrative template numbers and toggles deliberately not ported (`0235df1`, `SPRINT-01a.md`). `pnpm test` exit 0, 62 passed; built-HTML assertions on all 5 routes; screenshots 0.
6. **Two guard tests were weaker than their names.** The Overview "no sample numbers" regex `/\d+(\.\d+)?\s?(K\/s|%|M)\b/` does not match `67%` or `67% capacity` (no word boundary after `%` before a space or end of text); the "no raw hex" regex misses `#7c5cff80` and `#ffff` and all functional color notations (G1 probe, Node 22.22.0). The G0 lesson "prove a guard can fail" was applied to doc checks but not to these tests. The component-level test does catch a fabricated `67% capacity`, so no fake value is known to have shipped.
7. **Copy can run ahead of the spec.** The integrations directory describes the custom API as a "Signed event ingestion endpoint" (`apps/web/src/app/integrations/page.tsx`, `0235df1`), while spec v0.1 has bearer tokens only and signing planned for v0.2 (§8, `a789674`). The row's status pill says "Spec in progress", which limits the overclaim; the description does not.
8. **Timebox split worked once and was recorded truthfully.** Owner rule (≤ 30 min per sprint, split oversized sprints) in `docs/explanation/roadmap.md` (`57890b3`); S1a about 9 min, S1b about 8 min, each with its own backlog, evidence and retro; the hosting item rolled over as BLOCKED with the owner action. The S1a retro action (keep the spec small, vectors executable) was applied in S1b.
9. **Project memory was updated only partially.** At `a789674`, `PROJECT_MEMORY.md` "Current state" is current but "Next actions" still describes closing S0 and starting S1, and "Open questions" still lists D1 as pending although D1 was accepted in `57890b3`.
10. **The type-check gate caught a tool-config option the test runner ignored** (`SPRINT-01a.md`, Log and Retro). At G1, `packages/ui/tsconfig.json` does not include its `vitest.config.ts`, so that package's runner config is outside the gate.
11. **Fixture IDs were validated against the protocol's own format.** Placeholder ULIDs containing `I`/`O` (excluded by Crockford base32) were found and fixed before tests ran (`SPRINT-01b.md`, Log).

### Hypotheses (unverified)

- Shared conformance vectors keep several implementations consistent — only one implementation exists (collectors and gateway arrive in S3).
- Reject-not-strip teaches producers to fix violations — no producer exists yet.
- Deltas plus (`producer_id`, `event_id`) dedupe prevent inflated counters; sequence gaps surface signal loss; receiver-derived stale works with a 3 × heartbeat window — specified, not implemented.
- The OTLP edge drops identity and content from misconfigured tools — specified (§12), tests owed in S3.
- Delivery p95 < 2 s and events < 4 KB — targets, not measured (S5).
- Parallel research shortened S1b — the retro's assessment; no comparison exists.
- A 30-minute timebox improves quality or throughput — two data points, no comparison.
- Honest empty states improve user trust — no users yet.
- Carried from G0, still untested: cross-session resumption from memory files (S0–S1b ran in one session; `SESSION_LOG.md` has one entry); doc-drift guard in real use (still SKIPPED, no `main`); Node engine minimum failure mode; 4.6:1 contrast margin; theme-scoped tokens for a dark theme. D1 is no longer pending (accepted in `57890b3`).

### Skills created and updated

| Skill | Version | Change | Confidence | Why |
|---|---|---|---|---|
| [`privacy-first-agent-telemetry-protocol`](skills/privacy-first-agent-telemetry-protocol/SKILL.md) | 0.1.0 | new (+ `references/envelope-checklist.md`, `templates/run-vectors.mjs`, `templates/vector.example.json`) | medium (envelope, vectors) / low (delivery, edge) | Lessons 1–3, 11 |
| [`honest-empty-states`](skills/honest-empty-states/SKILL.md) | 0.1.0 | new (+ `templates/honesty-guards.mjs` with self-test probes) | medium | Lessons 5–7 |
| [`primary-source-research-with-agents`](skills/primary-source-research-with-agents/SKILL.md) | 0.1.0 | new (+ `templates/research-brief-and-note.md`) | medium | Lesson 4 |
| [`agent-second-memory`](skills/agent-second-memory/SKILL.md) | 0.1.0 → 0.2.0 | added steps 8 (timeboxed splits) and 9 (update every memory section), pitfall "partial memory update", sprint template header fields, G1 evidence | medium | Lessons 8–9; timebox folded in here rather than a separate skill because the evidence is one split |
| [`verify-dependencies-against-registry`](skills/verify-dependencies-against-registry/SKILL.md) | 0.1.0 → 0.1.1 | added pitfall "tool configs outside the type check" and G1 evidence | medium | Lesson 10 |

Template verification at G1: `run-vectors.mjs` on the origin vectors with the origin validator → "20 vectors, 0 failures", exit 0; on a scratch set (wrong expected code, path-shaped ref, no valid file) → 3 failures, exit 1. `honesty-guards.mjs --self-test` PASS; `html` scan of 7 built pages → 1 false positive ("03 Token" from a numbered rule list), fixed by making word units case-sensitive and adding a must-not-match probe, then 0 findings; `colors` scan of `apps/web/src` and `packages/ui/src/components` → 0 findings; scratch negative fixtures → findings, exit 1.

### Proposals for the owner

Project fixes (Guru does not edit project code; each is a small, reversible change for the implementer):

1. `apps/web/test/shell.test.tsx` — replace the trailing `\b` in the sample-number regex (for example with `(?![\w])`) and add probe strings such as `67%` and `67% capacity`.
2. `apps/web/test/brand-static.test.ts` — also catch 4/8-digit hex and `rgb()`/`hsl()`/`oklch()` literals; add must-match probes.
3. JD-M01 — give `producer_id`, `thread_ref` and `agent_ref` an opaque shape that cannot carry `/`, `.`, `@` or spaces, and add invalid vectors for a path-shaped and an email-shaped ref. A breaking change to a draft (allowed before v1.0); worth an ADR-0004 note.
4. Spec v0.1 — reconcile §3 (JGR-R11) with §11 on unknown fields, with vectors for both sides; fix the "spec §7" comment in `validate.ts` (codes are in §13).
5. Integrations copy — "Signed event ingestion endpoint" → for example "Event ingestion endpoint (request signing planned for v0.2)".
6. `PROJECT_MEMORY.md` — refresh "Next actions" and remove D1 from "Open questions"; add the S1a/S1b entry to `SESSION_LOG.md` at session end.
7. `packages/ui/tsconfig.json` — include `vitest.config.ts` so the runner config is type-checked like the app's.
8. ADR-0004 is marked Accepted with the owner as a decider; no separate owner-acceptance record was found in the window. Please confirm or record it.

Orcasus: G1 is not an Orcasus-PR checkpoint; no PR is proposed. Candidates to reassess at G2: `agent-second-memory`, `vendoring-agent-skills`, `verify-dependencies-against-registry` (from G0), plus `primary-source-research-with-agents` (complements "discover before designing" and evidence labelling) and `honest-empty-states` (UI form of "no mock masquerading" and "report truthfully"; its guard self-test practice generalizes beyond UI). `privacy-first-agent-telemetry-protocol` is a domain skill and not an Orcasus candidate; raise its delivery/edge sections from low to medium once the S3 gateway and OTLP translator tests exist.

## 2026-10-20 · G0 — end of Sprint 0 "Discovery & readiness"

- **Window:** `d3ff6fa` (root) → `07ccacc` (HEAD), 6 commits.
- **Records read:** `docs/sprints/SPRINT-00.md`, `docs/memory/PROJECT_MEMORY.md`, `docs/memory/SESSION_LOG.md`, `docs/agent-ops/READINESS_MATRIX.md`, `DISCOVERY_SUMMARY.md`, `TEST_PLAN.md`, ADR-0001…0003, `docs/brand/BRAND_GUIDE.md` §3, `docs/feasibility/FEASIBILITY.md`, `.claude/skills/SOURCES.md`, `CLAUDE.md`, `scripts/*.mjs`, `packages/ui/src/*.ts`, `packages/ui/test/*.ts`.
- **Re-runs by Guru:** none of the project suites. Two cheap read-only checks: `npm view` of three packages (results below) and a local run of the new `references/contrast.mjs` helper against the origin token values.

### Verified lessons

1. **Measure contrast before building a design system.** The brand prototype's secondary text (4.00:1), all five status-pill texts (3.21–4.08:1) and white on the primary color (4.43:1) fail WCAG AA — found before any component existed (`docs/brand/BRAND_GUIDE.md` §3, `f89e605`). Fix kept the brand hues exact and moved only text tokens and one button background (ADR-0003; `packages/ui/src/tokens.ts`, `d011b8d`), enforced by a parameterized AA test over declared text pairs (`packages/ui/test/contrast.test.ts`; `pnpm test` exit 0, 29 tests). Generated CSS is guarded by `tokens:check` in `docs:check` (exit 0).
2. **Smallest same-hue lightness step reproduces the adjusted tokens.** At G0, an HSL-lightness search (step 0.005, target 4.6:1 on every background) reproduced all eight adjusted values in `tokens.ts`. This verifies consistency of the method with the values, not which tool produced them originally (not recorded).
3. **Doc checks catch real problems when they are allowed to fail.** The link check failed on two broken links after `guru/README.md` was added; fixed by creating the files, not weakening the check. The doc-drift guard was proven with a negative probe (exit 1) and a positive case against `7a501a3` (`docs/sprints/SPRINT-00.md`, Test evidence). Doc drift is correctly reported as SKIPPED while no `main` branch exists.
4. **Docs were corrected in the same commit as the code that changed them.** `d011b8d` updated the brand guide, provenance and ADR-0002 when the font strategy moved from a build-time download to a self-hosted npm package.
5. **Frequent pushes protected work from an abrupt session end.** The session worker restarted mid-sprint; pushing after each coherent step prevented loss (`docs/sprints/SPRINT-00.md`, Retro).
6. **Skill review caught real conflicts before install.** `frontend-design` was declined (pushes a new visual direction and screenshot self-critique; conflicts with the fixed brand and screenshot budget 0); `writing-plans` was declined (depends on its family of skills, mandates per-step TDD); a runtime-fetched rules file was replaced by a pinned copy (`.claude/skills/SOURCES.md`, `web-design-guidelines/SKILL.md`, `509faa5`). Precedence with a worked example is in `CLAUDE.md` §1 (`d3ff6fa`).
7. **Registry checks changed two stack choices.** `next-auth@5` is beta-only → Better Auth 1.7 for the security-critical auth module; `typescript-eslint` peer range `<6.1.0` → TypeScript 5.9 pinned although 7 is `latest` (ADR-0002, `DISCOVERY_SUMMARY.md` findings 2–3). Re-checked at G0 with `npm view`: `typescript-eslint@8.72.0` peer `typescript` `>=4.8.4 <6.1.0`; `typescript` `latest` 7.0.2; `next-auth` `latest` 4.24.15, `beta` 5.0.0-beta.32.
8. **Explicit resource status prevents false readiness.** The readiness matrix keeps the database as UNKNOWN (integration listing returned 403) rather than assuming it, and records env var names only (`docs/agent-ops/READINESS_MATRIX.md`, `7a501a3`).

### Hypotheses (unverified)

- The project-memory + session-log pair will let a fresh session resume with little re-discovery. Only one session exists at G0; test at the first session handoff (S1).
- The doc-drift guard will prevent docs from lagging code once `main` exists; so far it has only run on a probe.
- The Node `>=22.18` engine minimum will surface a clear failure for contributors on older runtimes (review-focus risk in `SPRINT-00.md`; never observed).
- A 4.6:1 target (vs. the 4.5:1 threshold) protects against rounding when tokens are converted between formats. The margin was used; its necessity was not tested.
- Theme-scoped tokens will make a dark theme a role-map addition without component changes. Only one theme exists (decision D2).
- Owner acceptance of the AA-adjusted tokens (D1) is still pending; the visual delta being "acceptable" is unconfirmed.

### Skills created

| Skill | Version | Confidence | Purpose |
|---|---|---|---|
| [`accessible-brand-tokens`](skills/accessible-brand-tokens/SKILL.md) | 0.1.0 | medium | Brand kit → accessible, theme-scoped tokens with contrast test and generated outputs (includes a dependency-free `references/contrast.mjs`) |
| [`agent-second-memory`](skills/agent-second-memory/SKILL.md) | 0.1.0 | medium | Repository memory files and CI doc checks for multi-session agent work (templates: memory files, link check, doc drift) |
| [`vendoring-agent-skills`](skills/vendoring-agent-skills/SKILL.md) | 0.1.0 | medium | Review, pin, record and rank third-party agent skills (template: `SOURCES.md`) |
| [`verify-dependencies-against-registry`](skills/verify-dependencies-against-registry/SKILL.md) | 0.1.0 | medium | Stack pinning against live registry data with deviations recorded in an ADR |

No existing skills were updated (catalog was empty).

### Proposals for the owner

- G0 is not an Orcasus-PR checkpoint; no PR is proposed.
- Future Orcasus candidates (reassess at G2 once each has been reused at least once more): `agent-second-memory` (fits the Orcasus "records" practice), `vendoring-agent-skills` (complements rule precedence), `verify-dependencies-against-registry` (a natural addendum to `project-discovery`). `accessible-brand-tokens` is a domain skill and fits a design-system library better than Orcasus.
- Record evidence that would raise confidence: note the scan commands used when reviewing vendored scripts; log the first cross-session handoff in `SESSION_LOG.md` with what the new session had to re-discover; record the first real doc-drift failure in CI.
- Answer D1 so the token decision can move from default to accepted.
