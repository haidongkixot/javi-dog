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
| `encryptL2` | `(l2Key: CryptoKey, kid: string, context: AadContext, payload: L2PayloadInput) => Promise<EncryptedL2>` | fresh 12-byte IV per call |
| `decryptL2` | `(keysByKid: ReadonlyMap<string, CryptoKey>, encrypted: unknown, context: AadContext) => Promise<DecryptL2Result>` | never throws |
| `RECOVERY_KEY_ERROR_MESSAGES` | `Record<RecoveryKeyError, string>` | fixed texts |
| Constants | `src/constants.ts` | every byte-level choice below |

Types: `ProjectKeys`, `L1Keys`, `L1Field` (`'repo' \| 'branch' \| 'cwd' \| 'file'`), `AadParts` (`eventId`, `slug`, `producerId`, `threadRef`, `type`, `kid`), `AadContext` (`AadParts` without `kid`), `L2PayloadInput` (`{ repo?, branch? }` or `{ canary: true }`), `L2Payload`, `EncryptedL2` (`{ alg: 'A256GCM', kid, iv, ciphertext }`), `ParseRecoveryKeyResult`, `RecoveryKeyError` (`empty`, `prefix`, `length`, `character`, `checksum`), `DecryptL2Result`, `DecryptL2Failure`.

### `decryptL2` results

| Result | When | ADR-0018 §8 label |
|---|---|---|
| `{ ok: true, payload }` | authentic and a v1 payload | `repo · branch` |
| `no-key` | the map is empty | "Encrypted (key `kid`)" |
| `other-kid` | keys are loaded, none with this `kid` | "Can't decrypt with the key on this device" |
| `unverifiable` | a key with this `kid`, but GCM fails: changed data, or another event, thread, type, project, producer or `kid` in the AAD | "Can't verify this encrypted data (changed or damaged)" |
| `malformed` | wrong shape of the encrypted object, of the AAD context or of the decrypted payload | — |

## Byte-level details

All of them are in [`src/constants.ts`](src/constants.ts).

| Item | Choice |
|---|---|
| Base32 | Crockford alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`, MSB-first over the bytes (as RFC 4648 base32), no `=` padding, final partial group padded with zero bits |
| Recovery key | `JDK1-` + base32(32 bytes) (52 chars; the last one holds 1 data bit and 4 zero pad bits) + checksum (4 chars), groups of 4 joined by `-` |
| Checksum | first 4 base32 chars of SHA-256(the 32 bytes) = its first 20 bits |
| Parsing | removes whitespace and `-`, upper-cases, requires the literal `JDK1` prefix; aliases `I`/`L` → `1` and `O` → `0` in body and checksum; non-zero pad bits are refused (`character`); inputs over 512 chars are refused (`length`) |
| HKDF | HKDF-SHA256, salt = empty byte string, IKM = the 32 bytes, `info` = UTF-8 of `<label>\|<slug>` |
| Labels | `jgr/kid/v1`, `jgr/l2/aes-gcm/v1`, `jgr/l1/v1/repo`, `…/branch`, `…/cwd`, `…/file` |
| Slug | `^[A-Za-z0-9_:-]{1,128}$` (JGR opaque ref; no `\|`) |
| `kid` | base32 of the HKDF output, first 8 chars (first 40 bits; L = 32 or L = 5 give the same chars) |
| L2 key | 32 bytes of HKDF output → AES-256-GCM, usages `encrypt`, `decrypt` |
| L1 keys | 32 bytes of HKDF output each → HMAC-SHA256 with `length: 256`, usage `sign` |
| L1 value | `sha256:` + lowercase hex of HMAC-SHA256(field key, UTF-8(NFC(value))) |
| AAD | UTF-8 of `jgr\|v1\|<canonicalEventId(event_id)>\|<slug>\|<producer_id>\|<thread_ref>\|<type>\|<kid>\|L2` |
| Payload | `JSON.stringify` with keys in the order `v`, `repo`, `branch` (or `v`, `canary`), absent fields omitted, names NFC-normalised and cut to 100 code points, then padded with `0x20` to 256 bytes |
| Over-long payload | if the JSON still exceeds 256 bytes (multi-byte characters, escapes), whole code points are removed from the end of the name whose JSON string is longer in bytes, the branch on a tie |
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
