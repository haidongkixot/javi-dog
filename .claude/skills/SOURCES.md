# Skill Sources and Provenance

All third-party skills were reviewed (instructions read in full, scripts scanned for network/exec behavior) before being vendored on 2026-10-20. Precedence when they conflict with project rules: **Orcasus > project & brand rules (CLAUDE.md, BRAND_GUIDE) > skills below** (CLAUDE.md §1).

## Installed

| Skill (directory) | Source | Commit | License | Why | Project overrides |
|---|---|---|---|---|---|
| `project-discovery` | [haidongkixot/orcasus](https://github.com/haidongkixot/orcasus) | `00b241b` | Owner's repo | Mandatory rules | — (records live in `docs/agent-ops/`) |
| `efficient-testing` | haidongkixot/orcasus | `00b241b` | Owner's repo | Mandatory rules | — |
| `skill-creator` | [anthropics/skills](https://github.com/anthropics/skills) `skills/skill-creator` | `dbd4588` | Apache-2.0 (`LICENSE.txt`) | Javi's Guru uses it to structure, evaluate and package skills | Eval workspaces (`*-workspace/`) are gitignored; never commit eval outputs |
| `vercel-react-best-practices` | [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills) `skills/react-best-practices` (SKILL.md, README, metadata, rules/) | `063bee9` | MIT (per upstream README) | React/Next.js performance rules for JD-APP and JD-M13 | Compiled `AGENTS.md` not vendored (duplicate of `rules/`) |
| `web-design-guidelines` | vercel-labs/agent-skills `skills/web-design-guidelines` + rules from [vercel-labs/web-interface-guidelines](https://github.com/vercel-labs/web-interface-guidelines) `command.md` | `063bee9` / `434b7f9` | MIT (`LICENSE-web-interface-guidelines`) | UI review checklist (a11y, focus, forms, motion, copy) | **Modified:** reads pinned `references/web-interface-guidelines.md` instead of fetching at runtime; sentence case overrides Title Case; brand visual system wins |
| `systematic-debugging` | [obra/superpowers](https://github.com/obra/superpowers) `skills/systematic-debugging` (SKILL.md + technique docs + `find-polluter.sh`) | `bb92a77` | MIT (`LICENSE`) | Root-cause-first debugging; reinforces Orcasus "diagnose before retry" | References to `superpowers:test-driven-development` → use `efficient-testing` (lowest reliable layer). Pressure-test/creation-log files not vendored |
| `verification-before-completion` | obra/superpowers | `bb92a77` | MIT (`LICENSE`) | Evidence before completion claims; reinforces Orcasus truthful reporting | — |
| `javis-dog-brand` | This repository | — | Project | Brand rules for UI/copy/email | — |
| `guru-checkpoint` | This repository | — | Project | Invokes Javi's Guru | — |

## Evaluated, not adopted (yet)

| Skill | Source | Decision | Reason |
|---|---|---|---|
| `frontend-design` | anthropics/skills | Not adopted | Pushes a new "distinctive" visual direction and screenshot self-critique; our visual system is pinned by the owner's brand and Orcasus sets screenshot budget 0 |
| `webapp-testing` | anthropics/skills | Deferred to S2 review | Python Playwright helpers; project uses TypeScript Playwright. Re-evaluate when the first E2E journey exists |
| `mcp-builder` | anthropics/skills | Deferred to S5 | Needed for JD-C03 (Javi MCP server) |
| `writing-plans` | obra/superpowers | Not adopted | Depends on other superpowers skills and mandates per-step TDD; useful ideas (interfaces block, review focus, self-review) folded into the sprint template |
| `composition-patterns`, `deploy-to-vercel` | vercel-labs/agent-skills | Deferred | Revisit in S1 (components) and at first deployment |

## Updating a vendored skill

1. Clone upstream into a scratch directory; diff against the vendored copy.
2. Read every changed instruction file; scan scripts for network/exec changes.
3. Copy, update the commit column above, and commit as `chore(skills): update <name> to <sha>`.
