---
name: vendoring-agent-skills
description: Safely adopt third-party agent skills, prompts, rules files or plugins (Claude Code skills, AGENTS.md rule packs, Cursor rules, MCP prompt bundles) into a repository — review instructions and scripts before installing, pin upstream commits, record licenses, overrides and rejections in a SOURCES file, replace instructions fetched at runtime with pinned reviewed copies, and define rule precedence. Use whenever someone asks to "install", "add", "import" or "use" a skill or rules pack from GitHub or a marketplace, when updating a vendored skill, when two skills or rule sets give conflicting instructions, or when auditing what instructions an agent in this repo is following.
metadata:
  version: "0.1.0"
  origin: "javis-dog G0"
  confidence: medium
---

# Vendoring agent skills safely

A skill is code that runs through your agent: its instructions steer what the agent does, and its scripts execute with the agent's permissions. Installing one unreviewed is like adding a dependency with commit access. Skills also bring opinions — testing styles, visual direction, naming conventions — that can silently contradict your own rules.

Treat skill adoption like dependency adoption: **review, pin, record, and decide precedence up front.**

## Workflow

### 1. Start from a need, not a catalog

For each candidate, write one line: what concrete job it will do in this repository. If you cannot, do not install it. Skills that are not needed still load their descriptions into every session and can trigger unexpectedly.

### 2. Review before copying

Clone or download upstream into a scratch directory **outside** the repository. Then:

- **Read every instruction file in full** (the main skill file and every reference it tells the agent to load). Look for instructions that contradict your rules, push a style you have not chosen, require other skills you do not have, or tell the agent to fetch and follow remote content.
- **Scan every script** for network access, process execution, writes outside the skill folder, credential or environment-variable reads, and install steps. A quick search for `fetch`, `curl`, `http`, `subprocess`, `exec`, `eval`, `child_process`, `os.environ` and `rm -` is a starting point, not a substitute for reading what each script does.
- **Check the license** and keep the license file next to the vendored copy. If the license is only stated in a README, record where.

### 3. Vendor only what you need, at a pinned commit

Copy the reviewed files into the repo's skill directory and record the upstream commit SHA. Skip files that are build outputs or duplicates of other files (e.g. a compiled aggregate of rule files), test fixtures and creation logs. Add ignore rules for workspaces the skill creates at runtime (eval outputs, caches) so they never get committed.

### 4. Replace runtime-fetched instructions with a pinned copy

Some skills tell the agent to download their rules from a URL each time they run. That means the instructions your agent follows can change without any commit in your repository. Fetch the content once, review it, store it inside the skill (e.g. `references/<name>.md`), record its upstream commit, and edit the skill to read the local copy. Explain the change in the skill itself so the next maintainer does not "fix" it back.

### 5. Write project overrides into the skill and the record

Where a vendored skill conflicts with a project rule, do not leave the agent to guess. Either add a short "project overrides" section to the vendored skill (e.g. "use sentence case, ignore the rule that says Title Case"; "where this says to use skill X, use our skill Y") or decline the skill. Record every modification in the SOURCES file so upstream updates can be re-applied deliberately.

### 6. Record rejections and deferrals too

A SOURCES file that lists only installed skills invites someone to re-propose the same rejected skill next month. Record each evaluated-but-not-adopted skill with the reason (conflicts with rule N, wrong language/stack, depends on skills we do not use, needed later at milestone M). Template: [`templates/SOURCES.md`](templates/SOURCES.md).

### 7. Define precedence explicitly

Write a numbered precedence order in the agent instructions file, for example:

1. Mandatory organization/team rules.
2. Project rules and brand/design rules.
3. Vendored third-party skills.

Add one concrete example of a conflict and how it resolves. Agents apply a rule more reliably when they have seen it applied to an example.

### 8. Update the same way you installed

Updates go through the same review: diff upstream against the vendored copy, read changed instructions, scan changed scripts, re-apply overrides, bump the pinned commit, and commit with a message naming the skill and SHA.

## Red flags that justify declining

- Instructions to fetch and follow remote content at run time, with no way to pin it.
- Scripts that call the network or execute downloaded code without a clear, documented purpose.
- A mandated workflow that contradicts an existing rule (screenshot-based verification where screenshots are budgeted, a different TDD regime, a "bold new visual direction" where a brand is fixed).
- Hard dependencies on a family of other skills you are not adopting.
- No license, or a license incompatible with your repository.

## Evidence from origin project

Javi's Dog, Sprint 0 (2026-10-20). Confidence **medium**: the process was applied once, to seven skills from five upstream repositories (two from the owner's own rules repository, five from external publishers); no update cycle or conflict incident has happened yet.

- Record: `.claude/skills/SOURCES.md` (`509faa5`) — source repo, pinned commit, license file, purpose and overrides per skill; "evaluated, not adopted" table; update procedure.
- Precedence: `CLAUDE.md` §1 (`d3ff6fa`), with the worked example that the organization's screenshot budget of 0 overrides any imported skill that suggests screenshot-based verification.
- Runtime fetch replaced: `.claude/skills/web-design-guidelines/SKILL.md` reads a pinned `references/web-interface-guidelines.md` instead of fetching rules at review time; its "Why the rules are pinned" section explains the change (`509faa5`).
- Overrides written into vendored skills: the same skill switches Title Case to the brand's sentence case and defers to the brand's visual system; `systematic-debugging` references to an unadopted TDD skill are redirected to the project's testing skill (recorded in `SOURCES.md`).
- Rejections with reasons: a frontend-design skill was declined because it pushes a new visual direction and screenshot self-critique, conflicting with a fixed brand and a screenshot budget of 0; a planning skill was declined because it depends on other skills from its family and mandates per-step TDD (`SOURCES.md`).
- Runtime workspace ignored: `.gitignore` gained `**/*-workspace/` for skill-creator eval outputs (`509faa5`).
- Not recorded at G0: the exact scan commands used during the script review. The SOURCES file states the review scope (instructions read in full, scripts scanned for network/exec behavior) but not the commands.
