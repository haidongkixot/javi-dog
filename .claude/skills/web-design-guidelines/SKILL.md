---
name: web-design-guidelines
description: Review UI code for Web Interface Guidelines compliance (accessibility, focus, forms, motion, typography, performance, copy). Use when asked to "review my UI", "check accessibility", "audit design", "review UX", or before merging any JD-APP / JD-M13 UI change.
metadata:
  author: vercel
  version: "1.0.0"
  modified-by: javis-dog (pinned local rules; see .claude/skills/SOURCES.md)
  argument-hint: <file-or-pattern>
---

# Web Interface Guidelines

Review files for compliance with the Web Interface Guidelines.

## How it works

1. Read the pinned rules in [`references/web-interface-guidelines.md`](references/web-interface-guidelines.md).
2. Read the specified files (or ask which files/pattern to review).
3. Check them against every rule, then against the Javi's Dog overrides below.
4. Output findings in the terse `file:line` format defined in the rules file.

## Javi's Dog overrides (take precedence over the pinned rules)

- **Copy casing:** use **sentence case** for headings and buttons, per `docs/brand/BRAND_GUIDE.md` ("Your pack is in motion.", "New project"). Ignore the rules file's "Title Case (Chicago style)" item.
- **Brand pins the visual system:** eyebrow labels, numbered sequence markers and rounded cards are brand elements, not anti-patterns. Colors must come from JD-M13 semantic tokens, never raw hex.
- **Honesty rules:** flag any UI that shows live/encrypted/secure states without a real signal, or sample data without a "sample" label (CLAUDE.md §3).
- **Evidence:** findings come from reading code and DOM/semantic checks. Do not take screenshots unless an approved visual question and budget exist (Orcasus).

## Why the rules are pinned

The upstream skill fetches rules from a remote URL at review time. This project pins a reviewed copy (upstream commit recorded in `.claude/skills/SOURCES.md`) so review instructions cannot change without a commit. To update: fetch upstream, diff, review, and commit with a SOURCES.md update.
