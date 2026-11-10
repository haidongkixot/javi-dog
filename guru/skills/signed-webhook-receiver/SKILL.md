---
name: signed-webhook-receiver
description: Build a receiver for a third-party vendor's signed webhooks (HMAC signature header over the request body, such as a GitHub App, a payment, chat or e-commerce platform) that stores only what it should — a fixed check order (configured, encoding, header shape, size, signature over the raw bytes, dedupe, shape, routing, age, map, validate, store), nothing parsed before the signature passes, dedupe and event ids from the signed body instead of unsigned delivery-id or event-type headers, replay bounded by timestamps inside the signed payload, hash-recording rules that keep the vendor's manual redelivery useful (record after success, never on a 500, never purge hashes of events with no timestamp), runbooks that match those rules, ownership claims verified from a signed delivery and not from a redirect's query parameter, one secret-validity rule shared by handler, setup screen and health check, a vector and mutation list, the first real run (secret deployed and proven with a self-signed ping before the vendor sends a lifecycle event it never retries, a new event after linking, evidence read from the vendor's delivery log, safe log fields and read-only rows), and lost terminal deliveries (a started run with no result after the vendor's maximum run time). Use when adding a webhook endpoint, an "install our app" integration, a vendor callback, a signature check (`X-Hub-Signature-256`, `X-…-Signature`, HMAC-SHA256), webhook dedupe or replay protection, a "redeliver" or "resend" instruction in a runbook, a setup flow that returns an installation or account id in a redirect URL, secret rotation for a webhook, the first real installation of a webhook integration on production, a "running" state that never ends because a completion delivery was lost, or when reviewing a receiver that parses JSON before verifying or dedupes on a delivery-id header.
metadata:
  version: "0.2.0"
  origin: "javis-dog ad-hoc-github-bridge (S5g, JD-M10 GitHub App bridge); updated ad-hoc-github-followups (S5h, real app run)"
  confidence: "medium (check order, raw-byte HMAC, signed-body dedupe and hash-recording rules: one iteration, design review before code, 59 independent vectors through the real route on an embedded Postgres, 7 mutations caught, review fixes red-first; first real run with one vendor (GitHub): signed ping 202, installation 200, two activity deliveries 200 stored, the vendor's own duplicate kind 202 dropped, once); low (vendors other than GitHub: not tried; the vendor's response-time budget under load: not measured; constant-time comparison is checked by code shape only, not by timing; the lost-delivery rule of section 9: one iteration, no real lost delivery observed)"
---

# Signed webhook receiver

A webhook endpoint is a public, unauthenticated URL that writes to your database. The HMAC signature is the only thing that makes a request trustworthy, and it covers **the body bytes only**. Everything else the vendor sends — delivery id, event-type header, often the timestamp — may be unsigned. A receiver that dedupes, routes or ages deliveries on unsigned values can be replayed or confused by anyone who captured one request.

The rule: **verify the raw bytes first, then trust only what those bytes say, and choose deliberately what you remember about each delivery.**

## Forces

- **Replay vs. redelivery.** You want a captured request to do nothing a second time, and the vendor's manual "redeliver" to work after an outage. Both send the same bytes.
- **Dedupe vs. late routing.** A delivery that arrives before the user linked anything is dropped; whether you remember it decides whether a later redelivery can be stored.
- **Strictness vs. vendor drift.** A strict shape check rejects junk and also rejects a payload the vendor slightly changed.
- **Minimization vs. usefulness.** Vendor payloads carry names, emails, titles and messages; you need ids, states and times.

## 1. Fix the check order and write it into the decision record

| # | Check | Outcome | Why here |
|---|---|---|---|
| 1 | A valid current secret is configured | `503 not_configured` (a previous secret alone is not enough) | Nothing else is meaningful without it; never claim "connected" |
| 2 | `Content-Encoding` absent or identity | `415` before reading the body | Do not decompress untrusted input before authentication |
| 3 | Signature header matches the exact format (e.g. `^sha256=[0-9a-f]{64}$`) | `401` before reading the body | A malformed header can be refused for free |
| 4 | Body size ≤ cap (refuse a declared `Content-Length` above it unread) | `413` | Bound memory before the HMAC |
| 5 | HMAC over the **raw bytes**, current then previous secret, constant time on equal-length buffers | `401`, one body for every cause | "Without saying which" |
| 6 | Body hash already seen | `202`, nothing else | Dedupe on signed content (§2) |
| 7 | Payload shape matches exactly one known kind, and the event header agrees | `202` otherwise | The header is a hint, not a fact (§3) |
| 8 | Lifecycle events (install, uninstall, suspend) | apply rows → `200` | They usually carry no event time (§2) |
| 9 | Activity events: tenant routing, age from the payload's own timestamp, mapping, validation | `202` dropped / `200` stored | Inline, inside the vendor's response budget |
| 10 | Store failure | `500`, nothing remembered | So redelivery can succeed (§2) |

Logs carry only the delivery id (after verification, and only if it has the expected shape), event, action and outcome — never headers or bodies. Driver errors can echo connection strings; catch them and log a fixed outcome word.

**Read raw bytes yourself.** A shared "bounded body" helper that returns decoded text breaks the HMAC: decoding drops a byte-order mark and fails on invalid UTF-8 before you know whether the signature is valid. In the origin, the decision record named such a helper; the implementer wrote a byte reader and recorded the deviation.

## 2. Dedupe, replay and redelivery from signed content

If your vendor's delivery-id and event-type headers are not signed (true for the origin's vendor; check yours), they are attacker-controlled. So:

- **Dedupe key = SHA-256 of the raw body.** The vendor's own redeliveries send identical bytes, so they dedupe too.
- **Event ids = UUIDv5(namespace, `<body_sha256>:<index>`)**, with the namespace written down as a derivation (e.g. UUIDv5 of a URL). Your event store's own dedupe then is a second net.
- **Replay bound from inside the signed payload.** With no signed timestamp header, use each event's own time field (e.g. the object's `updated_at`), per event kind, and drop deliveries older than the vendor's redelivery window. Do not use a creation time or a nested commit time that an attacker can pick from an older capture.

**When to record the body hash** is the subtle part. Write each case into the record:

| Outcome | Record the hash? | Consequence |
|---|---|---|
| Stored or rows applied (`200`) | Yes, in the **same transaction** as the write | A replay does nothing |
| Store failure (`500`) | **No** | The vendor's redelivery is processed |
| Dropped as unwanted: unknown kind, unlinked target, too old (`202`) | Yes (origin choice) | A replay does nothing — **and a redelivery after linking stores nothing either** |
| Rejected by your validator for a reason time can change (event time in the future) | No | A later redelivery is judged again on its own time |
| Lifecycle events with no event time | Yes, and **never purge** these hashes | Otherwise an old uninstall or suspend body replayed after the purge acts again |

Activity hashes can be purged after the replay window, because the age check then drops the replay anyway; lifecycle hashes cannot, because nothing else stops them. They are few.

**The runbook must match the table.** In the origin, the how-to said "claim and link, then redeliver" — but an unrouted delivery had been acknowledged and remembered, so its redelivery was a duplicate. The adversarial reviewer traced the rule; the fix was the runbook ("trigger a new event after linking; redelivery helps only after a `500` or a lost delivery"), not the binding dedupe rule. Treat every recovery instruction ("redeliver", "retry", "re-run") as a claim about your dedupe state and check it against this table.

## 3. Classify from the payload, not the header

- Define a **strict shape table**: for each kind, the required fields and their JSON types. Exactly one row must match; the event-type header must equal that kind; a missing header counts as disagreeing (`202`).
- A field every delivery carries (an `installation: { id }` stub) does not make a payload a lifecycle event; require the distinguishing part (`installation.account`).
- Do not over-tighten fields you only read optionally. In the origin, a CI suite whose `app` object had no string `slug` was first treated as malformed; the vector for "unknown or missing slug → `other`" caught it.
- Unknown kinds and actions, pings and the vendor's own duplicates of your other inputs (e.g. its CI suites when you already map its CI runs) are dropped, not stored.

## 4. Store an allowlist, prove the rest is absent

Map each kind to your own event with a closed attribute set; write a **never-stored list** (messages, titles, bodies, logins, names, emails, file lists, URLs, workflow paths, branch and tag names). Plant a marker string in every forbidden field of every fixture — including lifecycle payloads (contact emails, requester, sender) — and assert it never appears in events, rows or captured logs. A server-side hash of a short guessable value (a branch name) is not a privacy measure.

## 5. Ownership: verify from signed data, refuse what you cannot verify

- A setup redirect's query parameters (`installation_id=…`) can be edited by anyone; treat them as a hint only.
- A user may claim an installation only when **their linked vendor account id equals the account id in a signed lifecycle delivery** — verifiable without any API call. Cases you cannot verify that way (e.g. organization accounts) are refused with a clear message, not approximated.
- First claim wins with a conditional update (`… WHERE claimed_by IS NULL`); a link update re-checks the row's own current value so a concurrent second link cannot overwrite the first.
- Unknown, foreign and malformed ids get **one** generic answer, so ids cannot be enumerated; check the account first.
- Releasing a claim clears its links and its "last verified delivery" evidence.
- Show an install link only to a viewer who can complete it (in the origin: a public owner-account id gates the link); everyone else reads "available only to this deployment's owner".

## 6. Secrets: one validity rule everywhere

Pasted secrets often carry a trailing newline. Decide once — unset or whitespace-only is absent; surrounding whitespace is a configuration error (`503`, logged by name, never by value) — and export that function. The handler, the setup page and the health endpoint must all call it. In the origin, the setup page re-implemented the rule and the health endpoint used a plain "non-empty" check, so health could say "present" while the handler refused (see `presence-only-health-endpoint`). Rotation: accept current then previous; remove the previous when done.

## 7. Structure for testability

If your persistence module composes the receiver's tables into its migrations, it depends on the receiver package, and the receiver cannot import it back. Make the handler a factory over injected store functions (`hasDelivery`, `applyLifecycle`, `insertEvents`, `recordDelivery`); the app wires the real ones. That also gives you the seam for fault tests — inject the fault **at one call**, not for the whole request (see `independent-conformance-vectors` §5).

## 8. Verify

- Known answers: the vendor's documented signature test vector, reproduced with your crypto library, plus byte-level cases (BOM, trailing LF, CRLF, invalid UTF-8, non-ASCII secret).
- Independent vectors from the decision record, run through the real route on a real database engine, with a mutation list: [`references/mutation-checklist.md`](references/mutation-checklist.md).
- Row-level tests for claims, links, races (an embedded single-connection engine cannot run two statements at once; test the statement shape and say so).
- **A real vendor delivery is the only proof the integration works.** Until it runs, the status page says "not set up" or "waiting for the first delivery" (see `truthful-live-status` §10) and the record says NOT RUN.

## 9. The first real run

The order matters more than any single step, because some vendor events are sent once:

1. **Secret deployed before anything can be sent.** Set the secret where the receiver reads it, redeploy (variables usually reach new deployments only), and check presence through your health endpoint (a boolean, see `presence-only-health-endpoint`).
2. **Prove the deployed secret with a self-signed ping** before installing: a small script reads the secret from the vendor's result file, signs a harmless body (a `ping` kind your receiver acknowledges and drops) and posts it. `202` = the deployed secret matches; `401` = it differs (often a pasted trailing newline); `503` = the new deployment is not live yet. The secret never leaves the script. Vary the body on each run so dedupe does not swallow a repeat.
3. **Then install.** In the origin's vendor, the installation event is sent once and not retried automatically; if the receiver answers `503` at that moment, the installation never appears to claim until someone redelivers it by hand inside the vendor's window.
4. **After linking, trigger a new event** (re-run a CI job, push to an open pull request). Deliveries from before the link were acknowledged and remembered (§2); redelivering them stores nothing.
5. **Read the evidence without write access:** the vendor's delivery log (status per delivery, the owner looks), your runtime logs filtered to the safe fields of §1 (delivery id, event, action, outcome), and read-only queries for the stored rows' shape (count, type, privacy class, attribute **names**, timestamps) on **the database the deployment actually reads** (see `bounded-production-verification` §8). Record times and status codes per delivery, not payloads.

The vendor's own duplicate kinds (its CI suite next to the CI run you map) should show up as acknowledged and dropped (`202`); seeing that on the first real run confirms the classification of §3 against real traffic.

## 10. A lost delivery leaves a state open

Push integrations lose deliveries (outage, a `500`, the vendor gives up). A "started" event whose "completed" never arrives would read as running forever. Close it **in the reader, by time, in words that state only what is known**:

- After the vendor's documented maximum run time (the origin used 6 h, the hosted CI job limit), count the item as "No result received", separately from running, finished and failed. Never "Failed" — the run may have passed.
- Say what the label means for long runs the limit does not cover (self-hosted runners): it still reads "No result received" until the result arrives, which stays true.
- Boundary test at the threshold and one second before; the client-side ageing moves the item across the threshold without a new snapshot (see `truthful-live-status` §11).

## Pitfalls

- **`JSON.parse` before the HMAC**, or an HMAC over re-serialized JSON or decoded text.
- **Dedupe on the delivery-id header.** A replay with a fresh id passes; two different bodies sharing one id lose one.
- **Hash recorded before a write that then fails.** The vendor's redelivery is swallowed as a duplicate.
- **Purging every hash after N days** while lifecycle events are exempt from the age rule.
- **"Redeliver after you link"** in a runbook while unrouted deliveries are remembered.
- **`timingSafeEqual` on buffers of different lengths** — it throws; length-check first.
- **Trusting the setup redirect's installation id.**
- **A health or setup screen with its own idea of "configured".**
- **Installing before the deployed secret is proven.** A lifecycle event answered `503` is not retried by itself.
- **"Running" with no end.** A lost completion delivery keeps a run open unless the reader closes it by time.

## Evidence from origin project

Javi's Dog, Sprint 5g (2026-11-01), JD-M10 GitHub App bridge; decision record `docs/adr/0019-github-app-bridge.md` (decisions 1–8 and every *Changes* entry), vectors `docs/jgr/conformance/github/README.md`, sprint record `docs/sprints/SPRINT-05g.md`. Confidence **medium** (one iteration; every rule below was checked by vectors or red-first tests); **low** for real deliveries (owner step, NOT RUN).

- Research from GitHub's docs source and REST OpenAPI description (docs site blocked): no timestamp header, delivery GUID kept on redelivery, manual redelivery up to 3 days, 10 s reply budget; the documented HMAC test vector reproduced with `node:crypto` (ADR-0019 *Research*, `971d61c`).
- Design review before code, 4 High (`056a203`): replay and dedupe on unsigned headers (H2), the 3-day rule without a timestamp (H4), schema unable to enforce the tenant (H3), owner-only scope (H1). The orchestrator verified H2 in code (dedupe key `(project, producer, event_id)`; the GUID header is unsigned).
- QA vectors from the record only (59 vectors, 174 steps; 2 756 cross-checks by two independent programs): gaps G14 (a `500` must not leave a hash, or redelivery is swallowed) and G17 (installation hashes purged after 3 days → replay acts again) were defects in the H2 remedy; fixed in `3d7effc` (hash recorded last, installation hashes kept).
- Byte reader instead of the decision record's text helper; G21 (validator rejection records no hash); G24 (`check_suite` without an app slug → `other`, found by vector M12, `f62dabf`) — ADR-0019 *Changes*, wave 2.
- Runner through the real route on PGlite: 257 tests PASS (59 vectors, 174 steps, 20 signature cases, R21 supplement); 7 mutations caught (`46131a3`, `1c70a7c`). Which 7 is not recorded.
- Adversarial review of the built code, 0 High / 2 Medium / 6 Low (`SPRINT-05g.md` Team log): M-1 runbook "redeliver after linking" vs. the remembered `202` → runbook fixed (`4cc0583`); L-1 secret whitespace rule shared by handler, setup status and health (`a18304f`, `fe92c73`); L-2 claim enumeration; L-3 release clears evidence; L-5 link race (`a18304f`). "Every new test failed before its fix except the PGlite link race" (statement-shape test instead).
- Injected-deps handler because the event store already depends on the bridge package (`fbebc0c`; sprint Team log "so no cycle"; retro).
- Open follow-ups, not fixed: a late delivery can briefly restore an old repository name (display only); a run whose `completed` delivery was lost counts as running for 24 h.
- Not verified: GitHub accepting the local helper's loopback redirect; a real delivery with a `200` in the vendor's delivery log; behaviour under the vendor's 10 s budget; other vendors' header and signing schemes.

### Update at ad-hoc-github-followups (Sprint 5h, 2026-11-09/10)

Real app run and the follow-ups of the S5g review (`docs/sprints/SPRINT-05g.md` Log 2026-11-09, `docs/agent-ops/TEST_PLAN.md` §S5g "Real app" and §S5h, `docs/sprints/SPRINT-05h.md`, ADR-0019 *Changes* "S5h"). Confidence for a real delivery raised from **low** to **medium** (one vendor, one run); a second vendor is still missing, so the skill stays "not yet" for wider sharing.

- Setup by the owner with a local agent, following an agent/owner runbook (`docs/how-to/local-agent-github-app-and-token.md`, `8f045e2`): secret set through stdin, redeploy, self-signed ping, then install (see `prove-secrets-and-pii-minimization` §10).
- Recorded sequence (UTC, production reading the development database, deployment at `8f045e2`): 22:07 signed local ping `202`; 22:24 `installation created` `200` applied; repository linked 22:28; 22:29 `workflow_run in_progress` `200` stored (`task.started`); 22:37 `check_suite` from the vendor's own CI `202` ignored; 22:37 `workflow_run completed` `200` stored (`task.completed`, with duration). Both events at the lowest privacy class, attributes by name only, hashed thread refs; the project's last-signal and last-verified-delivery times set to 22:37:32. "Logs carry GUID, event, action, outcome only" (TEST_PLAN §S5g, `cba33a4`). The vendor accepted the local helper's loopback redirect, the last unverified assumption of the setup design.
- Guru probe (read-only, CI history): the branch's CI run for `8f045e2` has a second attempt started at 22:29:21 by the owner's account, after a green first attempt — consistent with the runbook's "re-run a workflow" trigger and the 22:29 `in_progress` delivery. That the linked repository was this one is Guru's inference; the record does not name it.
- §10 from review follow-up L-6a: S5h H1 (`6d4e316`) counts a CI thread whose newest event is `task.started` and older than 6 h as `ciNoResult`, label "No result received"; decision and its reason in ADR-0019 *Changes* "S5h"; red-before for every new test group (sprint Test evidence). Before S5h such a run counted as running for 24 h.
- Not verified: behaviour within the vendor's 10 s budget under load; a real lost completion delivery; organization installations (refused by design); any second vendor.
