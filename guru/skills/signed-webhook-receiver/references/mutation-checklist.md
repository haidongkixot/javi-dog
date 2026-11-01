# Mutation checklist for a signed webhook receiver

Generalized from the origin's conformance README (59 vectors, GitHub App bridge). Each row is a defect to introduce once in the implementation; at least one vector must turn red. Record, per mutation: the change, the vectors that failed, the exit code, and that the code was restored. A suite that has never been run against these is not evidence of detection.

| # | Mutation | A vector that must fail |
|---|---|---|
| 1 | HMAC over decoded text or re-serialized JSON | Body with a UTF-8 BOM; invalid UTF-8 bytes; pretty-printed body signed compact |
| 2 | Secret trimmed or read as Latin-1 | Non-ASCII secret; secret with a trailing newline (expect "not configured") |
| 3 | Only the current secret tried; previous tried when unset | Rotation pair: either accepted, a third refused; previous alone → not configured |
| 4 | Lenient header (upper-case hex, other prefix, base64, two values) | One `401` group, identical bodies |
| 5 | Constant-time compare on unequal lengths (throws → `500`) | 63 and 65 hex characters |
| 6 | Different `401` bodies per cause | Equivalence group over every `401` |
| 7 | Decompress instead of `415`, or size checked after decompression | gzip / br / deflate labels |
| 8 | Size cap off by one, or applied after the HMAC | Exactly the cap; cap + 1 with a wrong signature (`413`) and with a malformed header (`401`) |
| 9 | Signature checked before configuration | No secret configured → `503` regardless of other faults |
| 10 | JSON parsed before verification | Malformed JSON with a bad signature → `401`, not `400` |
| 11 | Dedupe on the delivery-id header | Same body, new id → nothing new; two bodies, one id → both stored |
| 12 | Event-type header trusted over the shape, or a missing header defaulted | Re-labelled header; missing header → `202` |
| 13 | Unknown kinds, actions or pings stored | One vector per class |
| 14 | Routing on the target only (ignoring installation id, suspension, claim) | Mismatched installation; suspended; released claim |
| 15 | Age from a creation time or nested commit time; `>=` vs `>` at the boundary | Exactly the window kept; window + 1 s dropped; fresh nested time does not rescue an old event time |
| 16 | Age rule applied to lifecycle events | Old lifecycle timestamps still processed |
| 17 | Hash recorded only for stored events | Replayed uninstall / suspend body after a re-add / unsuspend changes nothing |
| 18 | Hash recorded before a write that fails | **Needs a fault on the write only.** A fault on every store call fails the dedupe read first and cannot see the order (origin: the vector R21 could not; a runner supplement could) |
| 19 | A link kept when the target moves to another installation | Move, then deliver |
| 20 | Event id from the delivery id, wrong case, wrong namespace, index 1 | Every vector with stored events (exact ids) |
| 21 | Thread key missing a component (attempt, repository) | Retry attempt opens a new thread; same number in two repositories → two threads |
| 22 | Sequence not strictly increasing within a thread | Three actions in one second |
| 23 | Status or identity fields on vendor events | Closed attribute set; no status key |
| 24 | Any forbidden field copied into an attribute, row or log | Marker string in every forbidden field, including lifecycle payloads |

Keep a "not covered" list next to it (claims, migrations, purge, response budget, timing) with the layer that covers each instead.
