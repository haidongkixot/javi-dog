---
name: primary-source-research-with-agents
description: Run fast, trustworthy technical research with a parallel research agent while the main agent keeps building — a scoped question list, one primary-source URL per fact, explicit NOT VERIFIED marking, official source repositories as fallback when documentation sites are blocked, orchestrator spot-checks of the facts that drive decisions, recorded rejections of the researcher's suggestions, and a findings-to-decisions table that ties every spec change to a source. Use when designing a protocol, integration, collector, SDK or API against third-party tools or standards, when an agent's web access is partly blocked by a proxy or sandbox, when facts about vendor defaults, telemetry, config flags or RFC status matter, or when asked to "research", "check the docs" or "verify sources" before deciding.
metadata:
  version: "0.1.0"
  origin: "javis-dog G1"
  confidence: medium
---

# Primary-source research with agents

Model memory and search snippets are the usual sources of confident, wrong facts about third-party tools: a default that flipped, a metric that was renamed, a header that never became an RFC. When a design depends on those facts (privacy defaults, wire formats, identity fields), research has to cite primary sources, and the decision-maker has to know which facts were checked. A parallel research agent makes this cheap; the discipline below makes it trustworthy.

The rule: **every fact has a primary-source URL or a NOT VERIFIED mark, and every design change from research points back to a fact.**

## 1. Scope the questions before launching

Write a short brief (template: [`templates/research-brief-and-note.md`](templates/research-brief-and-note.md)):

- 5–10 numbered questions, each phrased so the answer changes a decision ("Does tool X attach user identity to telemetry? Under which setting?").
- Which sources count as primary: official docs, specifications/RFCs, official source repositories, official SDK source. Blogs, forums and summaries do not count.
- Output format: per item, the URL, the fact, and a verification status.
- What to do when a site is blocked: try the official source repository of the same document and say so per item; otherwise mark NOT VERIFIED. Never fill the gap from memory.

## 2. Run it in parallel with independent work

Launch the research agent, then build the parts that do not depend on the answers: schemas, validators, test vectors, the decision-record skeleton. Leave explicit "pending research" markers (for example, an informative mapping section) where the answers will land. Integrate findings when they return — in a separate commit, so the research-driven changes are reviewable on their own.

## 3. Spot-check the facts that drive decisions

The orchestrator (you, not the researcher) re-fetches the primary source for the facts that carry the most weight — usually privacy, security and wire-format facts — and records which items were spot-checked and how. Facts not spot-checked keep the researcher's status. A spot-check confirms quoted text; it does not upgrade facts from blocked sources.

## 4. Record blocked sources as such

When the environment blocks sites, list them in the note's method section. For each affected item, record which fallback was used ("via the official GitHub source of the docs") or NOT VERIFIED. Do not upgrade a fallback to "verified against the official site".

## 5. Translate findings into decisions explicitly

End the note with a table: finding → change in your design, each change landing in the spec, code or decision record. Also record **suggestions you did not adopt** and why (in the origin: build directly on an existing event-envelope standard → declined for v0.1, but its deduplication rule was adopted). Unadopted suggestions are where the next reviewer will push back; the reason should already be written down.

## 6. Keep tool facts dated

Vendor defaults change. Date the note in its filename, pin version-sensitive facts (for example "semantic conventions renamed this metric after v1.41"), and pin versions per release of anything you build on them.

## Pitfalls

- **Secondary sources disguised as primary.** A docs mirror or aggregator is not the vendor.
- **Verification by citation count.** Three blogs repeating a default are still unverified.
- **Silent gap-filling.** A blocked site plus model memory produces fluent, unsourced facts. Mark NOT VERIFIED.
- **Research that changes nothing.** If no finding changes a decision, the questions were too broad or asked too late.
- **Unrecorded rejections.** Rejected suggestions resurface as "did you consider…?" unless the reason is in the record.

## Evidence from origin project

Javi's Dog, Sprint 1b (2026-10-20). Confidence **medium**: the method was used once, and its outputs are recorded and traceable; the accuracy of unspot-checked items is not established.

- Note: `docs/jgr/research/2026-10-20-sources.md` (`a789674`) — 8 topics, URL per item; blocked sites listed (opentelemetry.io, datatracker.ietf.org, rfc-editor.org, developers.openai.com, docs.stripe.com, docs.github.com, geminicli.com) with official GitHub/source fallbacks marked per item; NOT VERIFIED marks on opentelemetry.io itself, the Codex docs site, a Gemini CLI auth-header detail and the Idempotency-Key draft status.
- Spot-check: the orchestrator re-fetched the Claude Code monitoring page; items 1a–1d (OTLP protocol has no default, token metric types, prompt redaction default, `user.email` attribute) confirmed verbatim. Other items carry the research agent's status only.
- Parallel work: research launched at sprint start; schemas, validator, 20 vectors, spec and decision record committed while it ran (`77579d9`); findings integrated in a separate commit (`a789674`) — `reasoning_tokens` counter, CloudEvents-aligned dedupe key, identity and content drop at the OTLP edge, prompt-off collector setup, Idempotency-Key informative only, request-signing design for v0.2 (`docs/sprints/SPRINT-01b.md`, Backlog 5).
- Recorded rejection: building directly on the CloudEvents envelope declined for v0.1 with the rationale in ADR-0004 (`docs/sprints/SPRINT-01b.md`, Decisions).
- Duration: S1b closed in about 8 minutes including research (sprint log 19:00 → 19:08 UTC). The retro credits parallel research for the short sprint; there is no comparison run, so the speed-up is the team's assessment, not a measurement.
