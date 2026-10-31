---
name: prove-secrets-and-pii-minimization
description: Design and then prove what an app stores about secrets and personal data — API/ingest tokens kept only as a hash with a recognizable prefix and a display prefix, shown once; third-party OAuth tokens encrypted; fields you do not use (such as an OAuth provider's id_token) not stored at all; logs structured and redacted; failures that leave evidence without leaking; secrets pasted in chat handled by hash comparison and recorded for rotation. The proof step inspects real stored rows by shape (counts, booleans, lengths, prefix classes) and scans every column for plaintext markers, never printing values, and turns each finding into a red-to-green test through the same call path the real flow uses. Use when issuing API keys or personal access tokens, integrating an auth library or OAuth/OIDC sign-in, enabling token encryption at rest, writing auth or error logging, after the first real sign-ins or token issues in an environment, when a user or owner pastes a secret into chat or an issue, when a script or smoke test needs a production credential, when your tool writes its own secret into another tool's config or backups, when a secret is meant to stay in the user's browser or machine and never reach your server, or when someone claims data is "hashed", "encrypted", "not stored" or "never sent to the server".
metadata:
  version: "0.3.0"
  origin: "javis-dog G2-prep; updated G4, ad-hoc-self-report, ad-hoc-privacy (S5f)"
  confidence: "medium (sections 1–7: each applied once with recorded results; section 8: production smoke credentials and own-secret hygiene, once each; section 9: client-held key never reaching the server, once, with a mutation that the earlier test missed)"
---

# Prove secrets and PII minimization

"Tokens are hashed", "OAuth tokens are encrypted", "we don't store the id token" — these are claims about rows in a database, and rows are cheap to check. The origin's design was careful and its tests were green, yet the first real sign-ins stored a provider token in plain text that the library's encryption flag did not cover. The design was not wrong; it was unverified against what the library actually wrote.

The rule: **design for minimization, then prove it on real rows by shape, then pin the proof with a test.**

## Forces

- **Evidence vs. exposure.** To prove nothing sensitive is stored you must look at storage — without printing what you find.
- **Library defaults vs. your threat model.** A flag named "encrypt OAuth tokens" covers the fields its authors chose, not necessarily every token-like field.
- **Debuggability vs. privacy.** Failures with no logs cannot be diagnosed; logs with emails and tokens become a new leak.

## 1. Design: issue API tokens that are useless at rest

- Generate at least 256 random bits from a CSPRNG; encode as base64url; add a **recognizable prefix** (`<app>_<kind>_`) so secret scanners and humans can spot leaks.
- Store a **fast hash** (SHA-256 hex) with a unique index, plus a short **display prefix** (first few characters of the random part) so users can tell tokens apart. For 256-bit random secrets a slow password hash adds latency on every request without benefit; a server-side pepper adds a secret whose loss invalidates every token. Revisit if tokens become user-chosen or shorter.
- Return the plaintext **once**, in the response that created it; the UI says "shown once". Never log, cache or re-display it.
- Parse strictly before any database call: exact prefix, exact length, canonical encoding; reject whitespace instead of trimming.
- Look up by hash, so no secret comparison happens in application code. Revocation is a timestamp; a revoked token verifies to nothing.

## 2. Design: keep only what you use from identity providers

- Request the provider's default minimal scopes.
- Encrypt access/refresh tokens at rest if you keep them (most auth libraries have a flag).
- Read the library's source or type definitions to see **which fields the flag covers**. Fields it does not cover and you do not use (for example the OIDC `id_token`, which carries name, email and avatar) should be dropped before insert and update — most libraries offer database hooks.
- Turn off library telemetry unless you have reviewed what it sends.

## 3. Prove: inspect real rows by shape, never by value

Right after the first real writes in an environment (first sign-ins, first token issued), run read-only queries that return only counts, booleans and lengths. Template: [`templates/at-rest-checks.sql`](templates/at-rest-checks.sql) (verified on PGlite with fake rows at G2-prep).

- **Plaintext scan across every column:** cast the whole row to text and search for markers — the public token prefix **and** a slice of the random part (a bug might store the secret without its prefix). Use `strpos`, not `LIKE`: `_` and `%` in prefixes are wildcards and produce false positives.
- **Hash shape:** every stored hash matches `^[0-9a-f]{64}$`.
- **Encryption shape:** no stored credential starts with the provider's documented plaintext prefix; values have the ciphertext encoding you expect.
- **Dropped fields:** count rows where a field you decided not to keep is non-null — the answer must be 0.

Record the query intent and the numeric results in the iteration record, not the rows.

## 4. Pin each finding with a red-to-green test

- Write the test so it **fails on the current code** (record the failing run), then fix, then record the passing run.
- Drive the test through the **same internal call the real flow uses** (for example the library's "create OAuth user" path rather than a direct insert), so hooks and encryption run as in production.
- Repair existing rows explicitly (set the dropped field to null) and record that you did.
- In unit tests, assert on substrings, not equality: `columns.some(v => String(v).includes(secret))`. An equality check (`values.includes(token)`) misses a token embedded in a longer string. For absence checks, use long sentinel strings that random ids and numbers cannot contain (a 3-digit needle inside a random UUID failed one origin run).
- **Prove "never read", not only "never written".** Pass the mapper a recording `Proxy` of the input that logs every property access, and assert the exact set read (for example: only the fields used to match, never the response body or other tools' arguments). Assert on the mapper itself; a caller with a catch-all would hide a throw from the recorder.
- **Scan diffs fail-closed before pushing:** a scanner that reads "could not scan" as "clean" is worse than none (see `fail-closed-checks`, `scripts/secret-scan.sh`).

## 5. Logs: structured, redacted, and still useful

- One JSON line per event (`{ event, level, message }`), warn level and above for auth.
- **Drop extra arguments** that libraries pass to their logger; they often contain request objects with emails and tokens.
- Redact emails and token-like strings in the message. A pattern denylist is incomplete by nature — keep a probe list of real token formats for every provider you use (all documented prefixes, including refresh tokens and fine-grained keys) and test the redactor against it.
- Errors from outbound calls carry status codes only (`Resend responded 422`), never addresses or payloads. A side effect such as a welcome email must never block the main flow; log `<hook> failed: <ErrorName>`.

## 6. Make failures leave evidence before the first real attempt

A failed OAuth callback that silently returns to the home page leaves nothing: no rows, no logs. Before the first real sign-in, route library errors to a page that shows a **sanitized error code** (`?error=<code>`, characters restricted, length capped) with a readable message, and log them through the redacted logger. Do not rely on the hosting platform's runtime logs being available — verify they return data before counting on them.

## 7. Secrets pasted into chat, issues or tickets

- Never write the value to a file, commit, log or command line that will be recorded.
- If you need to know whether it matches the stored one, compare hashes (or lengths and prefixes) and record only the outcome ("differs by hash").
- Record the exposure by **name** in the project memory with a rotation trigger ("rotate before real user data or the release gate"), and tell the owner. A deferral is the owner's decision; record it as such.
- If you lack permission to set it where it belongs (403 on the platform), hand the action to the owner; do not route around the permission.
- **Match the advice to the secret's cost of rotation.** A per-project API token can be revoked and re-issued in seconds: advise doing it now. A database password or OAuth client secret needs coordinated changes: record the exposure and let the owner decide (an accepted risk is recorded with name, date and the reason).
- Put the rule where people paste: the how-to that asks for a token says "enter it only at the prompt; if it was pasted into a chat, revoke it and issue a new one", and uses a hidden prompt (`Read-Host`, `read -s`) instead of a command-line argument.
- When the owner chooses not to rotate, re-check what the exposure reaches as the system changes: a database branch created later may copy roles **with their passwords**, so an old leak can open a new environment.

## 8. Your own secrets in places you write

- **Production checks:** generate the credential locally, seed only its hash, keep the plaintext in a mode-0600 scratch file outside the repository, pass it on stdin, delete it afterwards (see `bounded-production-verification`).
- **Backups of files you edit** must never contain your own secret: take the backup only when the file has none of your content, remove it after a successful restore. Write files that hold a bearer with mode 0600 and keep the mode on rewrite.
- **Inherited environment:** a bearer you export for one tool reaches every child process; a child tool may merge it into its own export to its vendor. Detect your value in the child's environment by in-memory comparison and warn (never print it).
- **In-memory only:** hashes or ids derived from identity attributes (series identities, auth modes) stay in memory and are never spooled or sent.

## 9. Client-held secrets: prove the server never receives them

When a secret (an encryption key, a recovery code) must stay on the client, "the server never sees it" is a claim about every path from the page or CLI to the server. Prove it with a test that **can fail**:

1. **A long sentinel secret**, generated as the real flow would (the key the UI generates, the value typed into the entry field).
2. **Search every encoding as substrings**: the display form, the body without separators, the raw bytes as hex — and sliding windows of them, so a partial copy is caught.
3. **Capture every server-bound channel**: server-action or RPC arguments (wrap the **real** action, not a stub), request bodies, server-side writes, log and console output, and a fresh server render of the page.
4. **Positive control:** a deliberately leaking call in the test must be caught by the capture.
5. **One mutation:** change the client to pass the secret as an argument; the test must fail. In the origin this mutation was caught by the new test (40 sentinel windows in the action arguments) and **passed** the earlier test, which only searched server-rendered HTML.
6. Keep the secret out of framework state (component state and props are visible to devtools and error reporters): assert that it is absent from the component tree after generation and from input fields after every outcome.

For CLIs: sentinel absent from stdout, stderr, argv, spool files, logs and the **environment of every child process** (read `/proc/<pid>/environ` on Linux); see `local-companion-process-hardening` §8.

## Pitfalls

- **A leak test that searches one channel.** The leak goes through another; prove the test fails with a mutation.
- **Trusting the flag's name.** "Encrypt tokens" did not cover every token field.
- **Green tests, unchecked rows.** Tests use your fixtures; production rows come from the provider.
- **Printing a row to "just check".** Shape queries answer the same question without exposure.
- **Prefix-only plaintext search.** Also search for the random part.
- **Logging the library's extra arguments.** Drop them.
- **Assuming platform logs exist.** Check that they return anything before an incident.

## Evidence from origin project

Javi's Dog, Sprints 2a–2c (2026-10-22). Confidence **medium**: each practice applied once, with recorded results; the logging and failure-evidence parts are not yet proven by a real failure.

- Token design: ADR-0005 (`docs/adr/0005-data-layer-and-ingest-tokens.md`, options and rationale); code `packages/projects/src/tokens.ts` and `packages/projects/src/repository.ts`; tests `packages/projects/test/tokens.test.ts`, `packages/event-store/test/repository.test.ts` (`dc6ef61`). UI "shown once": `apps/web/src/components/token-panel.tsx`, `apps/web/src/app/projects/[id]/page.tsx` (`93cc254`).
- Production DB check after the owner issued and revoked a token: hash 64 hex, display prefix 8, revoked, same workspace, 0 rows containing the plaintext prefix (`docs/sprints/SPRINT-02c.md`, Test evidence, `2d6b87d`). The exact query is not recorded; it searched for the prefix only.
- Row-shape check after the first real GitHub and Google sign-ins: access/refresh tokens stored as hex ciphertext with no provider prefixes; the Google `id_token` stored in plain text because the library's `encryptOAuthTokens` does not cover it → account create/update hooks set it to null; test red (exit 1) → green (exit 0); existing value cleared (`docs/sprints/SPRINT-02b.md` Log and Test evidence; `packages/identity/src/auth.ts`; test "never stores the provider id_token" in `packages/event-store/test/identity.test.ts`; `24231a5`). The test helper had been switched to the library's OAuth-user creation call in S2b.
- First real sign-in attempt left no rows and the hosting platform's runtime logs returned nothing; cause never captured (`SPRINT-02b.md` Retro). Response: redacted JSON auth logger, extra arguments dropped, failed callbacks to `/sign-in?error=` (ADR-0007, `93cc254`; redaction unit test in `packages/identity/test/auth.test.ts`).
- G2-prep probe of the origin's redaction pattern (copied verbatim, Node 22.22.0): it redacts `gho_…`, `ya29.…`, JWT-shaped strings and the app's token prefix, but **not** `ghr_…` (GitHub refresh tokens), `github_pat_…` (fine-grained tokens) or arbitrary `sk_…` keys. No such string is known to have reached a log.
- G2-prep reading of the hash-only unit test: it asserts `Object.values(row)` does not *contain* the token, which is an equality check per column; a token embedded in a longer column value would pass.
- Welcome email errors carry the HTTP status only; failure never blocks sign-in (`packages/notify/src/welcome.ts`, `packages/identity/src/auth.ts`, ADR-0007; tested).
- Secret pasted in chat: compared with the stored one by hash only, never written to the repository; recorded as exposed with rotation tied to the database-credential rotation (`docs/memory/SESSION_LOG.md`, `9b6ea0b`; `docs/memory/PROJECT_MEMORY.md`). The agent's attempt to set it on the platform returned 403; the owner set it.
- Hypotheses: that the redacted logger will capture the next real sign-in failure (no failure observed since); that a slow hash is unnecessary for these tokens (reasoned in ADR-0005, not measured).

### Update at G4 (Sprints 5a–5c, 2026-10-28/29)

- Production smoke credentials: one ephemeral workspace seeded through the database tool with the token's SHA-256 only; "the tokens were in scratch files only, never printed"; the e2e script reads the token from a file and hands it to the CLI on stdin (`collectors/claude-code/scripts/e2e-smoke.mjs` l. 9, 270–273); after cleanup "the scratch token files were removed" (`docs/sprints/SPRINT-05a.md` Log; ADR-0015 §6).
- Accepted risk with a new fact: the owner chose "Accept risk, no rotation" for the chat-exposed database password and OAuth client secret; S5a discovery found that the database provider copies roles with their passwords into new branches, so the production branch probably shares the exposed password (UNVERIFIED: the agent never reads passwords); a reset at cutover was offered (ADR-0015 §9; readiness row "Accepted risk: no rotation before release").
- Ingest token pasted in chat: reported by the orchestrator to Guru (revocation advised); **not recorded** in the session log or readiness matrix (G4 finding). The point-of-use rule exists: `docs/how-to/run-first-real-sessions.md` l. 7 ("Never paste, print or commit an ingest token … If a token was ever pasted into a chat, revoke it") with a `Read-Host` prompt.
- Own secret in backups: S5b review R7 (a second `usage on` backed up the file with the CLI's own bearer) and its twin in the older platform path, fixed red-first (`5e2bd33`, `c0bfde2`); Codex config backups mode 0600 because the file often holds other tools' tokens (ADR-0016 *Changes* D0 H6).
- Inherited bearer: D0 H2 — the CLI's exporter header for one host tool is inherited by a second host tool started inside it, which merges it into its default vendor export; owner "Detect and warn" (ADR-0016 *Changes* D0).
- In memory only: Gemini series hash over all point attributes (incl. user email) and `auth_type` "used only in memory and never copied into the record" (ADR-0016 *Changes* R4, R6).

### Update at ad-hoc-self-report (Sprint 5d, 2026-10-30)

- Read recorder: "a Proxy read recorder proving only the match fields are read for other tools and `tool_response` / other `mcp_context` fields never are for javi's tools" (`1600c47`); ADR-0017 decision 3 "asserted on the mapper itself; the hook runner's catch-all would hide a throw".
- Sentinels in every request field of the self-report vectors must not appear in stdout, stderr, records, batches or the local state directory (`docs/jgr/conformance/self-report/README.md`; runners `a78066b`, `08a33bc`).
- Short needle flake: CI run 41080177974, `packages/analytics/test/reader.test.ts:545` — `'777'` found inside a random project UUID (Guru, from the annotation).
- Secret-scan slips in the push chain (two) and the fail-closed scan script: see `fail-closed-checks`.

### Update at ad-hoc-privacy (Sprint 5f, 2026-10-30/31)

- Test plan rows (`docs/agent-ops/TEST_PLAN.md` §S5f): "Key never reaches the server: sentinel key absent from any server action argument, request body, log line and SSR HTML"; "Sentinel search covers the decoded key bytes (hex) and the base32 body as substrings" (design review D0 M8); "Key never in a child's environment or argv … `/proc/<pid>/environ` of spawned children on Linux".
- Security review L7 (`69a23f6`): "privacy-pages now drives the real project page with the sentinel as the generated key … the REAL changePrivacyClassAction (wrapped to capture every argument) … A positive control shows the capture catches a key passed as an action argument. Mutation evidence (not committed): KeySetup changed to call changePrivacyClassAction(projectId, target, typed) -> the new test FAILED (actionArgs: 40 sentinel windows) while the old SSR-only test still PASSED under the same mutation."
- L9 (`0489182`): "key found in fiber state/props, detached node still held the key, field kept the key after a mismatch and after a refused action" → 4 red, then green.
- Review summary: "No path was found where the key reaches the server" (ADR-0018 *Changes* security review). Real browsers: NOT RUN.
