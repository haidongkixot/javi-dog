---
name: primary-source-research-with-agents
description: Run fast, trustworthy technical research with a parallel research agent while the main agent keeps building — a scoped question list, one primary-source URL per fact, explicit NOT VERIFIED marking, official source repositories as fallback when documentation sites are blocked, orchestrator spot-checks of the facts that drive decisions, recorded rejections of the researcher's suggestions, and a findings-to-decisions table that ties every spec change to a source. Use when designing a protocol, integration, collector, SDK or API against third-party tools or standards, when an agent's web access is partly blocked by a proxy or sandbox, when facts about vendor defaults, telemetry, config flags, settings scopes or RFC status matter, when a design assumes where a tool reads its configuration or which runtime behaviour it has, or when asked to "research", "check the docs" or "verify sources" before deciding.
metadata:
  version: "0.2.0"
  origin: "javis-dog G1; updated G2"
  confidence: "high (research loop with orchestrator spot-checks changed designs in three iterations); medium (local runtime probes, defensive fallbacks for undocumented facts)"
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

Make it a team rule: the orchestrator re-fetches **at least two** decisive facts per research run and logs which, by URL and line ("re-fetched lines 69 and 131: both confirmed"). Line-level citations make the next spot-check cheap.

### Ask the deployability question first

The most valuable question is often not "what does the tool emit?" but "**where can the configuration live, and which scopes does the tool honour?**" A design that writes a setting into a scope the tool ignores works in no environment. In the origin, the research found that the host tool ignores telemetry exporter variables in repository-level settings — which moved the design from a per-project setting to an opt-in, user-level change before any code existed.

### Probe runtime facts locally when a probe is cheap

Some facts are faster to test than to look up: does the runtime execute TypeScript from an installed package? does a path resolve through a symlink? A 30-second probe in a scratch directory is primary evidence; record the runtime version and the exact error.

### Undocumented facts: fall back defensively and keep a runtime-check row

When the docs are silent on a fact your design needs (where an attribute appears; whether two IDs from two interfaces are equal), do not guess and do not block:

- Implement the safe reading (accept the attribute in either location; drop unmatched data and count it instead of misattributing it).
- Mark the fact UNVERIFIED in the decision record and keep an UNKNOWN readiness row with the runtime check that will settle it (who runs it, what output proves it).
- Do not build checks for things the environment cannot observe (for example settings pushed by an organization's server): document the limit instead.

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
- **Asking about content before scope.** Field-level research is wasted if the setting cannot live where you planned to put it.
- **Treating an undocumented fact as settled because the design needs it.** Keep it UNVERIFIED until a runtime check settles it.

## Evidence from origin project

Javi's Dog, Sprint 1b (2026-10-20). Confidence **medium**: the method was used once, and its outputs are recorded and traceable; the accuracy of unspot-checked items is not established.

- Note: `docs/jgr/research/2026-10-20-sources.md` (`a789674`) — 8 topics, URL per item; blocked sites listed (opentelemetry.io, datatracker.ietf.org, rfc-editor.org, developers.openai.com, docs.stripe.com, docs.github.com, geminicli.com) with official GitHub/source fallbacks marked per item; NOT VERIFIED marks on opentelemetry.io itself, the Codex docs site, a Gemini CLI auth-header detail and the Idempotency-Key draft status.
- Spot-check: the orchestrator re-fetched the Claude Code monitoring page; items 1a–1d (OTLP protocol has no default, token metric types, prompt redaction default, `user.email` attribute) confirmed verbatim. Other items carry the research agent's status only.
- Parallel work: research launched at sprint start; schemas, validator, 20 vectors, spec and decision record committed while it ran (`77579d9`); findings integrated in a separate commit (`a789674`) — `reasoning_tokens` counter, CloudEvents-aligned dedupe key, identity and content drop at the OTLP edge, prompt-off collector setup, Idempotency-Key informative only, request-signing design for v0.2 (`docs/sprints/SPRINT-01b.md`, Backlog 5).
- Recorded rejection: building directly on the CloudEvents envelope declined for v0.1 with the rationale in ADR-0004 (`docs/sprints/SPRINT-01b.md`, Decisions).
- Duration: S1b closed in about 8 minutes including research (sprint log 19:00 → 19:08 UTC). The retro credits parallel research for the short sprint; there is no comparison run, so the speed-up is the team's assessment, not a measurement.

### Update at G2 (Sprints 3c and 3e, 2026-10-23 and 2026-10-28)

Confidence raised to **high** for the research loop: in S1b, S3c and S3e a research lane plus orchestrator spot-checks produced design changes that are traceable to cited facts.

- S3c: a docs agent plus a direct fetch verified the host tool's hook contract (events, fields, async, exec form, stdout/exit semantics, settings precedence, git-ignore behaviour); design changes from it: exec form instead of shell form, async hooks, a notification matcher, `duration_ms`, an extra attention type (`docs/sprints/SPRINT-03c.md` Log; `docs/adr/0010-claude-code-collector.md` Context).
- S3e: the Researcher reported that the host tool ignores OTel exporter variables in a repository's settings files; the orchestrator re-fetched the documentation lines for that fact and the delta-temporality default and confirmed both (`docs/sprints/SPRINT-03e.md` team log; `docs/adr/0011-local-otlp-usage-receiver.md` facts 1–2). The owner changed the decision from a local receiver configured per project to an opt-in user-level setting (ADR-0011 Status; `docs/agent-ops/READINESS_MATRIX.md`, "OTel exporter config scope" row). G2 re-fetch (2026-10-28) of the same page: line 69 still says the exporter variables in `.claude/settings.json` and `.claude/settings.local.json` are ignored; line 131 still gives `delta` as the default.
- Local probe: "Node refuses type stripping under `node_modules`" verified locally before packaging was planned (`SPRINT-03e.md` team log); re-probed at G2 on Node 22.22.0 (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`).
- Undocumented facts handled defensively: the session id attribute's location (data point or resource) → fallback to the resource block (`774549e`); whether the telemetry session id equals the hook session id → UNVERIFIED, unmatched usage dropped locally and counted, readiness row "OTel session correlation" UNKNOWN until the owner's first real run. At G2 the docs still do not state the equality; they do say `/clear` replaces the telemetry `session.id` (monitoring page l. 583) — a case worth including in that runtime check (hypothesis about its effect).
- Not built, documented: a check for organization-managed settings, which are invisible locally (docs re-fetched during the S3e review; `SPRINT-03e.md` team log).
- QA lane fallback: the OTel website was blocked; the same specification text was read from the official proto repository (`docs/jgr/conformance/otlp/README.md`).
