# GitHub App bridge conformance vectors (ADR-0019, S5g)

Black-box cases for JD-M10 `@javis-dog/github-bridge` and its webhook route `POST /api/github/webhook` (JD-APP). A vector sends signed GitHub deliveries, byte for byte, and states what must come back and what must be stored. There are four groups:

- **Signature and request (`S*`).** `X-Hub-Signature-256` known answers (S01), current and previous secret, malformed headers, the exact raw bytes, `Content-Encoding`, the 1 MiB cap, and `503` without a secret.
- **Routing, dedupe and replay (`R*`).** The body-hash dedupe, `X-GitHub-Event` against the payload shape, unknown events and actions, `ping`, unlinked repositories, installation mismatch, suspension and claims, the per-event 3-day rule, replayed `installation*` bodies, and the installation and repository rows.
- **Mapping (`M*`).** `workflow_run`, `check_suite` and `pull_request` to JGR events: type, attributes, `thread_ref`, `producer_id`, `event_id`, `sequence`, `occurred_at`, and no `status`.
- **Privacy (`P*`).** Sentinel strings in every field that is never stored, including the installation payload fields `contact_email`, `suspended_by`, `requester` and `sender`.

- **Oracle independence.** Every expected value comes only from the texts under [Sources](#sources). No code under `packages/**/src`, `apps/**` or `collectors/**` was read; the JD-M10 package does not exist yet. `packages/jgr-spec/src/{schema,validate}.ts` was **not** read either: the envelope rules come from spec v0.1 §3–§9. The [self-report](../self-report/README.md), [privacy](../privacy/README.md) and [HTTP](../http/README.md) suites were read for format conventions only. GitHub payload fields come from GitHub's REST OpenAPI description (MIT). Where the texts allow more than one reading, the suite lists a [spec gap](#spec-gaps-g) with a proposed exact rule, and every vector that depends on it names the gap. No value is invented silently.
- **Format.** One JSON file per vector, named `<S|R|M|P><NN>-<kebab-name>.json`, valid against [`schema.json`](schema.json) (JSON Schema draft-07). Every key is always present; `null` means "not applicable" or "not checked", as the field tables say.
- **Fake secrets only.** Every secret here is a fixed, public test string (see [Fixtures](#fixtures)). None of them is, or may ever be, a real webhook secret.
- **Status.** Written 2026-11-01 for S5g task H5 part 1, before any JD-M10 code (QA lane). Hashes, HMACs and ids are known answers computed by a throwaway reference outside the repository and cross-checked by a second, independent method ([Reference computation](#reference-computation)).

## Sources

All at commit `056a203` (branch `claude/clever-goldberg-wlurty`, "ADR-0019 design review D0"). Contract strings in the vectors read `ADR-0019 (056a203)`. Line numbers below (`L…`) are lines of ADR-0019 at that commit.

| Source | Sections used |
|---|---|
| [ADR-0019](../../../adr/0019-github-app-bridge.md) | **Normative.** Decision 1 (events), 2 (current and previous secret), 3 (route checks in order: configuration, size, signature, unwanted deliveries, old deliveries, inline handling, failures, logs), 4 (tables, filled only from signed `installation*` deliveries, removal and deletion, `full_name`), 5 (common fields, mapping table, never stored). The **Changes — Design review D0** entries are binding and win where they differ: H2 (body-hash dedupe, `event_id` from `<body_sha256>:<index>`, shape check, GUID only in logs), H3 (routing conditions, missing `installation`), H4 (per-event timestamps, `installation*` exempt), M1 (no `status`; cancelled and skipped as `x.github.ci.*`), M3 (run, suite and PR threads and sequences), M5 (claim release), M6 (`neutral`, `action_required`, `stale`, `converted_to_draft`), L1 (encoding and header checks before the body is read, raw bytes), L2 (installation payload sentinels). |
| [JGR spec v0.1](../../spec/v0.1.md) | §3 envelope (`event_id` UUID canonical lower case, opaque refs, `sequence` strictly increasing per producer and thread, attributes), §4 types (extensions `x.<vendor>.<name>`), §5 (`status` only where required), §7 L0 attribute allowlist, §9 dedupe on (project, `producer_id`, `event_id`). |
| [TEST_PLAN §S5g](../../../agent-ops/TEST_PLAN.md) | Rows on signatures, route codes, mapping, never stored, the D0 replay row ("the same body with a new GUID or a re-labelled `X-GitHub-Event` stores nothing new; old `installation_repositories` and `suspend` bodies replayed change nothing"), per-event 3-day timestamps, `run_attempt` > 1. |
| [TEAM.md](../../../agent-ops/TEAM.md) | QA role: vectors from spec and ADR text only. |
| GitHub REST OpenAPI description, `github/rest-api-description` `descriptions/api.github.com/api.github.com.json` (version 1.1.4; SHA-256 of the file read: `72e36273…331b6d`) | Webhook schemas `webhook-workflow-run-{requested,in-progress,completed}`, `webhook-check-suite-{completed,requested,rerequested}`, `webhook-pull-request-{opened,reopened,synchronize,ready-for-review,converted-to-draft,closed,labeled,edited,review-requested}`, `webhook-installation-{created,deleted,suspend,unsuspend,new-permissions-accepted}`, `webhook-installation-repositories-{added,removed}`, `webhook-installation-target-renamed`, `webhook-ping`, `webhook-push`, `webhook-issues-opened`; the delivery headers listed under `x-webhooks` (`X-GitHub-Event`, `X-GitHub-Delivery`, `X-Hub-Signature-256`, `X-GitHub-Hook-ID`, `X-GitHub-Hook-Installation-Target-ID` / `-Type`, `User-Agent`). |
| GitHub's webhook documentation (as quoted in ADR-0019 Research) | The signature test vector: secret `It's a Secret to Everybody`, body `Hello, World!`, `sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17`. |

**Payloads are minimal fixtures, not captures.** Every field present has the name, JSON type and enum value of GitHub's OpenAPI schema for that event and action (checked, see [Reference computation](#reference-computation)), but fixtures omit many fields the schemas mark required: the S, R and M vectors carry the fields the ADR reads plus a few sentinel fields; the P vectors carry many more (URLs, labels, reviewers, teams, file lists, installation details). The values (ids, slugs, timestamps, SHAs) are illustrative; an implementation MUST NOT depend on them. The shape check an implementation applies must accept these fixtures ([G10](#spec-gaps-g)).

## Fixtures

| Item | Value |
|---|---|
| Clock | Every vector pins `clock` = `2026-11-01T12:00:00Z` (epoch 1 793 534 400 s). |
| Secrets | Current `qa-webhook-secret-current-NOT-REAL`, previous `qa-webhook-secret-previous-NOT-REAL`, another (never configured) `qa-webhook-secret-other-NOT-REAL`. S01 also uses GitHub's documented secret and a non-ASCII secret. |
| Workspace and projects | Workspace `ws-a` with project `web-app` (L0). M17 adds `api-svc`; M18 uses `secret-app` (L2) instead. |
| Installations | 1001: account 7001 (`User`), claimed by `ws-a`, not suspended. 1002: account 7002 (`User`), unclaimed. App id 880001. |
| Repositories | 5001 (installation 1001, linked to `web-app`), 5002 (1001, not linked), 5003 (1002, not linked), 5004 (no row; added in P06). `full_name`s are `qasentinel-owner/qasentinel-repo-a` … `-d` (5003: `qasentinel-other/qasentinel-repo-c`). |
| Ids | Run ids 31001–34002, run attempt 1 or 2, check suite ids 62004–64001, PR numbers 42–62, PR id 900000 + number. Unmapped ids (`workflow_id` 20001, `check_suite_id`, `run_number` 7, PR `id`) differ from the mapped ones, so using the wrong id gives a wrong `thread_ref`. |
| Sentinel marker | `qasentinel`. Every free-text string the ADR never stores contains it: logins, names, emails, titles, bodies, messages, labels, teams, branch and tag names, workflow names and paths, URLs, node ids, `contact_email`, file names. Enum values, timestamps, ids and SHAs carry no marker; SHAs are listed in `absentStrings` instead. |
| `event_id` namespace | `fbb354ba-6443-5e61-8995-5f0d8fb04b91` = UUIDv5(`NAMESPACE_URL`, `https://javisdog.vercel.app/api/github/webhook`), proposed in [G1](#spec-gaps-g). |
| Delivery GUIDs | `d0c0ffee-0019-11f1-8000-…` (a different one per request unless a step sets it). |

Worked example (S02): the 2 133-byte body has SHA-256 `b19e4a4e…4eec39`; the event's `event_id` is UUIDv5(namespace, `b19e4a4e3a4eba2f9ab83bd24677c9de815b6db907d4cbc2178a1a200a4eec39:0`) = `fe3c9e3d-8b05-5bd6-ab68-3bb9f2c34f05`; its `thread_ref` is `gh_` + the first 32 hex characters of SHA-256(`run|31001|1`) = `gh_b4889b4c564c6801f8c82753261f8124`.

## Vector file format

### Signature vector (`S01`, `kind: "signature"`)

| Field | Meaning |
|---|---|
| `cases[].label`, `note` | Unique label; intent. |
| `cases[].secrets` | The configured secrets in order: `[current]` or `[current, previous]`. Each is a UTF-8 string; the HMAC key is its UTF-8 bytes (Y4). |
| `cases[].bodyHex` | The exact body bytes. |
| `cases[].header` | The `X-Hub-Signature-256` value, or `null` for an absent header. |
| `cases[].expect.valid` | Whether the verifier accepts. |
| `cases[].expect.hmacHexPerSecret` | Lower-case hex HMAC-SHA256 of the body under each secret (informative; lets a runner see why). |

### Route vectors (every other file, `kind: "route"`)

| Field | Meaning |
|---|---|
| `id`, `description`, `contract`, `ambiguities` | As in the other suites. `ambiguities` names the [gaps](#spec-gaps-g) and [readings](#readings-y) the expected values depend on, beyond the suite-wide readings Y1, Y2, Y5, Y6, Y7, Y11. |
| `clock` | The time the route sees as "now" for every step (3-day rule). |
| `setup.secrets` | `current` = `GITHUB_APP_WEBHOOK_SECRET`, `previous` = `GITHUB_APP_WEBHOOK_SECRET_PREVIOUS`; `null` = not set. |
| `setup.workspaces[]` | `label` (`ws-a`) and its projects: `slug`, `privacyClass`. |
| `setup.installations[]` | Rows of `github_installations`: `installationId`, `accountId`, `accountType`, `claimedBy` (workspace label or `null`), `suspended`. |
| `setup.repositories[]` | Rows of `github_repositories`: `repoId`, `installationId`, `fullName`, `project` (linked project slug or `null`). |
| `steps[]` | In order, against one store. A step is a delivery (`request` set, `action` `null`) or a product action (`action` set, `request` `null`). |
| `steps[].action` | `{ "op": "releaseClaim", "installationId" }`: the claiming workspace's owner releases the claim (D0 M5). |
| `steps[].fault` | `null`, or `"store-unavailable"`: the database fails for the whole of this request (R21). |
| `steps[].request.headers` | Sent exactly (lower-case names); no other header is added. Absent keys are absent headers. |
| `steps[].request.payload` / `bodyText` / `bodyHex` | Exactly one is non-null. `payload`: the body is `JSON.stringify(payload)` (no spaces) as UTF-8. `bodyText`: its UTF-8 bytes. `bodyHex`: exactly those bytes. |
| `steps[].request.bodyPadBytes` | With `payload` only: append ASCII spaces (`0x20`) until the body has exactly this many bytes (JSON whitespace, so it still parses). |
| `steps[].request.bodyLength`, `bodySha256` | Of the final bytes. The runner MUST check both before sending; a mismatch is BLOCKED (fixture serialisation), never FAIL. |
| `steps[].request.signedWith` | Informative: which secret made `x-hub-signature-256` (`current`, `previous`, `other`), `none`, or `literal` (written by hand or over other bytes). The header values are precomputed; the runner never signs. |
| `steps[].expect.outcome` | Informative label of why (`stored`, `rows-changed`, `dropped:duplicate`, `dropped:too-old`, `rejected:signature`, …). Not compared: the ADR defines no outcome names. |
| `steps[].expect.status` | Exact HTTP status. |
| `steps[].expect.errorCode` | `"not_configured"` for `503` (decision 3): the body is a JSON object whose `error` equals it (Y13). `null`: not checked. |
| `steps[].expect.equivalenceGroup` | `"github-401"`: every response in the group (across all vectors) has the same status and the same body bytes ("without saying which"). |
| `steps[].expect.deliveryRecorded` | After the step, `github_deliveries` holds (`true`) or does not hold (`false`) this body's SHA-256. `null` for action steps. |
| `steps[].expect.events[]` | Exactly the JGR events this step newly stored, in any order ([Event comparison](#event-comparison)). `[]` = none. |
| `steps[].expect.state` | `null`: rows not checked. Otherwise the complete contents of `github_installations` and `github_repositories` after the step, in the setup row shape ([Row comparison](#row-comparison)). |
| `absentStrings` | Strings that MUST NOT occur in any stored event, any captured log line or any `github_*` row: the secrets, every signature hex value sent, every SHA in the payloads ([Absent strings](#absent-strings)). |

Each expected event is `{ derivation, event, attributes }`:

| Part | Meaning |
|---|---|
| `derivation.threadKey` | The exact string hashed into `thread_ref` (`run\|<run_id>\|<run_attempt>`, `suite\|<check_suite.id>`, `pr\|<repository.id>\|<number>`). Informative. |
| `derivation.eventIdName` | The UUIDv5 name `<body_sha256>:<index>`. Informative. |
| `derivation.sequenceRule` | How `sequence` was computed. Informative. |
| `event` | Envelope fields compared exactly: `jgr`, `event_id`, `producer_id`, `project_ref`, `thread_ref`, `sequence`, `type`; `occurred_at` compared as an instant (Y6). |
| `attributes` | A value: present and equal (same JSON type). `{ "optional": true, "equals": v }`: absent, or present and equal to `v` (G8). |

## Shape check

ADR-0019 D0 H2 says the event kind comes from "a strict check of the payload's shape" without listing fields (G10). This suite proposes the following, and its fixtures satisfy it:

| Kind | Payload must have |
|---|---|
| `workflow_run` | string `action`; object `workflow_run` with integer `id`, integer `run_attempt`, string `updated_at`, string `run_started_at`; object `repository` with integer `id` |
| `check_suite` | string `action`; object `check_suite` with integer `id`, object `app`, string `updated_at`; object `repository` with integer `id` |
| `pull_request` | string `action`; integer `number`; object `pull_request` with integer `number`, string `updated_at`, boolean `draft`; object `repository` with integer `id` |
| `installation_repositories` | string `action`; arrays `repositories_added` and `repositories_removed`; object `installation` with integer `id` |
| `installation` | string `action`; object `installation` with integer `id` and object `account` (integer `id`, string `type`); not `installation_repositories` |

Exactly one row must match, and `X-GitHub-Event` must equal that kind; otherwise the delivery is ignored (`202`). A `ping` (header `ping`) is always ignored. The top-level `installation` (`{ id, node_id }`) that every App delivery carries does not make a payload an `installation` event: that needs `installation.account`.

## Expected processing

The route vectors encode this order (decision 3 as amended by D0 L1, H2, H3, H4; Y9):

1. No current secret → `503` `not_configured` (G13: a previous secret alone is not enough).
2. `Content-Encoding` present and not `identity` → `415`, before the body is read.
3. `X-Hub-Signature-256` absent or not `^sha256=[0-9a-f]{64}$` → `401`, before the body is read (G11).
4. Body over 1 048 576 bytes → `413` (Y8).
5. HMAC-SHA256 of the raw bytes under the current secret, then the previous one; no match → `401`.
6. The body's SHA-256 is already in `github_deliveries` → `202`, nothing else. Otherwise it is recorded (Y11), in the same transaction as the rest (G14: a store failure is `500` and records nothing).
7. Shape and header ([Shape check](#shape-check)), then known action (decision 1 events; actions of the decision 5 table and M6; `installation` `created`, `deleted`, `suspend`, `unsuspend`; `installation_repositories` `added`, `removed`) → otherwise `202`.
8. `installation` / `installation_repositories`: rows change as decision 4 says (G16 for `created`), no 3-day rule (H4) → `200` (G3).
9. `workflow_run`, `check_suite`, `pull_request`: no `installation` → `202` (H3; G23 for `pull_request`); per-event timestamp more than 3 days before the clock → `202` (H4, Y3); no row for `repository.id`, or the row's `installation_id` differs from `installation.id` → `202`; then `full_name` is refreshed (G20); suspended installation, unclaimed installation or unlinked repository → `202`; `check_suite` of GitHub Actions itself → `202` (Y10); otherwise one event is stored → `200` (G3).

## Mapping

Common to every event (decision 5 and D0): `jgr` `"0.1"`; `event_id` = lower-case UUIDv5 under the [namespace](#fixtures) of `<body_sha256>:0` (lower-case hex; index 0, every delivery here yields one event; G1); `producer_id` `gh-app_<installation.id>`; `project_ref` the linked project's slug; `thread_ref` `gh_` + the first 32 lower-case hex characters of SHA-256 over the thread key (Y2); `occurred_at` = the H4 timestamp of the event (G2); **no `status`** (M1), no `agent_ref`, `usage_delta` or `encrypted` (G15); `privacy_class` absent or `"L0"` (Y5), also for L1/L2 projects (M18).

| Source | `type` | Thread key | `sequence` | Attributes |
|---|---|---|---|---|
| `workflow_run` `requested` / `in_progress` | `task.started` | `run\|<id>\|<run_attempt>` (M3) | 0 / 1 (M3) | `tool_name` `github-actions`, `task_kind` `ci.workflow`, `attempt` = `run_attempt` |
| `workflow_run` `completed` | `success`, `neutral` → `task.completed`; `failure`, `timed_out`, `startup_failure` → `task.failed`; `cancelled` → `x.github.ci.cancelled`; `skipped` → `x.github.ci.skipped`; `action_required`, `stale` → `x.github.ci.attention` (table, M1, M6) | same | 2 | as above + `duration_ms` = `updated_at` − `run_started_at` in ms; `error_code` optional `ci.<conclusion>` unless `success` (G8) |
| `check_suite` `completed`, app slug not `github-actions` | same conclusion table (G7) | `suite\|<id>` (M3) | `updated_at` in epoch seconds (G4) | `tool_name` = slug if on the list `vercel`, `netlify`, `circleci-checks`, `buildkite`, `azure-pipelines` (G9), else `other`; `task_kind` `ci.check_suite`; `error_code` as above (G8) |
| `pull_request` `opened`, `reopened` (G6) | `x.github.pr.opened` | `pr\|<repository.id>\|<number>` | `updated_at` seconds × 8 + ordinal (M3); ordinals `opened` 0, `reopened` 1, `synchronize` 2, `converted_to_draft` 3, `ready_for_review` 4, `closed` 5 (G5) | `task_kind` `pr.draft` if `pull_request.draft`, else `pr` |
| `pull_request` `synchronize`, `converted_to_draft` (M6) | `x.github.pr.updated` | same | same | same |
| `pull_request` `ready_for_review` | `x.github.pr.ready` | same | same | same |
| `pull_request` `closed` | `x.github.pr.merged` if `pull_request.merged`, else `x.github.pr.closed` | same | same | same |

A PR `sequence` is about 1.4 × 10^10 (M15 step 2: 1 793 531 400 × 8 + 2 = 14 348 251 202), above 2^31 (Y14).

## Runner rules

### Layers

- **Route layer** (required for a PASS): the real route handler (`POST /api/github/webhook`, Node runtime) with JD-M06 on PGlite (or another real Postgres), env vars from `setup.secrets`, and the clock injected so that "now" is `clock` for every step. A route that cannot take an injected clock reports the time-dependent vectors (R13, R14 and every vector with stored events) BLOCKED, never PASS: their signed timestamps cannot be moved.
- **Mapper layer** (optional, fast): JD-M10's pure functions. A signature verifier runs S01. A mapper may run the `stored` steps of M and P vectors given the parsed payload, `bodySha256` and the linked project; routing, status codes, rows and logs are then NOT RUN.

### Setup

- One fresh store per vector. Create `setup.workspaces` (any owner; one member), its projects with the given privacy class, then the rows in `setup.installations` and `setup.repositories` with the stated claims and links. A runner MAY insert the rows directly (repository functions or SQL) because the only product path that creates them is a signed delivery; claims and links MAY use the product's claim and link functions if they reach the same rows. `github_deliveries` starts empty.
- `releaseClaim` uses the product's release path (JD-APP, D0 M5) for the claiming workspace's owner, or an equivalent repository call.
- `fault: "store-unavailable"` makes every database call of that request fail (a stub, a closed pool, or a failing transaction); the next step runs against the healthy store. A runner without such a seam reports R21 NOT RUN.

### Sending

Build the bytes as in the field table, check `bodyLength` and `bodySha256`, and send them with exactly `request.headers` as a raw byte body (no client-added `Content-Type` or `Content-Encoding`, no re-encoding). `X-GitHub-Delivery` is sent as given, including R22's non-GUID value.

### Event comparison

After each step, read every event stored for every project of the vector and take those not present before the step. Their number MUST equal `expect.events.length`. Match each to an expectation by `event_id` (canonical lower case), then:

- `event` keys are compared as said above; `sequence` and attribute numbers as JSON integers.
- The stored event has no keys other than `jgr`, `event_id`, `producer_id`, `project_ref`, `thread_ref`, `sequence`, `type`, `occurred_at`, `attributes` and `privacy_class` (absent or `"L0"`). In particular **no `status`** (M1) and no `agent_ref` (G15).
- `attributes` holds exactly the listed keys (optional ones may be absent) and nothing else; every key is on the L0 allowlist (spec §7).
- Every stored event validates with the JD-M01 validator at `now` = `clock` (invariant I1).
- Per (`producer_id`, `thread_ref`), sequences are strictly increasing in step order (spec §3, JGR-R06; invariant I2).

### Row comparison

With `expect.state` non-null, read both tables after the step and compare as sets keyed by `installationId` / `repoId`: `accountId`, `accountType`, `claimedBy` (the claiming workspace, `null` if none), `suspended` (`suspended_at` is not null), `installationId`, `fullName`, `project` (the linked project's slug, `null` if none). Other columns (`linked_at`, `linked_by`, timestamps, `suspended_at` values, `workspace_id`) are not compared.

### Absent strings

Compared case-insensitively as substrings, in three places: every stored event (its JSON text), every log line the route wrote during the vector (when the runner captures logs), and every column of `github_installations`, `github_repositories` and `github_deliveries`.

- **Global**: the marker `qasentinel` MUST NOT occur in events or logs at all, and in rows only in `github_repositories.full_name` (decision 4 keeps `full_name` there).
- **Per vector**: every entry of `absentStrings` MUST NOT occur anywhere of the three.
- Logs carry only the delivery GUID (when it looks like a GUID), event, action and outcome (decision 3, H2). A runner that captures logs also checks that no header value other than `X-GitHub-Delivery` (GUID-shaped), `X-GitHub-Event` and the action appears. A runner without log capture reports the log part NOT RUN.

### Results

Each vector reports exactly one of PASS, FAIL, BLOCKED, NOT RUN or SKIPPED (Orcasus contract), as in the [self-report suite](../self-report/README.md#results). A vector passes only if every step and every check passes; a check a layer cannot perform (logs, rows, the R21 fault) is listed as NOT RUN next to the result and never folded into PASS. A FAIL on a vector that lists G or Y ids names them, so the owner can decide whether the proposal or the implementation should change; such a vector is still run and reported, never silently skipped. SKIPPED needs a recorded owner decision.

## Vectors

| Id | Proves | Steps | Events |
|---|---|---:|---:|
| S01 | Signature known answers: GitHub's documented vector; a changed digit, a trailing LF, a UTF-8 BOM, CRLF; wrong secret; previous secret; upper-case hex or prefix (G11); 63 / 65 / non-hex / `sha1=` / prefix-only / empty / missing header; raw invalid UTF-8 bytes; a UTF-8 secret vs Latin-1 | 20 cases | — |
| S02 | A delivery signed with the current secret is verified, mapped and stored (200) | 1 | 1 |
| S03 | With a previous secret configured, either secret is accepted; a third is 401 | 3 | 2 |
| S04 | Without a previous secret, the old secret is 401 | 1 | 0 |
| S05 | Every missing or malformed header is the same 401, including the correct HMAC with `sha1=`, `SHA256=`, upper-case hex, no prefix, base64, two values; the control with the right header is stored | 13 | 1 |
| S06 | A well-formed wrong signature (other secret, other body, one digit, plain SHA-256) is the same 401 | 4 | 0 |
| S07 | The HMAC covers raw bytes: pretty-printed, BOM-prefixed and LF-suffixed bodies are 401; the compact body is stored | 4 | 1 |
| S08 | `gzip`, `br`, `deflate` (and a gzip label on a plain body, and gzip of a body over 1 MiB) are 415; `identity` is processed | 6 | 1 |
| S09 | 1 048 577 bytes is 413 even with a wrong signature, 401 with a malformed header; exactly 1 MiB is stored | 4 | 1 |
| S10 | No secret: 503 `not_configured` before encoding, size and signature | 4 | 0 |
| S11 | Only the previous secret set: 503 (G13) | 1 | 0 |
| S12 | Bad signature on malformed JSON, a ping, an empty body or an `installation_repositories` body: the same 401, rows unchanged | 4 | 0 |
| R01 | The same body with a new GUID, or no GUID, stores nothing new | 3 | 1 |
| R02 | Two different bodies with the same GUID are both stored | 2 | 2 |
| R03 | A stored body re-sent under another `X-GitHub-Event` stores nothing new | 3 | 1 |
| R04 | Header disagreeing with the shape (every kind, including `installation*`), or missing (G12), is 202 with nothing stored or changed | 6 | 0 |
| R05 | `issues`, `push` (commit messages, emails, file lists) and `installation_target` are 202, nothing stored | 3 | 0 |
| R06 | Unmapped actions (`labeled`, `edited`, `review_requested`, `requested`, `rerequested`, `new_permissions_accepted`) are 202, nothing stored | 6 | 0 |
| R07 | `ping` is 202, nothing stored | 1 | 0 |
| R08 | Unlinked, unknown and unclaimed repositories are 202, nothing stored | 4 | 0 |
| R09 | `installation.id` different from the row's is 202, nothing stored | 3 | 0 |
| R10 | A signed `suspend` stops storage until a signed `unsuspend` | 4 | 1 |
| R11 | A released claim clears the link; the repository row stays; nothing stored | 2 | 0 |
| R12 | No `installation` in `workflow_run`, `check_suite`, `pull_request` (G23) is 202 | 3 | 0 |
| R13 | 3-day boundary on `workflow_run.updated_at`: exactly 72 h kept, 72 h + 1 s dropped; old `created_at` irrelevant | 3 | 2 |
| R14 | 3-day rule on `check_suite.updated_at` and `pull_request.updated_at`; a fresh `head_commit.timestamp` does not rescue an old `updated_at` | 5 | 2 |
| R15 | `installation*` with 30-day-old installation timestamps are processed (H4 exempt) | 2 | 0 |
| R16 | A replayed `installation_repositories removed` body changes nothing after the repository was re-added | 3 | 0 |
| R17 | A replayed `suspend` body changes nothing after an `unsuspend` | 4 | 1 |
| R18 | A repository moving to another installation loses its link | 3 | 0 |
| R19 | `full_name` refreshed from a signed `workflow_run` (G20) and `installation_repositories` | 2 | 1 |
| R20 | `installation deleted` removes the installation and its repositories; later deliveries store nothing | 2 | 0 |
| R21 | A store failure is 500 and records nothing; the redelivery is stored once (G14) | 3 | 1 |
| R22 | A non-GUID or missing `X-GitHub-Delivery` does not stop storage; the non-GUID value never reaches logs | 2 | 2 |
| M01 | `workflow_run` requested → in_progress → completed success: sequences 0, 1, 2 on `run\|id\|1`, `duration_ms` | 3 | 3 |
| M02–M04 | `failure`, `timed_out`, `startup_failure` → `task.failed` | 1 each | 1 each |
| M05, M06 | `cancelled` → `x.github.ci.cancelled`, `skipped` → `x.github.ci.skipped` | 1 each | 1 each |
| M07 | `neutral` → `task.completed` | 1 | 1 |
| M08, M09 | `action_required`, `stale` → `x.github.ci.attention` | 1 each | 1 each |
| M10 | `run_attempt` 2 opens `run\|id\|2`, sequences restart at 0, `attempt` 2 | 5 | 5 |
| M11 | `check_suite` from `vercel` (G9): `tool_name` `vercel`, success and failure | 2 | 2 |
| M12 | Unknown slug or no slug → `tool_name` `other` | 3 | 3 |
| M13 | GitHub Actions' own suite is skipped | 2 | 0 |
| M14 | `check_suite` `cancelled`, `skipped`, `neutral`, `action_required`, `stale`, `startup_failure` (G7) | 6 | 6 |
| M15 | PR lifecycle: opened (draft), synchronize, ready_for_review, closed, reopened (G6), closed merged | 6 | 6 |
| M16 | `converted_to_draft` → `x.github.pr.updated`, `pr.draft` | 2 | 2 |
| M17 | Three PR actions in one second keep increasing sequences (G5); other number, other repository → other threads, other project | 5 | 5 |
| M18 | A repository linked to an L2 project yields the same L0 events | 2 | 2 |
| P01 | `workflow_run` sentinels: commit message and author, `display_title`, workflow name and path, branch, actor, sender, URLs, PR refs | 2 | 2 |
| P02 | A tag as `head_branch` and a non-ASCII `display_title` | 1 | 1 |
| P03 | `check_suite` sentinels including an unknown app slug | 1 | 1 |
| P04 | PR title, body, labels, reviewers, teams, assignees, author, merger, refs, `before` / `after`, `merge_commit_sha` | 3 | 3 |
| P05 | Installation payloads: `contact_email`, `suspended_by`, `requester`, `sender`, account login, name, email, `app_slug`, file paths | 3 | 0 |
| P06 | `installation_repositories` `requester`, `sender` | 2 | 0 |
| P07 | Dropped and refused deliveries leave no sentinel in events, rows or logs | 4 | 0 |

Totals: 59 vectors (S 12, R 22, M 18, P 7); S01 holds 20 cases; the 58 route vectors hold 174 steps (173 deliveries, 1 action) and expect 70 stored events.

## Suggested mutation checks

Each mutation must turn at least the listed vector to FAIL.

| Mutation | Vector |
|---|---|
| HMAC over decoded text (`request.text()` drops a BOM) or re-serialised JSON | S01 (`utf8-bom-prefix`, `raw-bytes-invalid-utf8`), S07 |
| HMAC key as Latin-1, or the secret trimmed | S01 (`utf8-secret-latin1-header`) |
| Only the current secret tried; or the previous tried when unset | S03, S04 |
| Lenient header parsing (case, prefix, base64, trailing text) | S01, S05 (G11) |
| `timingSafeEqual` on unequal lengths (throws → 500) | S05 (63 / 65 hex, base64) |
| Different 401 bodies per cause | S05, S06, S07 (group `github-401`) |
| Decompress `gzip` instead of 415, or check size first | S08 |
| Size limit `>=` 1 MiB, 1 000 000 bytes, or after the HMAC | S09 |
| Signature checked before configuration | S10, S11 |
| Parse JSON before verifying (400 on malformed JSON) | S12 |
| Dedupe on the GUID instead of the body hash | R01, R02, R21 |
| Trust `X-GitHub-Event` over the shape, or default a missing header | R03, R04 |
| Store unknown events or actions, or `ping` | R05, R06, R07, P07 |
| Route by repository only, ignoring `installation.id`, suspension or claim | R09, R10, R11, R18 |
| 3-day rule on `created_at`, `run_started_at` or `head_commit.timestamp`; `>=` instead of `>` | R13, R14 |
| 3-day rule applied to `installation*` | R15 |
| Record the body hash only for stored events (replays of `installation*` act again) | R16, R17 |
| Record the hash before a failed insert | R21 supplement in the runner (R21 itself cannot: its fault fails every database call, so `hasDelivery` throws before any hash is written; the supplement fails only the event insert) |
| Keep a link when a repository changes installation | R18 |
| `event_id` from the GUID, upper case, another namespace, or index 1 | every vector with events (G1); R02 (GUID) |
| Run thread without `run_attempt`, or ordinal sequence restarting across attempts on one thread | M10 |
| `thread_ref` over `pr\|<number>` without the repository, or full 64 hex | M15, M17 |
| `status` on GitHub events | every vector with events |
| `cancelled` / `skipped` as `task.completed` (pre-D0 table) | M05, M06, M14 |
| `neutral` as failed, `action_required` / `stale` as failed | M07–M09, M14 |
| Check suites of GitHub Actions stored | M13 |
| Slug stored as `tool_name` when not listed | M12, P03 |
| `occurred_at` from `created_at` or the clock | M01, M15 (G2) |
| PR `sequence` = `updated_at` seconds only (no × 8 + ordinal) | M17 |
| L1 hashing of refs for L1/L2 projects, or `privacy_class` L2 | M18 |
| Copy any title, branch, login, email, URL or path into an attribute or log | P01–P07 |
| Store `contact_email`, `requester`, `sender` or account login in rows | P05, P06 |

## Not covered

| Contract item | Why |
|---|---|
| Claim rules (owner or admin, GitHub account id equals `account_id`, organization refused, first claim wins), linking (same workspace, one project per repository, L1/L2 warning) | Claim and link action tests (TEST_PLAN §S5g); not webhook behaviour. |
| Migration 0006: FKs, `ON DELETE SET NULL`, the composite workspace check, deleting a project or workspace clears links | Migration and repository tests on PGlite. |
| Ingest rejects `producer_id` `gh-app_*` and `thread_ref` `gh_*` (D0 M2) | Ingest handler test; a later HTTP vector could add it. |
| Dashboard: GitHub threads labelled by source, `ended` on a terminal event, left out of the squad and agent counts, separate CI and PR counts, no effect on agent status (D0 M1, decision 6) | Reader and component tests; a reader suite (H5 part 2) could take the events these vectors store as input. |
| `touchSignal` for the linked project (M1), `last_verified_delivery_at` and the Integrations labels (decision 8, M4) | Route and component tests: a pinned clock cannot show "advanced". |
| `github_deliveries` purge after 3 days | Time-travel test on PGlite; see G17. |
| The 10 s budget, `timingSafeEqual` timing, Vercel Firewall rule | NOT RUN (TEST_PLAN §S5g); not vector-testable. |
| Local helper (manifest, `state`, 127.0.0.1, mode 0600, no secret printed) | Process test against a stub GitHub. |
| `Content-Type` other than `application/json`, form-encoded `ping` | The ADR states no rule; GitHub sends JSON for this app's manifest. |
| A valid signature over a body that is not JSON, has a BOM, or is not UTF-8 | No outcome defined (G18). |
| Future timestamps (more than 5 minutes ahead) and a `completed` run with `conclusion` `null` or a new value | No outcome defined (G21, G22). |
| `push` mapping | Out of scope (decision 1). |

## Ambiguities

### Spec gaps (G)

Each row quotes the ADR-0019 (or TEST_PLAN) text at `056a203` and proposes an exact rule. The vectors listing the id encode the proposal; rows marked "—" have no vector.

| Id | Line | Question | Proposed exact rule | Vectors |
|---|---|---|---|---|
| G1 | L76, L149 | "a UUIDv5 under a fixed namespace from `<body_sha256>:<index>`": the namespace UUID is not given, nor the hex case or index base. | Namespace `fbb354ba-6443-5e61-8995-5f0d8fb04b91` = UUIDv5(`NAMESPACE_URL` `6ba7b811-9dad-11d1-80b4-00c04fd430c8`, `https://javisdog.vercel.app/api/github/webhook`). Name = UTF-8 of 64 lower-case hex, `:`, the decimal index of the event within the delivery starting at 0. Output lower case, version nibble 5, RFC 4122 variant. | every vector with events |
| G2 | L77 | "`occurred_at` is GitHub's own timestamp for the change": which field? | The H4 field: `workflow_run.updated_at`, `check_suite.updated_at`, `pull_request.updated_at`. Compared as an instant (Y6). | every vector with events |
| G3 | L58, L59, L61, TEST_PLAN "503/401/202/200/500" | Which success status for a processed delivery, and for `installation*` deliveries that change rows? | `200` when the delivery passed every drop rule and was handled (one event stored, or an `installation*` action applied); `202` whenever it was acknowledged and dropped (Y1). | every route vector with 200 or 202 |
| G4 | L172–L173 | Check-suite threads are `suite\|<check_suite.id>`, but their `sequence` is not defined; a re-requested suite completes again under the same id. | `sequence` = `check_suite.updated_at` in epoch seconds. | M11, M12, M14, P03, R14 |
| G5 | L174 | "PR sequence = `updated_at` in seconds × 8 + the action ordinal": the PR ordinals are not listed. | `opened` 0, `reopened` 1, `synchronize` 2, `converted_to_draft` 3, `ready_for_review` 4, `closed` 5 (merged or not). | M15–M18, P04, R14 |
| G6 | L85 | `reopened` is a source, but the five targets `.opened, .updated, .ready, .merged, .closed` do not say which one it maps to. | `reopened` → `x.github.pr.opened` (non-terminal, so the thread is open again). | M15 |
| G7 | L84, L168 | `check_suite` maps to "`task.completed` / `task.failed`" without a conclusion table; M1 and M6 speak of runs. | The `workflow_run` table applies to `check_suite.conclusion` (`neutral` → completed; `timed_out`, `startup_failure` → failed; `cancelled`, `skipped` → `x.github.ci.*`; `action_required`, `stale` → `x.github.ci.attention`). Attributes: `tool_name`, `task_kind`, optional `error_code` only (no `attempt`, no `duration_ms`). | M11, M12, M14, P03, R14 |
| G8 | L83, L168 | The table put `error_code` `ci.cancelled` / `ci.skipped` on `task.completed`; M1 moved those to their own types. Is `error_code` still sent, and on failures? | `error_code` is absent for `success`; for every other conclusion it is either absent or exactly `ci.<conclusion>` (vectors use the optional matcher). | every vector with a `completed` run or suite |
| G9 | L84 | "`tool_name` from a fixed list of CI app slugs": the list is not given. | Proposed list (hypothesis; the owner should confirm each slug against the real apps): `vercel`, `netlify`, `circleci-checks`, `buildkite`, `azure-pipelines`. `tool_name` = the slug verbatim. Only `vercel` is used by the vectors. | M11, M14, R14 |
| G10 | L150 | "a strict check of the payload's shape": which fields? | The [Shape check](#shape-check) table; exactly one kind must match. | R04 (and every vector implicitly) |
| G11 | L185 | "a signature header that is not `sha256=` plus 64 hex characters (`401`)": are upper-case hex digits or `SHA256=` well-formed? | Only `^sha256=[0-9a-f]{64}$` (what GitHub sends); anything else is malformed → `401`. | S01, S05 |
| G12 | L150 | "`X-GitHub-Event` is only a hint and must agree": a missing header? | Missing = disagreeing → `202`, nothing stored. | R04 step 6 |
| G13 | L51, L55 | "Without a configured secret: `503`": what if only `GITHUB_APP_WEBHOOK_SECRET_PREVIOUS` is set? | The current secret is required; previous alone → `503 not_configured`. | S11 |
| G14 | L61, L148 | A database failure is `500` "so the delivery can be redelivered", but if the body hash were already in `github_deliveries`, the redelivery (same bytes) would be dropped. | The hash insert is in the same transaction as the event insert (or row changes); on `500` nothing is recorded. | R21 |
| G15 | L73–L78, L164 | The common fields do not say whether `agent_ref`, `platform` or other allowlisted attributes may be added. | GitHub events carry exactly the envelope fields and attribute keys of the [Mapping](#mapping) table; no `agent_ref` (they are never agents, decision 6). | every vector with events |
| G16 | L67 | Rows come "only from signed `installation` / `installation_repositories` deliveries", but it is not said that `installation created` inserts the `repositories` it lists. | `created` inserts the installation row (unclaimed, unsuspended) and one unlinked repository row per `repositories[]` entry. | R15, P05 |
| G17 | L148, L162 | `github_deliveries` is purged after 3 days, and `installation*` deliveries are exempt from the 3-day rule: a captured `installation_repositories removed` or `installation deleted` body replayed after the purge would act again (H2 "protects them" only for 3 days). | Keep hashes of `installation*` deliveries without purge (they are few), or for at least 90 days. No vector (needs time travel past the purge). | — |
| G18 | L57 | After a valid signature: a body that is not JSON, has a UTF-8 BOM, or is not valid UTF-8. | `400` with nothing recorded is one option; `202` "ignored" is another. No vector. | — |
| G19 | L185 | Order between the `415` encoding check and the `401` header-format check (both "before the body is read"); is `Identity` (any case) accepted? | No vector combines them. Suggestion: encoding first; compare the encoding name case-insensitively. | — |
| G20 | L67 | "`full_name` is refreshed from every signed delivery": also from `workflow_run`, `check_suite`, `pull_request` deliveries, and from dropped ones? | Refreshed from every delivery that passes dedupe and the 3-day rule and whose `repository.id` has a row with the same `installation_id`; for `installation*` from the listed repositories. | R19 |
| G21 | L59 | A per-event timestamp in the future (more than 5 minutes ahead) makes the event fail JD-M01 (`clock_skew`). Status? | Suggestion: `202`, nothing stored, logged as rejected. No vector. | — |
| G22 | L83 | `workflow_run` / `check_suite` `completed` with `conclusion` `null` or a value GitHub adds later. | Suggestion: `202`, nothing stored. No vector. | — |
| G23 | L160 | "A missing `installation` in a `workflow_run` or `check_suite` payload → `202`": `pull_request` is not named. | Same rule for `pull_request`. | R12 step 3 |

### Readings (Y)

Choices the suite makes where the text is clear in intent but needs an operational rule. A FAIL that disagrees with one of them should be raised, not patched. Y1, Y2, Y5, Y6, Y7 and Y11 apply to every vector and are not listed per vector.

| Id | Reading |
|---|---|
| Y1 | "Acknowledged and dropped" (L59) means `202`, as H2 writes "acknowledged (`202`)" for a repeated body. |
| Y2 | "32 hex characters of SHA-256" (L75) = the first 32 lower-case hex characters of SHA-256 over the UTF-8 thread key. |
| Y3 | "More than 3 days old" = `clock` − timestamp > 259 200 s. Exactly 259 200 s is kept (R13 step 1, R14 step 2). |
| Y4 | The HMAC key is the UTF-8 bytes of the configured secret, and the message is the raw request bytes (L40, L185). |
| Y5 | GitHub events are L0: `privacy_class` absent or `"L0"`, even in L1/L2 projects (L75 "this is **not** L1"). |
| Y6 | `occurred_at` is compared as an instant; GitHub's `…Z` string and `….000Z` are equal. |
| Y7 | D0 supersedes decision 5 where they differ: run threads include `run_attempt` (M3, not `run\|<run_id>`); `event_id` comes from the body hash (H2, not the GUID); cancelled and skipped are `x.github.ci.*` (M1); the PR `sequence` has the × 8 + ordinal form (M3). |
| Y8 | 1 MiB = 1 048 576 bytes; "`413` above it" means 1 048 577 bytes and more. |
| Y9 | L1 moves the header-format check before the body is read, so a malformed header on an oversized body is `401`; a well-formed wrong signature on an oversized body is `413` (decision 3 order: size before signature). |
| Y10 | "GitHub Actions' own" check suite = `check_suite.app.slug` `github-actions`. |
| Y11 | "Every verified delivery's raw-body SHA-256 goes into `github_deliveries`" (L148) includes deliveries that are then ignored (unknown kind, unlinked, too old): `deliveryRecorded` is `true` for every `200` and `202` step. |
| Y12 | `installation` actions other than `created`, `deleted`, `suspend`, `unsuspend` (for example `new_permissions_accepted`) are unknown actions: `202`, rows unchanged. |
| Y13 | Error bodies are JSON objects with an `error` string, as on the other Javi's Dog routes; for `503` it is `not_configured` (L55). The `401` body is the same for every cause (L57 "without saying which"). |
| Y14 | PR sequences (≈ 1.4 × 10^10) exceed 2^31. Spec §3 allows any non-negative integer, so the validator and the event store must keep integers up to 2^53 − 1. This lane did not read the store schema; if `sequence` is a 32-bit column, every PR vector fails at insert. |
| Y15 | Because `event_id` derives from the body hash, the event store's own dedupe (spec §9) also stops a second event if a body ever passes `github_deliveries` twice. No vector depends on it. |

## Reference computation

The expected values were computed outside the repository by two independent programs. Neither is committed; they are QA scratch work.

1. **Primary: Node 22.22.0** (`node:crypto` SHA-256, SHA-1, HMAC; its own UUIDv5; `JSON.stringify`; `node:zlib` for the S08 bodies). It built the fixtures, applied the [processing order](#expected-processing) and [mapping](#mapping) with its own simulator, and asserted that each step reached the outcome the vector author intended.
2. **Cross-check: Python 3.13** re-reading every file and recomputing everything with code that shares nothing with the first: the body bytes (`json.dumps` with compact separators), `hashlib` SHA-256, `hmac` for both signature headers, `uuid.uuid5`, its own shape check, router, row model and mapping. The **OpenSSL 3 CLI** (`openssl dgst -sha256` and `-hmac`) recomputed every body SHA-256, every signature header signed with a fixture secret, and every S01 HMAC. `jsonschema` (Draft 7) and Ajv 8.20 (strict, draft-07) validated every file against [`schema.json`](schema.json), and Ajv rejected five broken copies (a `status` on an event, a non-L0 attribute, two bodies, an upper-case UUID, a missing key). Every payload was also checked against GitHub's OpenAPI webhook schema for its event and action (field names, JSON types, enums; `required` not enforced). Result: 2 756 checks and 163 payloads, 0 failures. Five planted errors (a PR `sequence`, an `event_id`, a status, a row, a signature) were each caught.

## Changes

- 2026-11-01 — Created for S5g task H5 part 1 from ADR-0019 at `056a203` (QA lane, before any JD-M10 code).
