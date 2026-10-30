---
name: truthful-live-status
description: Keep dashboards, status pages, cards, notifications and emails truthful once real data flows — freshness derived by the reader from a trusted clock (fresh / stale / ended, never sent by producers), status and staleness shown together, every derived flag the UI needs carried in the contract type instead of re-derived per component, distinct states never merged into one field ("sent" vs "covered" vs "failed"), ages that keep running on the client clock, absolute timestamps on server-rendered or read-once views instead of a relative "ago" that freezes, "not current" when refreshes fail, request timeouts so polling never stops silently, display rounding that can never cross a decision threshold, and "estimated" counts propagated through every aggregate; and states an agent or producer reports about itself shown as labelled claims next to measured signals, with precedence rules that let real evidence (a permission prompt) win. Use when building a live or near-real-time dashboard, polling or streaming UI, freshness or heartbeat indicators, "last seen / updated N ago" labels, usage or cost analytics, budget or quota cards, alert or delivery status ("emailed", "sent", "delivered"), percent-of-limit badges, self-reported agent status ("blocked", "done", "reported by agent"), or when reviewing a UI that could show stale, estimated, undelivered or merely claimed data as current, exact, done or measured.
metadata:
  version: "0.2.0"
  origin: "javis-dog G3; updated ad-hoc-self-report (S5d)"
  confidence: "medium (sections 1–8: three consecutive iterations of one product, each time found by an adversarial reviewer and fixed red-first; section 9: one iteration, precedence pinned by independent vectors and mutations); low (behaviour with real users, real traffic and real agents — not yet observed)"
---

# Truthful live status

A status UI is a stream of claims: *this agent is working*, *this was updated 12 s ago*, *you were emailed*, *you used 80 %*. Each claim has a source and an age. Once real data exists, the empty-state work is over and a quieter failure starts: values that were true when computed are shown as if they still are, one component re-derives a state slightly differently from another, and a rounded number crosses a threshold the data has not crossed.

In the origin the same class of defect appeared in three consecutive iterations, each in a new component, each found by the reviewer rather than by the lane's own tests. The common shape: **the truthfulness rule lived in one place (a hook, a doc comment, one component), not in the contract the components share.**

The rule: **derive truth once, in the read model, put it in the contract type with a precise name, and make every view render from those fields with times that keep moving or are absolute.**

## Forces

- **Server rendering vs. ageing.** A server-rendered "2 min ago" is correct at render time and wrong a minute later on an open page.
- **Convenience vs. single derivation.** Each component can compute "needs attention" or "was alerted" from raw fields; each will compute it slightly differently.
- **Compact contracts vs. explicit states.** One field "alerted (sent or covered)" is compact; it lets the UI say "emailed" for a state where no email went out.
- **Readable numbers vs. decisions.** Rounding 79.99 % to "80 %" reads well and claims a threshold that was not reached.

## 1. Derive freshness in the reader, from one clock

- Producers never send "stale". The reader derives it from silence: `fresh` while `now − lastSignalAt ≤ window` (inclusive, state it), `stale` after, `ended` when the last event closes the thread. An ended thread is not stale and does not need attention.
- `now` comes from one trusted clock (the database's `now()`, truncated to the precision you compare at), returned with the snapshot as `generatedAt`.
- Show **status and freshness together**: a thread that was "waiting" and went quiet still says "waiting", labelled stale — never hidden, never upgraded to "live".
- Do not call anything "live". "Recent activity" is honest; "Live activity" is a claim about the future.

## 2. Put every derived flag the UI needs into the contract type

Before lanes start, list every decision a view will make and give each one a field in the read model's output type, computed once in the reader and covered by its tests and conformance vectors:

| Instead of each view computing… | The contract carries… |
|---|---|
| `attention && !ended` in some places, `attention` in others | `needsAttention: boolean` — drives every count, sort and label |
| "tokens are exact" | `estimatedReports: number` — the UI says "includes estimated counts (N of M)" when > 0 |
| "alerted" from "sent or covered" | `alerted` (email actually sent), `pendingAlerts`, `failedAlerts`, `exhaustedAlerts` |
| a threshold from a rounded percent | `thresholdReached` from exact arithmetic |

**Never merge distinct states into one field.** If two states would make the UI say different words, they are two values. Write the field's doc comment as the sentence the UI may say ("thresholds whose email was sent").

## 3. Keep times moving, or make them absolute

Pick per view:

- **Polled / interactive views:** age = `generatedAt + (client now − time the snapshot arrived)`, re-rendered on a short tick (the origin: every 5 s). A fresh value turns stale on the client when the window passes, even if no new snapshot arrives.
- **Server-rendered or read-once views** (a card, an email, a report): absolute timestamps with the time zone ("10:15 UTC"; with the date unless it is the viewer's current date, re-checked on the client). Server render and hydration must produce the same text, so the server always includes the date.
- **One shared time component** for every signal/report time, so the choice is made once. A rule that lives in one hook is not applied by the next component.

## 4. Say "not current" when you cannot refresh

- A failed refresh keeps the last data **and** changes its labels: "Not current — last confirmed 10:15:03 UTC" instead of "Fresh / Updated"; headlines go neutral.
- Every refresh request has a timeout (its own timer plus abort, so it works even when the transport ignores abort), and the next poll is always scheduled. A hung request must not stop polling silently.
- Pause polling while the view is hidden and say so ("while this tab is visible").

## 5. Claims about side effects come from their recorded outcome

"Emailed", "sent", "delivered", "synced" appear only when the stored state says the side effect succeeded. Show pending, failed and gave-up states in words. If delivery can repeat (retries after partial failure), say "usually one email", not "one email".

## 6. Display rounding never crosses a decision

- Compute decisions (threshold reached, over limit) with exact arithmetic (integer minor units, decimals), not floats.
- Display values derived from the same exact arithmetic and **floored** toward the safe side (79.99 % shows "79 %" or "79.99 %", never "80 %"). Badges use the decision field, not the displayed number.
- Money-like values that come from producers' estimates are labelled "estimated" wherever they appear, including emails.

## 7. Empty is not zero

No chart of zeros presented as measured usage, no bare `0` for "nothing reported": "No usage reports in the last 14 days", "Not reported". (Pre-data shells: see `honest-empty-states`.)

## 8. Test it where it is cheap, and review for it

- Reader: boundary tables at the window (just inside, exact, just outside), ended vs stale, attention on ended threads; conformance vectors from the contract text (see `independent-conformance-vectors`).
- Views (component tests with fake timers): a fresh value turns stale after the window without a new snapshot; a failed refresh shows "Not current"; a hung request times out and polling continues; no rendered value matches `/\blive\b/i`; every cost text contains "estimated"; "emailed" only for sent.
- Give the reviewer the checklist in [`templates/truthfulness-review.md`](templates/truthfulness-review.md) and ask for a reproducing test per finding. Fix red-first.

## 9. Claims next to measurements

Some producers report a state about themselves: an agent says "blocked: missing credentials" or "completed". That is a **claim**; the host's hooks and telemetry are **measurements**. Show both truthfully:

- **Provenance in the contract.** The read model returns `statusSource` (`agent` | `collector`) next to the status, derived **structurally** (a field only claims carry, such as the reporting tool's name on an event type collectors never give one), never by matching names in UI code.
- **Reasons only from a closed list,** accepted where read only when they belong to the status (`blocked.missing_credentials` with status `blocked`); anything else becomes `null`, never free text.
- **Precedence, written as a table and pinned by vectors:**

  | Later event | Effect on the claim | Why |
  |---|---|---|
  | New work starts or ends (task events, from either source), session or agent lifecycle, a user prompt | clears it | the situation the claim described is over |
  | Measured evidence that the session waits for a human (a permission prompt) | clears it; show the measured `waiting` with attention | otherwise an agent's "working" hides a prompt that blocks it |
  | Passive signals that do not contradict it (end-of-turn idle, usage reports, errors) | keeps it | an end-of-turn idle would otherwise erase every "blocked" a moment after it was said |

  After a claim is cleared by an event that carries no status of its own, show the latest **measured** status from before the claim (or none), never the claim.
- **Scope.** A sub-agent's claim must not set the whole session's status.
- **Attention.** Whether a claimed `blocked` counts as "needs attention" is a product decision; record who decided it. (In the origin: yes, owner decision.)
- **Say it in words.** "Blocked · missing credentials · reported by agent", with an accessible name, in every place a status appears (cards, tables, activity feeds) — not a colour or an icon alone.
- **Expect false claims.** A manipulated agent can claim `completed`. The label and the measured events next to it are the defence; do not let a claim close alerts or budgets.

## Pitfalls

- **An agent's claim hiding a measured wait.** The precedence rule that fixes one overwrite (idle erasing "blocked") can create the opposite one (a claim surviving a permission prompt). Write both directions into the vectors.
- **Rule in a hook, not in the contract.** The next component (a server-rendered card) does not use the hook.
- **Relative ages on server-rendered pages.** They freeze and look current.
- **"Updated" while refreshes fail.** Old data with fresh labels is worse than an error.
- **A union field that maps to one UI word.** "Sent or covered" → "emailed".
- **Rounding up into a threshold.** And a test tolerance loose enough to hide it.
- **Ended counted as attention.** Lifecycle end beats the last status.

## Evidence from origin project

Javi's Dog, Sprints 4a–4c (2026-10-28): agent dashboard, usage analytics, budgets and alert emails. Confidence **medium**: three iterations, one product, one team; every defect reproduced by a reviewer and fixed red-first. Real data and real users: NOT RUN (production had no real events at G3).

- S4a (live dashboard, decision record ADR-0012): reviewer majors — ended threads counted as attention in the UI; values stayed "fresh" while refreshes failed; a hung request stopped polling silently — reproduced in a scratch jsdom test. Fix `2f44dfd` (merged `1c099ce`): `ThreadState.needsAttention` in the contract, client-clock ageing re-rendered every 5 s, "Not current" / "Last confirmed … UTC", 8 s request timeout with polling always continuing, "Live activity" → "Recent activity". Red first: 27 web + 3 read-model tests FAIL against the old code, then green twice (`docs/sprints/SPRINT-04a.md` Team log and Test evidence). Retro: "the read model and the UI disagreed on 'attention' because the contract had no field for it".
- S4b (usage analytics, ADR-0013): reviewer major — relative "ago" on server-rendered usage cards froze on an open page. Fix `da6b7a7` (merged `3eb5852`): absolute UTC stamps (`utc-stamp` component, date dropped only on the viewer's current UTC date, re-checked every minute), `UsageTotals.estimatedReports` with "Includes estimated token counts (N of M reports)". Red first: 32 FAIL (14 + 18), then green twice. Retro: "the rule lived in one hook, not in a shared component".
- S4c (budgets and alerts, ADR-0014): the scaffold contract (`025e35d`) defined `alerted` as "thresholds already alerted (sent or covered)"; the budget card then said "emailed" for covered and failed alerts. Percent was rounded to one decimal (`Math.round(x * 1000) / 10` in `fa20a50`), so 79.99 % displayed as 80 %. Fix `12fdd97` (merged `3302798`): `alerted` = sent only, plus `pendingAlerts`, `failedAlerts`, `exhaustedAlerts`, `thresholdReached`; `percentOfLimit` exact in micro-dollars and floored to 0.01; the card reuses the S4b stamp component. Red first: 43 FAIL across four packages, then green twice (`SPRINT-04c.md`).
- Applied retro actions: S4b's "check the protocol's `estimated` flag" → S4c's scaffold contract already had `estimatedReports` (`025e35d`); S4b's "one shared time-display component" → the S4c budget card imports the S4b stamp component; the S4a dashboard keeps its own client-clock ageing component (two components, not one, at G3).
- Hypothesis: that a reviewer checklist used *before* implementation would have prevented these — not tried; in the origin every case was found after implementation.

### Update at ad-hoc-self-report (Sprint 5d, 2026-10-30)

Agent self-report through a local MCP server (ADR-0017 decision 6; `docs/sprints/SPRINT-05d.md`). Confidence **medium** for §9 (one iteration, independent vectors and mutations); **low** for real agents (real CLI runs NOT RUN).

- First overwrite: the design review found that "the end-of-turn `heartbeat idle` overwrote every self-reported status" (D0 H1); remedy: a precedence rule (ADR-0017 *Changes* D0, `2d4dcc2`).
- Opposite defect in the remedy: the D0 rule listed `attention.requested` among the events that do **not** clear a claim. QA, writing vectors from the record only, flagged it as gap G8: "an agent's `working` would have hidden a real permission prompt" (`SPRINT-05d.md` Team log). Resolution: a permission prompt clears the claim; collector `waiting` with attention (ADR-0017 *Changes* "QA spec gaps", `c25cf2d`). Reader fix red-first: "10 failed, 41 passed" against the previous query, then 112/112 (`509262e`).
- Fallback after clearing (G6), a self-reported task clearing a claim (G7), reason prefix must equal the status (G9): same *Changes* entry; vectors R02, R13, R16–R18 (`docs/jgr/conformance/self-report/README.md`).
- Structural source: "An agent status is … a `heartbeat` that carries a `tool_name`. No collector heartbeat has a `tool_name`" (review L1). Mutations "Keep the agent status on `attention.requested`" → R02, R13; "Match `statusSource` on tool names" → R11 (README mutation table); runner 18/18, mutations caught as recorded (`a78066b`).
- Words, not colour: pill text "Blocked · missing credentials · reported by agent" in squad, feed and agents table (`8c85373`, `bd616f6`); vocabulary equality test between the reader and the shared vocabulary module, red-first (3 new tests failed before the fix, `d9b51eb`).
- Open: whether "N waiting for you" should also count agent-`blocked` threads — wording logged as follow-up F1, not changed.
