# Discovery Summary — Sprint 0

- Date: 2026-10-20 · Method: Orcasus `/project-discovery` v1.2.1
- Detail and evidence per item: [`READINESS_MATRIX.md`](READINESS_MATRIX.md)

## What exists

| Resource | Finding | Evidence |
|---|---|---|
| Application repository | `haidongkixot/javi-dog` existed with **no commits**; working branch `claude/clever-goldberg-wlurty` | `git status` → "No commits yet" |
| Engineering rules | Orcasus v1.2.1: two skills, operating contract, readiness and test-plan templates | `haidongkixot/orcasus@00b241b` |
| Brand | Creative proposal (14 slides) + interactive HTML prototype, Concept 0.1 | `docs/brand/source/` (SHA-256 in `PROVENANCE.md`) |
| Runtime | Node 22.22.0, pnpm 10.28.0, npm registry reachable | shell checks |
| Hosting | Vercel team `haidongkixots-projects`; no `javi*` project | Vercel MCP `list_teams`, `list_projects` |
| Browser for tests | Chromium pre-installed for Playwright | `/opt/pw-browsers` |

## What is missing or unknown

| ID | Item | Status | Needed by |
|---|---|---|---|
| B1 | Neon database / `DATABASE_URL` | UNKNOWN (403 on integration listing) | S2 |
| B2 | Vercel project for the repo | MISSING (owner confirmation to create) | S0 end / S1 |
| B3 | GitHub OAuth App | MISSING | S2 |
| B4 | Google OAuth client | MISSING | S2 |
| B5 | Resend API key + verified domain | MISSING | S2 |
| B6 | GitHub App for repository signals | MISSING | S5 |
| B7 | Legal/ToS review for Pack Pool | MISSING | S6 |
| D1 | Acceptance of AA-adjusted text tokens | UNKNOWN (default applied) | S1 |

## Notable findings

1. **Accessibility gap in the template.** Secondary text (`#7D7D97`, 4.00:1), all status-pill text colors (3.21–4.08:1) and white on Signal Violet (4.43:1) fail WCAG AA for normal text; the prototype also uses 9–10px text. Resolution proposed in ADR-0003 (decision D1).
2. **Auth library maturity.** `next-auth@5` is still beta; Better Auth 1.7 is stable → ADR-0002.
3. **Tooling compatibility.** TypeScript 7 is released but `typescript-eslint` supports `<6.1`; TypeScript 5.9 pinned.
4. **Pack Pool** is consistently framed by the owner's own brand material as *concept only* with four safety principles — aligned with the feasibility verdict.
5. **Brand roadmap alignment.** The proposal's roadmap (S0 discovery → S1 brand shell & registry → S2 identity → S3 JGR ingress → S4 live state & analytics → S5 adapter hardening → S6 Pack Pool research) is adopted as the sprint backbone.

## Architecture alternatives considered

See ADR-0001 (modular monolith vs. microservices vs. folders) and ADR-0002 (stack). Realtime transport (SSE vs. WebSocket vendor vs. polling) will get its own ADR in S4.

## Questions for the owner

Grouped in the readiness matrix: B1–B5 are needed before Sprint 2; B2 can be done now with confirmation; D1 confirmation needed during Sprint 1.
