# Skill Sources and Provenance

All third-party skills below were reviewed before being vendored: every instruction file read in full, every script scanned for network access, process execution and file writes outside the skill folder. Review date: `<YYYY-MM-DD>`.

Precedence when instructions conflict: **`<mandatory org/team rules>` > `<project and brand rules>` > skills listed below.** The full order lives in `<agent instructions file>`.

## Installed

| Skill (directory) | Source (repo + path) | Pinned commit | License (file) | Why we need it | Project overrides / modifications |
|---|---|---|---|---|---|
| `<skill-dir>` | `<https://github.com/owner/repo>` `<path/in/repo>` | `<short-sha>` | `<SPDX id>` (`<LICENSE file in skill dir>`) | `<the concrete job it does here>` | `<"—" or what was changed and why; files not vendored>` |
| `<in-house-skill>` | This repository | — | Project | `<job>` | — |

## Evaluated, not adopted (yet)

| Skill | Source | Decision | Reason |
|---|---|---|---|
| `<skill>` | `<repo>` | Not adopted / Deferred to `<milestone>` | `<conflict with a rule, duplicate, wrong stack, not needed yet>` |

## Updating a vendored skill

1. Clone upstream into a scratch directory outside the repository; diff it against the vendored copy.
2. Read every changed instruction file; scan changed scripts for network, exec and filesystem behavior.
3. Re-apply the overrides listed above; check the license has not changed.
4. Copy, update the pinned commit in this file, and commit as `chore(skills): update <name> to <sha>`.
