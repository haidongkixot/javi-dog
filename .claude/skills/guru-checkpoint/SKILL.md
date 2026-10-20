---
name: guru-checkpoint
description: Run a Javi's Guru checkpoint — harvest verified lessons from a window of project history and package them as reusable, generalized skills in guru/. Use at sprint start/end, after architecture or protocol decisions, after a feature or test milestone, after an incident, before a release, or whenever the user says "Guru checkpoint", "harvest lessons", "what did we learn" or "package this as a skill".
---

# Guru checkpoint

Javi's Guru turns project history into reusable wisdom (brand proposal slide 12). This skill is the entry point; the full behavior lives in `.claude/agents/javi-guru.md`.

## Steps

1. **Pick the checkpoint and window.**
   - ID: `G0`…`G5` for planned checkpoints (see `docs/explanation/roadmap.md`) or `ad-hoc-<topic>`.
   - Window: commit range since the previous entry in `guru/WISDOM_LOG.md` (first entry: from the root commit).
2. **Make sure the record is current** — the sprint file has test evidence and a retro, `PROJECT_MEMORY.md` is up to date. Guru reads records; it does not reconstruct them from memory.
3. **Invoke the agent** (`javi-guru` subagent) with: checkpoint ID, commit range, sprint file path, and any owner questions to address.
4. **Verify the output** before committing:
   - each new/updated skill has frontmatter `name` + `description`, an evidence section and a confidence level;
   - `guru/CATALOG.md` and `guru/WISDOM_LOG.md` are updated;
   - no secrets or private data (`git diff --cached | grep -iE "secret|token=|password"` is clean);
   - `pnpm docs:check` passes.
5. **Commit** as `docs(guru): <checkpoint> — <summary>` and push.
6. **Report** to the owner: skills packaged, confidence, and proposals needing a decision.
