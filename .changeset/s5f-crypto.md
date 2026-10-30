---
'@javis-dog/crypto': minor
---

New JD-M11 package (ADR-0018): project recovery key (`JDK1-…`, Crockford base32 with a SHA-256 checksum), HKDF-SHA256 derivations per project slug, derived `kid`, L1 HMAC-SHA256 hashes per field, the L2 payload v1 padded to 256 bytes, and AES-256-GCM encryption and decryption with the event AAD. WebCrypto only, so the same code runs in Node 22 and in browsers.
