# JD-M11 · `@javis-dog/crypto` — privacy classes L1 and L2

Status: **in-progress** (S5f). Contract: [ADR-0018](../../docs/adr/0018-privacy-classes-l1-l2.md). Wire format: JGR v0.1 §7 ([spec](../../docs/jgr/spec/v0.1.md)).

The project recovery key, the HKDF derivations, the `kid`, L1 keyed hashes and L2 AES-256-GCM payloads. **WebCrypto only** (`globalThis.crypto.subtle`, `crypto.getRandomValues`): the same code runs in Node 22 (the javi collector) and in browsers (the dashboard). No runtime dependency besides JD-M01 (`canonicalEventId()`).

This package does not store, print or send anything. Where a key lives, who sees it and what the UI says are decided by its callers (JD-C01, JD-APP) under ADR-0018.

## Public contract

| Export | Signature | Notes |
|---|---|---|
| `generateProjectSecret` | `() => Uint8Array` | 32 bytes from `crypto.getRandomValues` |
| `encodeRecoveryKey` | `(secret: Uint8Array) => Promise<string>` | `JDK1-XXXX-…` (14 groups of 4); TypeError if not 32 bytes |
| `parseRecoveryKey` | `(text: string) => Promise<ParseRecoveryKeyResult>` | `{ ok: true, secret }` or `{ ok: false, reason, message }`; never throws, never echoes the input |
| `deriveProjectKeys` | `(secret: Uint8Array, slug: string) => Promise<ProjectKeys>` | `{ kid, l2Key, l1Keys: { repo, branch, cwd, file } }`, all keys non-extractable |
| `l1Hash` | `(l1Keys: L1Keys, field: L1Field, value: string) => Promise<string>` | `sha256:<64 lowercase hex>` |
| `buildAad` | `(parts: AadParts) => Uint8Array` | TypeError when a part is empty or contains `\|` |
| `encodeL2Payload` | `(input: L2PayloadInput) => Uint8Array` | always exactly 256 bytes |
| `decodeL2Payload` | `(bytes: Uint8Array) => L2Payload \| null` | `null` unless a v1 payload |
| `encryptL2` | `(l2Key: CryptoKey, kid: string, context: AadContext, payload: L2PayloadInput, testOptions?: EncryptL2TestOptions) => Promise<EncryptedL2>` | fresh 12-byte random IV per call; `testOptions.unsafeFixedIvForTests` is a **test seam only** for encrypt-direction known answers, never used in production |
| `decryptL2` | `(keysByKid: ReadonlyMap<string, CryptoKey>, encrypted: unknown, context: AadContext) => Promise<DecryptL2Result>` | never throws |
| `RECOVERY_KEY_ERROR_MESSAGES` | `Record<RecoveryKeyError, string>` | fixed texts |
| Constants | `src/constants.ts` | every byte-level choice below |

Types: `ProjectKeys`, `L1Keys`, `L1Field` (`'repo' \| 'branch' \| 'cwd' \| 'file'`), `AadParts` (`eventId`, `slug`, `producerId`, `threadRef`, `type`, `kid`), `AadContext` (`AadParts` without `kid`), `L2PayloadInput` (`{ repo?, branch? }` or `{ canary: true }`), `L2Payload`, `EncryptedL2` (`{ alg: 'A256GCM', kid, iv, ciphertext }`), `EncryptL2TestOptions`, `ParseRecoveryKeyResult`, `RecoveryKeyError` (`empty`, `prefix`, `length`, `character`, `checksum`), `DecryptL2Result`, `DecryptL2Failure`.

### `decryptL2` results

| Result | When | ADR-0018 §8 label |
|---|---|---|
| `{ ok: true, payload }` | authentic and a v1 payload | `repo · branch` |
| `no-key` | the map is empty | "Encrypted (key `kid`)" |
| `other-kid` | keys are loaded, none with this `kid` | "Can't decrypt with the key on this device" |
| `unverifiable` | a key with this `kid`, but GCM fails (changed data, or another event, thread, type, project, producer or `kid` in the AAD), or the plaintext is not a valid v1 payload (G10) | "Can't verify this encrypted data (changed or damaged)" |
| `malformed` | wrong shape of the encrypted object or of the AAD context | — |

## Byte-level details

All of them are in [`src/constants.ts`](src/constants.ts). They follow the binding rules G1–G12 recorded in ADR-0018's Changes.

| Item | Choice |
|---|---|
| Base32 | Crockford alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`, MSB-first over the bytes (as RFC 4648 base32), no `=` padding, final partial group padded with zero bits |
| Recovery key | `JDK1-` + base32(32 bytes) (52 chars; the last one holds 1 data bit and 4 zero pad bits) + checksum (4 chars), groups of 4 joined by `-` |
| Checksum | first 4 base32 chars of SHA-256(the 32 bytes) = its first 20 bits |
| Parsing (G2) | removes only U+0020 and `-`, upper-cases, requires the literal `JDK1` prefix; `I`, `L`, `O` and `U` are refused (no Crockford aliases); non-zero pad bits are refused (`character`); inputs over 512 chars are refused (`length`) |
| HKDF | HKDF-SHA256, salt = empty byte string, IKM = the 32 bytes, `info` = UTF-8 of `<label>\|<slug>` |
| Labels | `jgr/kid/v1`, `jgr/l2/aes-gcm/v1`, `jgr/l1/v1/repo`, `…/branch`, `…/cwd`, `…/file` |
| Slug | `^[A-Za-z0-9_:-]{1,128}$` (JGR opaque ref; no `\|`) |
| `kid` (G4) | base32 of 5 bytes of HKDF output = 8 chars (the first 8 chars of any longer output are the same) |
| L2 key | 32 bytes of HKDF output → AES-256-GCM, usages `encrypt`, `decrypt` |
| L1 keys | 32 bytes of HKDF output each → HMAC-SHA256 with `length: 256`, usage `sign` |
| L1 value | `sha256:` + lowercase hex of HMAC-SHA256(field key, UTF-8(NFC(value))) |
| AAD | UTF-8 of `jgr\|v1\|<canonicalEventId(event_id)>\|<slug>\|<producer_id>\|<thread_ref>\|<type>\|<kid>\|L2` |
| Payload (G8, G12) | `JSON.stringify` with keys in the order `v`, `repo`, `branch` (or `v`, `canary`), absent fields omitted, raw UTF-8, padded with `0x20` to 256 bytes |
| Name cut (G5, G6) | per field: NFC, then the longest prefix of at most 100 code points whose JSON-escaped UTF-8 length (without quotes) is at most 113 bytes; 2 × 113 + 29 = 255 < 256 |
| IV | 12 random bytes, base64url (16 chars) |
| Ciphertext | base64url (RFC 4648 §5, no padding) of C ‖ T with a 128-bit tag: 272 bytes, 363 chars for a v1 payload |

## Browser compatibility

- `eslint.config.mjs` forbids Node built-ins (`node:*`, `crypto`, `buffer`, …) and Node-only globals (`Buffer`, `process`, `require`) in `src`.
- `test/web-only.test.ts` scans `src` for imports and Node globals, and runs a full round trip with a `crypto` global that has only `subtle` and `getRandomValues`.
- `test/browser-env.test.ts` runs under Vitest's jsdom environment. Its WebCrypto is still Node's engine; a run in a real browser engine is the owner's run (TEST_PLAN §S5f).

## Tests

```bash
pnpm --filter @javis-dog/crypto test
```

Known-answer vectors are written independently by QA from ADR-0018 (`docs/jgr/conformance/privacy/`), not here.
