---
'@javis-dog/jgr-spec': patch
---

`EncryptedPayload.iv` must be exactly 16 base64url characters (the 12-byte AES-GCM IV, ADR-0018 §4). Longer or shorter values, including the 22-character 16-byte form accepted before, are rejected as `schema` issues on `encrypted.iv`.
