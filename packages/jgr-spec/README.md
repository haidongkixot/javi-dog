# JD-M01 · `@javis-dog/jgr-spec` — Javi Grande Rules

Status: **in-progress** — JGR **v0.1 draft**. Normative spec: [`docs/jgr/spec/v0.1.md`](../../docs/jgr/spec/v0.1.md). Decision record: [ADR-0004](../../docs/adr/0004-jgr-v0.1-envelope-and-transport.md).

## Public contract

| Export | Description |
|---|---|
| `JgrEvent` | Zod schema of one event envelope (strict: unknown fields rejected) |
| `JgrBatch` | Transport unit: `{ events: [...] }`, 1–100 events |
| `validateEvent(raw, now?)` | Schema + privacy-class + semantic rules → `{ ok, event }` or `{ ok: false, issues[] }` with stable `IssueCode`s |
| `validateBatch(raw, now?)` | Partial acceptance: valid events accepted, invalid ones reported by index |
| `JGR_LIMITS`, `JGR_VERSION` | Hard limits (8 KB/event, 100 events and 256 KB/batch, ±5 min skew) |
| `EventType`, `coreEventTypes`, `Status`, `PrivacyClass`, `UsageDelta`, `EncryptedPayload` | Building blocks |
| `L0_ATTRIBUTES`, `L1_HASHED_ATTRIBUTES` | Attribute allowlists per privacy class |

## Conformance

Vectors live in [`docs/jgr/conformance/vectors/`](../../docs/jgr/conformance/vectors/) as plain JSON (`event`, `receivedAt`, `expect`). Every JGR implementation — this package, the JD-M02 SDK, collectors and the JD-M05 gateway — must reproduce the same verdicts. `test/conformance.test.ts` runs them all.

```bash
pnpm --filter @javis-dog/jgr-spec test
```
