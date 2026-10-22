---
name: prove-secrets-and-pii-minimization
description: Design and then prove what an app stores about secrets and personal data — API/ingest tokens kept only as a hash with a recognizable prefix and a display prefix, shown once; third-party OAuth tokens encrypted; fields you do not use (such as an OAuth provider's id_token) not stored at all; logs structured and redacted; failures that leave evidence without leaking; secrets pasted in chat handled by hash comparison and recorded for rotation. The proof step inspects real stored rows by shape (counts, booleans, lengths, prefix classes) and scans every column for plaintext markers, never printing values, and turns each finding into a red-to-green test through the same call path the real flow uses. Use when issuing API keys or personal access tokens, integrating an auth library or OAuth/OIDC sign-in, enabling token encryption at rest, writing auth or error logging, after the first real sign-ins or token issues in an environment, when a user or owner pastes a secret into chat or an issue, or when someone claims data is "hashed", "encrypted" or "not stored".
metadata:
  version: "0.1.0"
  origin: "javis-dog G2-prep"
  confidence: medium
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
- In unit tests, assert on substrings, not equality: `columns.some(v => String(v).includes(secret))`. An equality check (`values.includes(token)`) misses a token embedded in a longer string.

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

## Pitfalls

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
