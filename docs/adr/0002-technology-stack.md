# ADR-0002: Technology stack

- Status: Accepted (versions verified against the npm registry on 2026-10-20)
- Date: 2026-10-20
- Deciders: Project owner (Hai), Claude (implementer)

## Context

Owner-mandated environment: **Vercel, Neon, Resend, GitHub SSO, Google SSO**. Node 22.22 and pnpm 10.28 are available in the build environment. We need a TypeScript stack that agents and humans can work in productively, with stable (non-beta) dependencies where possible.

## Decision

| Concern | Choice | Version line | Notes |
|---|---|---|---|
| Runtime | Node.js | 22 LTS | Vercel default-compatible |
| Package manager / monorepo | pnpm workspaces + Turborepo | pnpm 10, turbo 2.11 | |
| Web framework | Next.js App Router | 16.4 | Route handlers for APIs; Fluid compute for SSE |
| UI runtime | React | 19.3 | |
| Language | TypeScript (strict) | 5.9 | TS 7 is out, but `typescript-eslint` supports `<6.1`; revisit later |
| Styling | Tailwind CSS v4 + CSS variables from JD-M13 tokens | 4.3 | See ADR-0003 |
| Font | Inter via `@fontsource-variable/inter` (self-hosted) | 5.3 | Avoids build-time downloads from Google Fonts |
| Primitives | Radix UI (via shadcn-generated sources, restyled) | — | Added in S1 when components are built |
| Database | Neon Postgres + `@neondatabase/serverless` | 1.2 | Neon branches per preview via Vercel Marketplace (readiness B1) |
| ORM / migrations | Drizzle ORM + drizzle-kit | 0.45 / 0.31 | 1.0 is RC; adopt when stable |
| Auth | **Better Auth** (GitHub + Google social providers, Drizzle adapter, organization plugin for workspaces) | 1.7 | See "Auth decision" below |
| Validation / schemas | Zod | 4.6 | JGR schemas and OpenAPI generation |
| Email | Resend + React Email | resend 6.34, components 1.0 | |
| Unit / component tests | Vitest + Testing Library | vitest 5.0, RTL 16.3 | |
| E2E | Playwright (`screenshot: 'only-on-failure'`, `trace: 'on-first-retry'`, `video: 'off'`) | 1.64 | Added in S2 when the first critical journey exists |
| Lint / format | ESLint (flat config) + typescript-eslint + boundaries plugin; Prettier | eslint 9/10 | |
| Versioning | Changesets | 3.0 | Per-module CHANGELOGs |
| Docs lint | markdownlint-cli2 + offline link check | 0.23 | |
| CI | GitHub Actions | — | Vercel builds previews from Git |

### Auth decision (deviation from the plan's draft wording)

The plan draft named Auth.js v5. On 2026-10-20 `next-auth@5` is still published only as `5.0.0-beta.32` (`latest` is 4.24). **Better Auth 1.7** is stable, supports GitHub and Google OAuth, has a first-party Drizzle adapter and an organization/membership plugin that maps directly to Javi's Dog workspaces. Choosing it avoids building on a beta for a security-critical module. Reversible: JD-M03 hides the auth library behind its own contract.

## Consequences

- Good: stable, well-supported, TypeScript-first; matches the owner's required environment.
- Good: a single language across web, SDK, collectors and MCP server.
- Bad: several tools are on young major lines (Vitest 5, Tailwind 4, Next 16); upgrades are tracked as changesets and verified by CI.
- Follow-up: re-evaluate TypeScript 7 when `typescript-eslint` supports it; re-evaluate Drizzle 1.0 at stable.
