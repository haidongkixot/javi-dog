---
name: review-design-before-code
description: Put an adversarial review on the design record before any implementation lane starts, then spec-first conformance vectors written from the reviewed record, then a second review on the code with compiled probes against the target's exact dependency versions and reproductions on the built artifact, then an independent conformance runner — gates that each catch a different defect class. Covers what a design review can and cannot catch, recording its findings as decisions that supersede the draft, "probe the remedy, not only the risk" (the fix itself can rest on a wrong assumption about a third-party parser, matcher or rewriter, or trade away a property the record still claims — ordering vs. idempotency, one overwrite fixed by its opposite), handing every design-review remedy to the next gates as an explicit target, probes pinned to the target's lockfile, searching for the twin of every finding, and how to compare review cost honestly between iterations. Use when integrating with a third-party tool, protocol or file format you do not control; before launching parallel implementation agents; when a previous iteration's review round cost as much as the build; when a decision record (ADR, RFC, design doc) is drafted; when a reviewer says "probably" about library behaviour; when a QA author finds "spec gaps" in a design record; or when asked for a "design review", "ADR review", "pre-implementation review", "layered review" or "review the plan first".
metadata:
  version: "0.2.0"
  origin: "javis-dog G4; updated ad-hoc-self-report (S5d)"
  confidence: "medium (gates catching different defect classes: two iterations; design-review remedies carrying the next gate's main findings: two iterations; compiled probes: once); low (that this ordering lowers total cost: three confounded data points)"
---

# Review the design before the code

A code review finds what the code does wrong. Many expensive defects are already in the design: a privacy path nobody modelled, a wrong reading of a vendor's counters, a config edit the host tool will undo. When the review only sees the code, every such finding means re-building, re-testing and re-reviewing. A review of the design record, before lanes start, moves those findings to the cheapest moment.

The rule: **review the decision record adversarially before implementation; treat the review's remedies as new design that the next gates must attack; verify third-party assumptions with probes at the target's versions; let independent vectors and an independent runner check what the reviews missed.**

## Forces

- **Early vs. concrete.** A design is cheap to change but abstract; reviewers can only test claims, not behaviour.
- **Assumption vs. evidence.** Both the designer and the design reviewer can share a wrong belief about a dependency ("`localhost` in `NO_PROXY` covers 127.0.0.1"). Only running the dependency settles it.
- **Speed vs. gates.** Each gate costs time; skipping one moves its defect class to a later, costlier gate or to users.

## 1. Gate 0 — design review on the draft

Brief a read-only reviewer with the draft decision record, the research notes and the readiness rows it relies on. Ask it to attack:

- **Data paths:** where can content, identity or secrets go that the design did not intend? (Redirection, inherited environment, stdout that becomes model context.)
- **Money and counts:** does every counter mean what the design assumes? Look for official tests in the vendor's source, not only docs (in the origin, a vendor test showed `input = cached + cache_write`, so subtracting only `cached` double-counted).
- **Edits of other tools' files:** what does the host do to the file afterwards (rewrite, reorder, trust by position)?
- **Shells and platforms:** which shell runs your command, with what quoting, on each OS?
- **Unverified facts:** which UNVERIFIED items does the design rest on, and what is the safe reading for each?

Ask for severity and a reason per finding. Then:

1. Decide every finding before lanes start — owner decisions for product, privacy, cost or dependency questions; orchestrator decisions for the rest.
2. Record them as a dated *Changes* entry that **supersedes** the draft where they differ, with the finding ids.
3. Write the contract stubs from the reviewed design, then launch lanes.

### Remedies are new design

A design review fixes what it finds by adding rules, and those rules have not been reviewed by anyone. In two consecutive iterations of the origin, the most important findings of the *later* gates sat in the design review's own remedies:

- a proxy guard and a config-block rule prescribed by the review rested on wrong assumptions about the target's libraries (found by the code review's probes);
- a precedence rule that stopped one overwrite (end-of-turn idle erasing an agent's "blocked") created the opposite one (an agent's "working" surviving a real permission prompt) — found by QA writing vectors;
- an id scheme chosen to keep a spool ordered put the clock into the event id, while the record still claimed that a re-run hook is de-duplicated — found by the code review.

So, for every remedy:

1. Write the **property it must preserve** next to the property it adds ("keeps spool order *and* still de-duplicates re-runs").
2. Ask what it **trades away**, and in which direction it can now fail.
3. List the remedies in the briefs of QA and the code reviewer as explicit targets.

## 2. Gate 0.5 — spec-first vectors from the reviewed record

Before any runner exists, QA writes black-box vectors from the reviewed decision record only (see `independent-conformance-vectors`). Writing exact expectations forces every ambiguous line into the open: in the origin, 19 "spec gaps" in one record, one of them a real design defect. Resolve them in the record (dated *Changes*), tell the running lanes before they build the wrong rule, and only then write runners.

## 3. Gate 1 — code review with compiled probes

After merging the lanes, brief the reviewer on the combined diff with a rule: **every claim about third-party behaviour gets a probe**.

- Read the target's lockfile and use the **exact versions** of the libraries that implement the behaviour (HTTP client proxy matching, TOML/YAML/JSON round-tripping, path or glob matching, timestamp parsing).
- Write the smallest program that calls the library the way the target does; run it with the inputs your code relies on; record versions, input and output.
- **Probe the remedy, not only the risk.** The design review may have correctly named a risk (proxy redirection, a config edit) and still prescribed a remedy that rests on a wrong assumption. In the origin, both code-review highs were in areas the design review had covered: the proxy guard trusted `localhost`, and the config block was found by an end marker the host's rewriter moved.
- A probe that confirms the design is evidence too; record it.
- **Reproduce on the built artifact.** Ask for every medium-or-higher finding to be reproduced against the shipped bundle or binary, not only read from the diff. A reviewer who ran the built CLI found a duplicate-recording defect that unit tests and vectors had both missed because they pinned one clock.
- **Probes must not reach production.** A probe run of your own CLI with default settings may talk to the production endpoint. Brief the reviewer to point every probe at a dead local endpoint or a sandbox; in the origin one probe sent a single request with a fake token to production (401, nothing written) before the reviewer switched.

## 4. Gate 2 — the independent runner

QA writes vectors from the decision record; a lane that wrote neither the code nor the vectors writes the runner (see `independent-conformance-vectors`). Run it against the code **before** the review fixes: its failures are either already-known review findings (expected) or new defects. In the origin, the runner found a defect neither developers nor reviewers had seen (a re-sent record got a new sequence number, which the server later shows as possible data loss).

## 5. After every finding, look for its twin

A defect in one adapter, platform or module often exists in its sibling. When you fix one:

- Search for the same pattern (same helper, same config shape, same promise pattern) across the workspace.
- **Read the search output before writing "no others".** Then record the search and its result.

## 6. Compare review cost honestly

Retros will say "the review round cost as much as the build". Before adopting a gate because of it, record comparable numbers per iteration: findings by severity per gate, fix-commit size vs. build-commit size, elapsed time. State the confounders (a second iteration benefits from the first; different targets have different difficulty). One comparison is a hypothesis, not a measurement; three confounded ones are still a hypothesis.

### What each gate caught (one iteration, for calibration)

| Gate | Caught | Defect class |
|---|---|---|
| Research, with the orchestrator re-reading decisive source lines | Every host runs its post-tool hook for the integration's calls, with the session id → one correlation path for all hosts | Architecture fact |
| Design review on the draft | An end-of-turn event overwrote the new state; urgent records waited in a batch spool; two records per call | Semantics, precedence, delivery |
| Orchestrator reading the reviewed draft | Pre-call hooks would leave unmatched "started" events | Lifecycle pairing |
| Spec-first vectors | 19 gaps; the precedence remedy hid a real permission prompt | Contract ambiguity, remedy defect |
| Runners with mutations | 3 surviving mutations → coverage gaps; one record clarification | Test coverage |
| Code review on the built bundle | Re-fired hook recorded twice (frozen-clock tests hid it); a git check failing open; uninstall blocked by a foreign file; config keys joining the wrong table | Runtime and environment behaviour |

## Pitfalls

- **Reviewing only the code.** Design defects come back as rework.
- **Accepting "probably" from a reviewer.** Ask for the probe.
- **Probing against the latest library version.** The target ships its lockfile's version.
- **Treating gate 0 as complete.** It finds risk classes; vectors, probes and the runner verify the remedies.
- **Unlabelled remedies.** A remedy nobody lists as new design is reviewed by nobody.
- **Fixing the instance.** The twin ships.

## Template

```markdown
## Changes — <date> (design review D0, before code: <n> high, <n> medium; owner decisions "<…>")
- **H1 <title> (<class>).** Finding: <what, with source line>. Decision: <what changes>. Supersedes: <section>.
- **Still UNVERIFIED** (runtime): <facts> → readiness row <name>.

## Changes — <date> (code review V1; probes against <lib> <version>, <lib> <version> from <target> lockfile)
- **V1-H1 <title>.** Probe: <input> → <output>. Supersedes D0 wording "<…>".
```

## Evidence from origin project

Javi's Dog, Sprints 5b and 5c (2026-10-29), two collectors for third-party coding CLIs built by parallel agent lanes. Confidence **medium** for the gates (each used once, with recorded findings); **low** for the cost claim.

- S5b (code review only): 1 high and 5 medium after the build — telemetry redirection, first export lost, input − cache split across start times, series merged across hidden attributes, `estimated` set for exact tokens, cost for non-per-token auth (`docs/sprints/SPRINT-05b.md` Team log V1). Retro: "The review round cost as much as the build"; change: "Run the Reviewer on the ADR draft, not only on the code." Guru measured insertions: build `41f179b` + `092c0f2` ≈ 3 944 lines; review fixes `5e2bd33` + `c0bfde2` ≈ 1 973 lines (about half).
- S5c (design review first): D0 on the draft found 6 high (proxy redirection, a header leak into the vendor's export, cache-write double count, hook shell, stdout reaching the model, TOML safety) and 5 medium "before a line was written"; decisions recorded as ADR-0016 *Changes* "S5c design review D0" (`2a1131d`) before the stubs (`6756557`) and lanes (`docs/sprints/SPRINT-05c.md` Team log and Retro). Code review V1 then found 2 high, 2 medium, 2 low; fixes `ffd1bdd` ≈ 1 292 insertions vs. build `214334e` + `bcddab3` ≈ 5 342 (about a quarter). Confounders: S5c followed S5b's lessons and targeted a different tool.
- Probes: "reviewer probes compiled against hyper-util 0.1.20 and toml_edit 0.24.0 from Codex's Cargo.lock" — `NO_PROXY=*` / `localhost` proxied `127.0.0.1`; the rewriter moved the trailing end-marker comment after appended tables (ADR-0016 *Changes* V1). The probe programs are not committed; the record holds versions and results. S5c retro: "for a third-party integration, write a probe of the target's real parser or matcher behaviour as part of the research, not only during review."
- Runner: Codex runner 39/41 against pre-fix code; U01 and U11 failed on the re-send sequence defect, fixed with persisted accepted ids (`4f4b42f`, `ffd1bdd`; ADR-0016 *Changes* "S5c review fixes").
- Twins: S5b's backup-holds-secret finding (R7) had a twin in the older Claude Code path, fixed red-first (`c0bfde2`). An unhandled-rejection fix (`d3ebf6d`) had a twin in the SDK spool; the first log entry said "no other … (grep)" and was corrected in `ce3f3f7` after the same grep showed the second instance.
- Not verified: that gate 0 shortened the iteration (S5c also exceeded its timebox, per its retro).

### Update at ad-hoc-self-report (Sprint 5d, 2026-10-30)

A local MCP server for agent self-report plus hook mappings for three host CLIs (ADR-0017; `docs/sprints/SPRINT-05d.md`). Retro: "Each independent check caught what the previous one missed. Research verified hook firing in source. The design review found the end-of-turn overwrite. QA found the permission-prompt masking (G8). The code review found the re-fire duplicate, which a test with a frozen clock had hidden."

- D0 before code: 2 high (H1 end-of-turn `idle` overwrote self-reports; H2 reports waited in the spool), 7 medium, 5 low; "Orchestrator verified H1/H2 in `mapping.ts:103-104`, `queries.ts:21,80-81`, `run.ts:23,228-236`"; orchestrator found the unmatched `task.started` (`SPRINT-05d.md` Team log; ADR-0017 *Changes* D0, `2d4dcc2`).
- Remedy → later finding, verified in the record's history: ADR-0017 at `2d4dcc2` lists `attention.requested` under "What does not clear it" (D0 H1 remedy) → QA gap G8, inverted in `c25cf2d`. The same revision says the HMAC-seeded ULID "keeps the spool's time order (review M5) and dedupes a re-run hook" (l. 105–106) → code review M1 "the event id's time part is the wall clock" (`d6c989b`).
- QA: 50 vectors, then 54, from the record only; "19 spec gaps; G8 was a design defect … Developers A and B were told mid-lane" (`SPRINT-05d.md` Team log; `1f40a78`, `781c561`).
- Code review: 0 high, 3 medium, 5 low, "all Mediums were reproduced against a built bundle"; reviewer disclosure: one probe `init` without `--endpoint` "sent a single request with a fake token to production. It got `401`; nothing was written. Later runs used a dead local endpoint." The reviewer also closed an UNVERIFIED item by reading the host's source (`hook_runtime.rs:1144`).
- Cost data point (Guru's insertion counts, confounded: different feature, third iteration with this process): build `1600c47`, `c585810`, `8c85373`, `d1ebc8b`, `a29d7d0` ≈ 6 525; QA-gap fixes `bc0e3c6`, `509262e`, `d9b51eb` ≈ 141; code-review fixes `d6c989b` … `eab49c8` (7 commits) ≈ 798 (≈ 12 % of the build). S5b ≈ 50 %, S5c ≈ 24 %. Still a hypothesis.
- Process cost not measured: the sprint "ran well past the 30-minute timebox" (retro).
