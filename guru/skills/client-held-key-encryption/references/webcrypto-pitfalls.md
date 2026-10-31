# WebCrypto pitfalls for byte-exact protocols

WebCrypto (`globalThis.crypto.subtle`) runs unchanged in Node 22+ and in every evergreen browser in a secure context, which makes it a good base for code shared between a CLI and a web app. Its defaults are chosen for convenience, not for a wire format two implementations must agree on. Write each of these as an explicit rule in your spec and pin it with a known-answer vector.

| Topic | What WebCrypto does | Rule to write | Vector / mutation |
|---|---|---|---|
| HMAC key from `deriveKey` | Without `length`, the key is the hash's **block size**: 64 bytes for SHA-256 (probe: Node 22.22.0) | `length: 256` (32 bytes) stated in the spec and the code | Known answer of one HMAC with the 32-byte and with the 64-byte key; mutation "default length" must fail it |
| HKDF salt | A zero-length salt and an absent salt (RFC 5869: HashLen zeros) give the same PRK | Say "empty salt = zero-length", and that both readings agree | Derivation known answers |
| HKDF output length | Output is a prefix stream: a shorter length is a prefix of a longer one | State the length per derived value anyway (key id, encryption key, MAC keys) | Key id from different lengths gives the same characters |
| AES-GCM IV length | Accepts IVs other than 12 bytes (probe on Node 22.22: 16 accepted, 11 rejected; engines differ) | Exactly 12 random bytes; the decoder refuses anything else before calling WebCrypto | IV of 11 and 16 bytes must be refused |
| AES-GCM tag | `tagLength: 96` is accepted; the tag is appended to the ciphertext | 128-bit tag only; ciphertext field = ciphertext ‖ tag; refuse shorter | Truncated tag must be refused |
| AAD mismatch | Decryption throws `OperationError` | Catch and map to a typed failure; never surface partial output | Each AAD part changed must fail |
| base64url | Not in WebCrypto; your encoder decides padding | Unpadded everywhere; `=` refused | Padded input must be refused |
| Base32 for human keys | Not in WebCrypto | Name the alphabet, bit order (RFC 4648 §6, MSB first), padding of the last character, case, aliases | Two readings (bit stream vs. big integer) give different strings: vector both |
| Unicode | Bytes in, bytes out | NFC before hashing and before cutting; cut at code points, never UTF-16 units | NFD and NFC inputs give the same hash; an astral character is not split |
| JSON plaintext | Not in WebCrypto | Key order, no whitespace, raw UTF-8, escaping (ES2019 `JSON.stringify`) | Producer-side padded plaintext bytes |
| Key extractability | `extractable: false` keys can still be **used** by any script on the page, and stored in IndexedDB | Treat a stored key as usable by injected script; gate storage on a CSP | — |
| Test environments | jsdom with Node's WebCrypto uses Node's crypto engine | Report jsdom runs as "Node engine", not browser evidence; keep real-browser runs as NOT RUN until done | — |

## Reference computation that is actually independent

Two programs that share a library share its bugs. The origin's QA lane computed every expected value with:

1. **Primary:** Node WebCrypto plus its own base32 and NFC code; it wrote the vector files and asserted invariants (round trips, refusals, distinctness).
2. **Cross-check:** Python with stdlib `hashlib`/`hmac`, a hand-written RFC 5869 HKDF, `base64.b32encode` remapped to the chosen alphabet, `unicodedata` NFC, `json.dumps`, the `cryptography` package's AES-GCM — and the OpenSSL CLI (`openssl kdf HKDF`, `openssl mac HMAC`, AES-GCM rebuilt from `aes-256-ctr` plus a hand-written GHASH).

Result: 366 checks, 0 mismatches, and a deliberately planted change in three files was caught. Commit both programs next to the vectors (with fake keys only) so the cross-check can be re-run; the origin did not, which is a gap.

## Probe

```js
// node probe.mjs — prints the defaults this table relies on, for your engine and version.
const s = globalThis.crypto.subtle;
const ikm = await s.importKey('raw', new Uint8Array(32), 'HKDF', false, ['deriveKey']);
const p = { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('probe') };
const k = await s.deriveKey(p, ikm, { name: 'HMAC', hash: 'SHA-256' }, true, ['sign']);
console.log('HMAC default key bytes:', (await s.exportKey('raw', k)).byteLength); // 64 on Node 22.22
const aes = await s.importKey('raw', new Uint8Array(32), 'AES-GCM', false, ['encrypt']);
for (const n of [11, 16]) {
  await s.encrypt({ name: 'AES-GCM', iv: new Uint8Array(n) }, aes, new Uint8Array(1)).then(
    () => console.log(`iv ${n}: accepted`), (e) => console.log(`iv ${n}: rejected ${e.name}`));
}
```
