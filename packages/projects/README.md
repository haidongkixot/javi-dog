# JD-M04 · `@javis-dog/projects` — Project registry

Status: **in-progress**. S1a ships the draft project model; S2 adds persistence (JD-M06), ownership (JD-M03) and hashed, rotatable ingest tokens.

## Public contract

| Export | Description |
|---|---|
| `ProjectInput` | Zod schema for registration input: `name` (2–80), optional `slug`, `description` (≤ 280), `platforms` (≥ 1), `privacyClass` (default `L0`), optional `repositoryUrl` (https GitHub only) |
| `Project` | Stored project: input + `id`, `slug`, `workspaceId`, `createdAt`, `lastSignalAt` (nullable; set only by a verified JGR signal) |
| `normalizeProjectInput(raw)` | Validate and derive the slug |
| `toSlug(name)` | URL-safe slug (handles Vietnamese diacritics, ≤ 48 chars) |
| `Platform`, `platforms`, `PrivacyClass` | Enums shared with JGR (JD-M01) |

## Design notes

- `privacyClass` defaults to **L0** — operational metadata only (product rule 3).
- `lastSignalAt` is never client-writable: freshness must come from the signal path ("Live means verified").
