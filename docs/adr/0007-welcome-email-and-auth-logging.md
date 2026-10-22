# ADR-0007: Welcome email via Resend REST, PII-free auth logging, failed sign-ins return to /sign-in

- Status: Accepted 2026-10-22 (implemented in S2c)
- Date: 2026-10-22
- Deciders: Project owner (Hai), Claude (implementer)
- Modules: JD-M09 (new), JD-M03, JD-APP

## Context and problem statement

The first production sign-in attempt in S2b failed without leaving any evidence (no rows, no logs). S2c also owes the welcome email (roadmap S2). Both touch personal data (email addresses), so logging and email must follow privacy by minimization.

## Decision outcome

- **Welcome email (JD-M09):** `sendWelcomeEmail()` posts to `https://api.resend.com/emails` with `fetch` — no SDK or React Email dependency for one transactional email. Sent from Better Auth's `user.create.after` hook through an injected `onUserCreated` callback, so JD-M03 does not depend on JD-M09. Failures are caught, logged as `onUserCreated failed: <ErrorName>` and never block sign-in. Errors carry the HTTP status only, never the address. Existing users (created before S2c) do not receive it.
- **Copy:** brand voice, no "live/secure/encrypted" claims; says agent connections arrive later.
- **Auth logging:** Better Auth `logger` → one JSON line per event (`{ event: "auth", level, message }`) at `warn` and above; extra arguments are dropped and emails / token-like strings (`gh*_`, `ya29.`, JWTs, `jd_it_`) are redacted.
- **Failed OAuth callbacks:** `onAPIError.errorURL = "/sign-in"`; the page shows a readable message with the sanitized `error` code (`access_denied` gets its own wording).
- **Authorization rule (from ADR-0006, implemented):** server actions and pages call `getViewer()`, which resolves the workspace from the session plus a membership check (`resolveWorkspace`). Form fields and URLs never choose the workspace; foreign or malformed project ids are "not found".

## Consequences

- Positive: sign-in failures now leave evidence and a recoverable UI; no new dependencies; email cannot break sign-in.
- Negative: plain HTML email (no React Email templates yet); the soft token limit can be exceeded by concurrent issues (ADR-0005).
- Follow-up: alert emails (JD-M12, S4) may justify React Email; consider an email preference before any non-transactional mail.
