# Privacy classes L1/L2 conformance vectors (ADR-0018, S5f)

Known-answer and black-box cases for JD-M11 `@javis-dog/crypto` and the browser display of L2 data. There are three groups:

- **Keys and derivations (`K*`).** Recovery key format and parsing; HKDF-SHA256 derivations of `kid`, the L2 key and the L1 field keys per project slug; L1 HMAC values, including NFC normalisation and per-field and per-project separation.
- **L2 encryption (`E*`).** AAD byte strings, padding to 256 bytes and the 100-code-point cut, AES-256-GCM known answers, and decryption that succeeds or MUST fail.
- **Payload and labels (`P*`).** The plaintext JSON before padding, the canary, and the text the browser shows in each key and decryption state.

- **Oracle independence.** Every expected value comes only from the texts under [Sources](#sources). No code under `packages/**/src`, `collectors/**/src` or `apps/**` was read; there is no JD-M11 code yet. `packages/jgr-spec/src/{schema,validate}.ts` was **not** read either: the canonical `event_id` rule and the ref pattern come from spec v0.1 §3 and §9. The [self-report suite](../self-report/README.md) was read for format conventions only. Where the texts allow more than one reading, the suite lists a [spec gap](#spec-gaps-g) with a proposed exact value and marks every vector that depends on it. No value is invented silently.
- **Format.** One JSON file per vector, named `<K|E|P><NN>-<kebab-name>.json`, valid against [`schema.json`](schema.json) (JSON Schema draft-07). Each file holds `cases` (or, for P04, `sequences` of `steps`). Every key is always present; `null` means "not applicable". Non-ASCII characters are written as `\uXXXX` escapes so that editors cannot normalise NFD text or drop bidi controls.
- **Fake keys only.** Every secret here is a fixed, public test pattern (S1–S4 below). None of them is, or may ever be used as, a real project key.
- **Status.** Written 2026-10-30 for S5f task K5 part 1, before any JD-M11 code (QA lane). Values are known answers computed by a throwaway reference outside the repository and cross-checked by a second, independent method ([Reference computation](#reference-computation)).

## Sources

All at commit `e3a2ad5` (branch `claude/clever-goldberg-wlurty`, "ADR-0018 design review D0"). Contract strings in the vectors read `ADR-0018 (e3a2ad5)`.

| Source | Sections used |
|---|---|
| [ADR-0018](../../../adr/0018-privacy-classes-l1-l2.md) | **Normative.** Decision 1 (recovery key: Crockford base32, `JDK1-`, groups of 4, SHA-256 checksum, parsing), decision 2 (HKDF-SHA256, empty salt, `info` ending in `\|<project slug>`, `kid`, L2 key, L1 key per field), decision 3 (L1 = `sha256:` + lower-case hex HMAC-SHA256 of the UTF-8 value), decision 4 (payload v1, NFC, IV, AAD, padding, cut to 100 code points), decision 5 (identity event, canary), decision 8 (display states, bidi removal, `repo · branch`), decision 9 (honest labels, "checked" remembered per project and `kid`), decision 10 (several keys matched by `kid`), Verification ("Known-answer vectors … QA writes them from this ADR"). The **Changes — design review D0** table (H3 slug only, M1 `thread_ref` and `type` in the AAD, M2 padding, M6 base32 groups, M8 failed-decryption label) is part of the decisions above. |
| [JGR spec v0.1](../../spec/v0.1.md) | §3 envelope (`event_id` ULID or UUID, canonical form ULID upper-case and UUID lower-case; opaque refs `^[A-Za-z0-9_:-]{1,128}$`), §7 privacy classes (`encrypted` object `{ alg: "A256GCM", kid, iv, ciphertext }` in base64url; L1 wire format `sha256:<64 hex>`), §9 canonical `event_id` ("`01jbz…` and `01JBZ…` are the same event"). At `e3a2ad5` §7 still says "SHOULD use a per-project salt" and does not tighten `iv`; the vectors follow ADR-0018, which announces both changes. |
| [TEST_PLAN §S5f](../../../agent-ops/TEST_PLAN.md) | Rows on HKDF, `kid`, L1 HMAC, AAD bytes, AES-GCM, recovery-key format; decryption failures; AAD moved to another thread, type or slug and the `\|` rejection; padding; label states for no key, wrong key and failed decryption. |
| [TEAM.md](../../../agent-ops/TEAM.md) | QA role: vectors from spec and ADR text only. |

## Fixtures

| Name | Value | Use |
|---|---|---|
| S1 | bytes `0x00` … `0x1f` | Main project key |
| S2 | 32 × `0x00` | Base32 edge (`0000…`); a wrong key |
| S3 | 32 × `0xff` | Base32 edge (`ZZZZ…ZZZG`) |
| S4 | ASCII `JAVIS-DOG-QA-FAKE-KEY-NOT-REAL-1` (32 bytes) | Another key: rotation, a second project, a wrong key |
| Slugs | `web-app`, `javis-dog-web-app` | Per-project separation |
| `kid` | S1/`web-app` `0Q12NAV3`; S1/`javis-dog-web-app` `1NGPYP9N`; S2/`web-app` `HDPZZDPF`; S3/`web-app` `QX1DXA7C`; S4/`web-app` `5E12TC2A`; S4/`javis-dog-web-app` `9WPMQ21J` | Derived in K04 |
| IVs | `a0a1…ab`, `b0b1…bb`, `c0c1…cb`, `d0d1…db`, `e0e1…eb` (12 bytes each) | Fixed only to make answers reproducible |
| Event ids | ULIDs `01JBZ4XQ80000000000000001A` (spec §3 example), `…2B`, `…3C`, `…4D`; UUID `018F2C3A-7B1D-7C2E-9A4B-5D6E7F8A9B0C` | AAD canonicalisation |
| Envelope | producer `prod_conformance` (`prod_conformance_b`), threads `cc_privacy_t1` … `t4`, `cc_privacy_install`, `gm_privacy_t2`; types `x.javi.thread.identity`, `x.javi.collector.installed` | AAD parts |

S1's recovery key is `JDK1-000G-40R4-0M30-E209-185G-R38E-1W81-24GK-2GAH-C5RR-34D1-P70X-3RFG-CC6W`, and its AAD for the identity event is `jgr|v1|01JBZ4XQ80000000000000001A|web-app|prod_conformance|cc_privacy_t1|x.javi.thread.identity|0Q12NAV3|L2`.

## Vector file format

Every file starts with the same head:

| Field | Meaning |
|---|---|
| `$schema` | Always `./schema.json`. |
| `id` | `K01` … `K07`, `E01` … `E06`, `P01` … `P04`; the file name starts with it. |
| `kind` | Which runner rule applies (below). |
| `description` | What the vector proves. |
| `contract` | `ADR-0018 (e3a2ad5)` plus the decisions it encodes. |
| `ambiguities` | Ids of the [spec gaps](#spec-gaps-g) and [readings](#readings-y) the expected values depend on. Gap ids inside a case `note` (for example `[G2]`) narrow this to that case. |
| `cases[].label` | Unique within the file; a runner names it in its report. |
| `cases[].note` | Human-readable intent of the case. |

Shared shapes:

| Shape | Fields |
|---|---|
| Key reference (`key`, `deviceKeys[]`) | `secret` (`S1` … `S4`), `secretHex` (64 hex), `slug`. The runner derives every key itself from `secretHex` and `slug`; derived keys are never read from the file except in `aead`-layer cases. |
| `event` | `event_id`, `project_slug` (the project ref, always a slug, D0 H3), `producer_id`, `thread_ref`, `type`, `privacy_class`, `encrypted` `{ alg, kid, iv, ciphertext }`. Only the fields the AAD and decryption use; a runner may add any other valid envelope fields. |
| `reason` | Informative failure category (`prefix`, `character`, `length`, `noncanonical`, `checksum`, `aad_part_pipe`, `no_key`, `kid_mismatch`, `auth_failed`, `iv_length`, `encoding`, `alg`). **Never compared**: ADR-0018 defines no error codes. |

Per kind:

| Kind (vectors) | Input | Expect |
|---|---|---|
| `recovery-key-format` (K01) | `secretHex` | `body` (52 characters), `checksum` (4), `sha256Hex` of the secret, `recoveryKey` (exact display string) |
| `recovery-key-parse` (K02, K03) | `input` string | `ok`; `secretHex` when accepted, else `null`; `reason` |
| `derive` (K04) | `secretHex`, `slug` | `info` strings (exact UTF-8 text of HKDF `info`), `kidOkm5Hex` (first 5 HKDF output bytes), `kid`, `l2KeyHex` (32 bytes), `l1KeyHex` per field (32 bytes each) |
| `l1-hash` (K05–K07) | `secretHex`, `slug`, `field`, `value`, `valueUtf8Hex` (the bytes of `value` as written, before NFC) | `nfcUtf8Hex`, `hash` (`sha256:` + 64 lower-case hex). File-level `plainSha256` (K07 only, else `null`): plain SHA-256 values that no hash in the file may equal |
| `aad` (E01, E02) | `event_id`, `project_slug`, `producer_id`, `thread_ref`, `type`, `kid`, `privacy_class` | `ok`; `aadUtf8` and `aadHex` when built, else `null` and `reason` `aad_part_pipe` |
| `payload` (E03, P01, P02) | `repo`, `branch` (`null` = absent), `canary` | `payload` (as an object), `json` (exact serialisation before padding), `jsonByteLength`, `paddedByteLength` (256), `paddedSha256Hex`, `paddedHex` (the exact 256 plaintext bytes) |
| `aes-gcm` (E04) | `key`, `l2KeyHex`, `ivHex`, `plaintextHex` (256 bytes), `aadUtf8` | `ciphertextAndTagHex` (272 bytes), `tagHex` (last 16), and the full `event` with the `encrypted` object as it travels |
| `decrypt` (E05, E06) | `layer` `envelope`: `deviceKeys` and `event`. `layer` `aead`: `aead` `{ l2KeyHex, ivHex, ciphertextAndTagHex, aadUtf8 }`, `deviceKeys` empty, `event` `null` | `ok`; on success `payload` and the `aadUtf8` the decryptor built; on failure both `null` |
| `label` (P03) | `deviceKeys`, `event` | `state` (`no-key`, `other-kid`, `failed`, `decrypted`), `threadText` |
| `label-sequence` (P04) | `project` `{ slug, privacyClass, kid }`; `sequences[].steps[]` with `action` (`open`, `decrypt`, `reload`), `deviceKeys`, `event` | `projectLabel` after the step |

## Runner rules

**Layers.** The same files run in two environments (ADR-0018 Verification): JD-M11 under Node (`globalThis.crypto.subtle`), and the browser-side code under jsdom with Node's WebCrypto. The report names the environment. jsdom shares Node's crypto engine, so it is not evidence of browser behaviour; real browsers stay NOT RUN until the owner runs them (TEST_PLAN §S5f).

**Reading the files.** Parse with a JSON parser and use strings exactly as parsed. Never normalise, trim or re-encode a vector string before passing it in: NFD inputs, bidi controls, surrogate pairs and trailing spaces are the test.

**Comparisons.** Hex strings: exact, lower case. Strings (`body`, `kid`, `aadUtf8`, `json`, `ciphertext`, labels): exact, code point for code point. `payload` objects: deep-equal, and an absent key MUST be absent (not `null`, not `""`).

**Per kind.**

- `recovery-key-format`: format `secretHex` and compare `recoveryKey`. If the implementation exposes them, also compare `body` and `checksum`.
- `recovery-key-parse`: `ok: true` → the parsed bytes equal `secretHex`. `ok: false` → the parser refuses (throws or returns an error) and yields no key bytes. `reason` is not compared.
- `derive`: derive from `secretHex` and `slug`; compare `kid`, the L2 key bytes and the four L1 key bytes. A JD-M11 that imports keys as non-extractable may expose bytes through a test-only seam, or the runner may prove the keys by their outputs (K05–K07, E04); it says which.
- `l1-hash`: call the L1 function with (`secret`, `slug`, `field`, `value`) and compare `hash`. In K06 the NFD case and its NFC partner MUST give the same value; in K07 every value MUST differ.
- `aad`: build the AAD; compare bytes with `aadHex`, or require a refusal for `ok: false`.
- `payload`: build the padded plaintext from `input`; compare its 256 bytes with `paddedHex`. If the builder exposes the unpadded JSON, compare `json` too.
- `aes-gcm`: **encrypt direction**: with an injected IV (`ivHex`), encrypt `plaintextHex` under the key derived from `key`, for the event in `expect.event`, and compare `encrypted` exactly. This needs an IV seam in JD-M11; without one the encrypt direction is NOT RUN (named next to the result). **Decrypt direction**: decrypting `expect.event` with `key` MUST return exactly `plaintextHex` (or its parsed payload). Producers MUST still draw 12 random bytes per event in production; the fixed IVs here exist only for reproducibility.
- `decrypt`: `envelope`: give the device the `deviceKeys` and decrypt `event`. `aead`: call the raw AES-256-GCM decryption with the given key bytes, IV, ciphertext‖tag and AAD bytes. `ok: true` → the payload deep-equals `expect.payload`; if the implementation exposes the AAD it built, it equals `aadUtf8`. `ok: false` → refusal, no plaintext (not even partial).
- `label`: render the thread row for `event` with `deviceKeys` in the tab; compare the row's text (DOM `textContent`, runs of whitespace collapsed to one space and trimmed) with `threadText`. `state` is informative.
- `label-sequence`: one fresh browser profile per sequence. `open` opens the project page; `decrypt` makes the tab hold exactly `deviceKeys` and shows `event`; `reload` reloads the tab, which drops in-memory keys but keeps the remembered "checked" state ([decision 9](#sources)). After each step compare the project label text (same whitespace rule) with `projectLabel`.

**Gaps.** A vector whose `ambiguities` lists a G id encodes this suite's **proposed** resolution of that gap. A FAIL on it names the gap ids, so the owner can decide whether the proposal or the implementation should change. Until ADR-0018 resolves a gap, such a vector is still run and reported (PASS or FAIL with the G ids), never silently skipped.

**Results.** Each vector reports exactly one of PASS, FAIL, BLOCKED, NOT RUN or SKIPPED (Orcasus contract), as in the [self-report suite](../self-report/README.md#results). A vector passes only if every case passes. SKIPPED needs a recorded owner decision.

## Vectors

| Id | Proves | Cases |
|---|---|---:|
| K01 | Recovery key display string for S1–S4: `JDK1-`, 52-character body, 4-character SHA-256 checksum, 14 groups of 4 | 4 |
| K02 | Parsing ignores case, spaces and dashes: lower case, mixed case, no dashes, spaces, outer spaces, other grouping, doubled separators → the same 32 bytes | 10 |
| K03 | Refused: a changed body or checksum character, an adjacent transposition, a missing or extra character, a missing checksum, empty input, `JDK2`, no prefix, `U`, `_`, Crockford look-alikes `O` / `I` / `L` (G2), non-zero padding bits (G1, G2), another key's checksum | 18 |
| K04 | HKDF per (secret, slug): exact `info` strings, `kid`, L2 key, four L1 keys; all distinct across secrets and slugs | 6 |
| K05 | L1 values for `repo`, `branch`, `cwd`, `file`, including an astral character | 7 |
| K06 | NFD input = NFC hash (`café`, `Ångström`, Hangul, a `cwd` path); a ligature shows NFC is not NFKC | 10 |
| K07 | Separation: the same value under another field, slug or secret gives another hash; no case folding; never the plain SHA-256 | 6 |
| E01 | AAD bytes; a lower-case or mixed-case ULID and an upper-case UUID are canonicalised; the canary type; another project | 6 |
| E02 | A `\|` in the slug, `producer_id`, `thread_ref`, `type`, `kid` or class is refused, including a split that would collide | 7 |
| E03 | Padding to exactly 256 bytes; a 100 + 100 ASCII maximum (229 bytes); cut to 100 code points, not UTF-16 units; astral, escaped and NFD inputs under the proposed byte budget (G5, G6) | 7 |
| E04 | AES-256-GCM known answers: identity event, canary, another project with repo only, non-ASCII with a bidi control, branch only | 5 |
| E05 | Decryption succeeds: each E04 event; a lower-case ULID and an upper-case UUID in the stored event; the key chosen by `kid` among three | 8 |
| E06 | Decryption refused: no key, a wrong key, the same secret for another slug, a swapped `kid`; a changed `event_id`, slug, `producer_id`, `thread_ref`, `type` (envelope); each AAD part including `kid`, class and version (AEAD layer); a flipped ciphertext or tag bit; a tag cut to 15, 12 or 0 bytes; another IV; a 16-, 11-byte or padded IV; another `alg`; a `\|` in a part; the wrong key at the AEAD layer | 31 |
| P01 | Payload shape: both names, repo only, branch only, neither (G8), JSON escapes, raw UTF-8, NFC, bidi controls kept in the payload | 8 |
| P02 | The canary `{"v":1,"canary":true}` padded to 256 bytes | 1 |
| P03 | Thread text: "Encrypted (key `kid`)", "Can't decrypt with the key on this device" (one or several other keys), "Can't verify this encrypted data (changed or damaged)" (moved, changed, truncated), `repo · branch`, one name (G8), bidi controls removed | 11 |
| P04 | Project label: "L2 set up. No encrypted event checked yet." until a decryption with the right AAD (canary or identity event); not after no key, a damaged canary or another `kid`; kept across a reload | 8 |

Totals: 17 vectors, 153 cases (K 61, E 64, P 28).

## Suggested mutation checks

Each mutation must turn at least the listed vector to FAIL.

| Mutation | Vector |
|---|---|
| Base32 with the RFC 4648 alphabet, or encode the bytes as a left-padded integer | K01, K04 (every `kid`) |
| Checksum over the base32 text instead of the 32 bytes, or the last 4 characters of SHA-256 | K01, K03 |
| Groups of 5, or no group separator after `JDK1` | K01 |
| Case-sensitive parsing, or dashes or spaces not ignored | K02 |
| Accept a key without the checksum check, or without the prefix | K03 |
| HKDF without the `\|<slug>` suffix, with the slug as salt, or with a non-empty salt | K04–K07, E04–E06 |
| L1 key with the WebCrypto default HMAC length (64 bytes) | K05–K07 (G4) |
| One HMAC key for all fields | K07 (`other-field`) |
| A plain or salted SHA-256 instead of HMAC | K05, K07 |
| Upper-case hex, or no `sha256:` prefix | K05 |
| No NFC, or NFKC | K06 |
| `event_id` not canonicalised, or canonicalised to lower case | E01, E05 |
| AAD without `thread_ref` or `type`, or in another order | E01, E06 (`aad-thread`, `aad-type`) |
| Join parts that contain `\|` | E02, E06 (`pipe-in-thread`) |
| No padding, padding with NUL bytes, or padding in front | E03, E04, P01, P02 |
| Cut by UTF-16 units or by bytes in the middle of a code point | E03 (`cut-code-points-not-units`) |
| Base64 with `+` and `/`, or with `=` padding | E04 |
| Accept any IV length (WebCrypto does) | E06 (`iv-16-bytes`, `iv-11-bytes`) |
| Accept a 96-bit tag (`tagLength: 96`) | E06 (`tag-truncated-4`) |
| Choose the key by position instead of by `kid` | E05 (`several-keys`) |
| Return a partial plaintext on failure | E06 |
| One label for every failure, or "Can't verify" for a missing key | P03 |
| Show bidi controls, or render names as HTML | P03 (`success-bidi-removed`) |
| Mark "checked" on a received event, on a failed decryption or on another `kid` | P04 |
| Forget the "checked" state on reload | P04 (step 6) |

## Not covered

| Contract item | Why |
|---|---|
| Collector behaviour: key input (`/dev/tty`, key file, `JAVI_PRIVACY_KEY` removed from the env), mode 0600, never printed, `init` canary-first, `--no-verify` refused, UUID project refs refused | Process tests (TEST_PLAN §S5f rows on the collector, D0 H2, H3, M3). |
| Which events carry L1/L2 data (`x.javi.thread.identity` after `session.started` and the collector `heartbeat working`; everything else L0) | Process tests; a hook-level suite could follow. Note G11 on the stale TEST_PLAN row. |
| `.git/HEAD` reading (FIFO, size cap, `gitdir:`, worktree, detached HEAD) and which string `cwd_hash` hashes | Process tests (D0 M4); the `cwd` input string is open (G13). |
| Randomness and uniqueness of the IV per event | Not a known answer. A runner MAY check that two encryptions of the same payload have different IVs. |
| The validator's `iv` length (exactly 16 characters) and ingest | JD-M01 vectors in [`../vectors/`](../vectors/) and unit tests. |
| A plaintext that decrypts but is not a valid v1 payload (not 256 bytes, not JSON, `v` ≠ 1, unknown keys) | No label is defined (G10). |
| Key input attributes, paste-back confirmation, download, IndexedDB "remember", clearing on sign-out, `401` and `BroadcastChannel`, CSP | Component, owner and bounded browser runs (TEST_PLAN §S5f). |
| The sentinel search proving the key never reaches the server | Component and server-action tests (TEST_PLAN §S5f). |
| Rotation: which `kid` the project page names after a new key; counting events per key | No server-side current `kid` (deferred in ADR-0018 Changes); G14. |
| L1/L2 reader (newest hashes and `encrypted` as opaque data) | Reader unit tests (PGlite). |

## Ambiguities

### Spec gaps (G)

Each row quotes the ADR-0018 (or TEST_PLAN) line at `e3a2ad5` and proposes an exact rule. The vectors listing the id encode the proposal.

| Id | Line | Question | Proposed exact rule | Vectors |
|---|---|---|---|---|
| G1 | ADR L51, L57 | "the 32 bytes in Crockford base32 (52 characters)": 256 bits fill 51.2 characters. Which bit order, and where do the 4 spare bits go? The same question decides the checksum and the `kid`. | RFC 4648 §6 bit order with the Crockford alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`: bits taken most significant first, the last character zero-padded on the right, no `=`, upper case. The 52nd body character is then always `0` or `G`. Checksum = first 4 characters of the same encoding of SHA-256(secret). `kid` = the same encoding of the first 5 HKDF output bytes. (The other reading, the bytes as a left-padded 256-bit integer, gives S1 body `0001081G81860W40…` instead of `000G40R40M30…`.) | K01–K04, E01, E04–E06 |
| G2 | ADR L51 | "Parsing ignores case, spaces and dashes." Is `JDK1` required? Are Crockford's decode aliases (`O` → 0, `I`/`L` → 1) accepted? Which "spaces" (tabs, newlines)? Are non-zero padding bits accepted? | Remove U+0020 and `-` only; upper-case; require `JDK1` as the first 4 characters; then exactly 56 characters from the alphabet (`O`, `I`, `L`, `U` and anything else refused); the padding bits of the 52nd character MUST be zero; the checksum MUST match. Order of checks (informative): prefix, character, length, padding, checksum. | K02, K03 |
| G3 | ADR L56–L59 | "`info` strings fixed, versioned and ending in `\|<project slug>`" with the labels `jgr/kid/v1`, `jgr/l2/aes-gcm/v1`, `jgr/l1/v1/<field>`: the exact bytes are not written out. | `info` = UTF-8 of `<label>\|<slug>`, the slug verbatim (no case folding): `jgr/kid/v1\|web-app`, `jgr/l2/aes-gcm/v1\|web-app`, `jgr/l1/v1/repo\|web-app`, `jgr/l1/v1/branch\|web-app`, `jgr/l1/v1/cwd\|web-app`, `jgr/l1/v1/file\|web-app`. Salt = zero-length; IKM = the 32 secret bytes. | K04–K07, E01, E04–E06 |
| G4 | ADR L57, L59 | HKDF output length per derivation. `kid`: unstated. L2: 32 bytes (AES-256). L1 HMAC key: unstated, and WebCrypto `deriveKey` to `{ name: "HMAC", hash: "SHA-256" }` without `length` yields **64** bytes (the SHA-256 block size), which changes every L1 value. | `kid`: 5 bytes (40 bits = 8 characters; any length ≥ 5 gives the same 8 characters, HKDF output is a prefix stream). L2 key: 32 bytes. L1 field keys: **32 bytes**, stated explicitly (`length: 256`). Example, S1/`web-app`, branch `main`: 32-byte key → `sha256:3a025e79dd22ed9651905f3804613442376a81d3895dcc3217c7a9dd4634a855`; WebCrypto default 64-byte key → `sha256:b71c21c63e4f7630ef42bb947c394cec368606a08d21213c11d4949882e2db9a`. | K04–K07 |
| G5 | ADR L71 | "names are NFC-normalised before hashing" sits in the `.git/HEAD` reading rules. Does it apply to `cwd` and `file`, to the L2 payload, and is it done by JD-M11 or by the collector? | JD-M11's L1 function normalises every field value to NFC before HMAC, so any other matcher (the browser, a later JD-M10 GitHub App) gets the same hash from the same name. The payload builder normalises `repo` and `branch` to NFC before the cut. | K06, E03, P01 |
| G6 | ADR L83 (and L65) | "`repo` and `branch` are each cut to 100 code points first, so the payload never exceeds 256 bytes" holds only for ASCII without JSON escapes. 100 astral code points are 400 UTF-8 bytes (`{"v":1,"repo":…}` = 417 bytes); 100 `"` are 200 escaped bytes; a repo folder may contain control characters (`\u00XX`, 6 bytes each). The padded size cannot then be 256. (L65's "at most 4 KiB" is moot once every payload is 256 bytes.) | NFC, then per field the longest prefix of at most 100 code points whose JSON-escaped UTF-8 form is at most **113 bytes** (2 × 113 + 29 bytes of fixed JSON = 255 ≤ 256). The cut is at code points; it may split a grapheme cluster. ASCII names of up to 100 characters are unchanged. | E03 (`astral-101`, `escaped-quotes`, `nfd-before-cut`) |
| G7 | Spec §7 L94; ADR L75 | base64url padding. `iv` is fixed at 16 characters, but the 272-byte `ciphertext` is 363 characters unpadded or 364 with `=`. | Unpadded base64url (RFC 7515 §2, matching the JOSE name `A256GCM`); a `=` anywhere is refused. Not checked against the JD-M01 validator, which this lane did not read. | E04–E06 (`iv-padded`) |
| G8 | ADR L65, L110 | "Either field may be absent", but the display is only defined as `repo · branch`. What shows for one name, or none? Is `{"v":1}` ever sent? | One name: that name alone. Neither: no name text (the row looks like an L0 row). The collector still sends the identity event with `{"v":1}`, since it carries the L1 hashes. | P01 (`neither`), P03 (`success-repo-only`, `success-branch-only`) |
| G9 | ADR L111–L112 | "no key for that `kid`" and "a key with another `kid`" overlap when the tab holds keys but none matches, or holds none at all. | No key at all for this project in the tab → "Encrypted (key `kid`)". One or more keys, none with that `kid` → "Can't decrypt with the key on this device". | P03, P04 |
| G10 | ADR L110–L113 | Decryption succeeds (authentic) but the plaintext is not a v1 payload (`v` ≠ 1 from a newer collector, invalid JSON, wrong length). No state is defined. | Open; no vector. Suggestion: `v` ≠ 1 → a neutral "Encrypted with a newer format" text; anything else → the "changed or damaged" text. | — |
| G11 | TEST_PLAN L348, L345 | L348 still says "L1 hashes + L2 payload only on `session.started` and the collector `heartbeat working`", which D0 H1 replaced by `x.javi.thread.identity`. L345 lists the AAD parts as `event_id` / `project_ref` / `producer_id` / class, without `thread_ref`, `type` and `kid`, and says `project_ref` where the AAD uses the slug. | Update both rows to ADR-0018 decisions 4 and 5. | — |
| G12 | ADR L65, L83 | The exact JSON serialisation is not stated (key order, whitespace, escaping of non-ASCII). It decides the padding and every producer-side known answer. | ECMAScript `JSON.stringify` of an object built in the order `v`, `repo`, `branch` (or `v`, `canary`): no whitespace, non-ASCII as raw UTF-8, only `"`, `\` and control characters escaped (lone surrogates as `\uXXXX`, ES2019). | E03, P01 |
| G13 | ADR L86 | Which string is hashed for `cwd_hash`: the hook's `cwd` as given, the real path, with or without a trailing `/`? | The hook's `cwd` string as given, NFC (G5). Not encoded in this suite: K05 and K06 test the L1 function on given strings only. | — |
| G14 | ADR L116; Changes "Deferred: storing the current `kid`" | The checked label names a `kid`, but the server stores no current `kid`. After a rotation, which `kid` does the page show, and does an old "checked" state carry over? | The page names the `kid` of the newest L2 event the reader returns and shows "checked" only if this browser checked that `kid`. Not encoded (P04 has no rotation step). | — |

### Readings (Y)

Choices the suite makes where the text is clear in intent but needs an operational rule. A FAIL that disagrees with one of them should be raised, not patched.

| Id | Reading |
|---|---|
| Y1 | "Empty salt" is a zero-length salt. RFC 5869 §2.2 treats a missing salt as 32 zero bytes, which gives the same PRK (HMAC zero-pads short keys), so both readings agree. |
| Y2 | The HKDF IKM is the 32 raw secret bytes, never the recovery-key text. |
| Y3 | `encrypted.ciphertext` = base64url(ciphertext ‖ 16-byte tag), as WebCrypto returns it (ADR research: "The 128-bit tag is appended to the ciphertext"). |
| Y4 | Padding = bytes `0x20` appended after the JSON (trailing JSON whitespace, so the plaintext parses without stripping). |
| Y5 | The AAD class part is the event's `privacy_class`, which is always `L2` for an event with `encrypted` (spec §7). A changed class is tested only at the AEAD layer (E06 `aead-class`), because an implementation may write the literal `L2`. |
| Y6 | Label text is compared as rendered text. The backticks around `kid` in the ADR are formatting, not characters: "Encrypted (key 0Q12NAV3)". Apostrophes are ASCII U+0027, as in the ADR and the brand guide. `repo · branch` is U+0020 U+00B7 U+0020. |
| Y7 | "Bidi control characters" = the Unicode `Bidi_Control` property: U+061C, U+200E, U+200F, U+202A–U+202E, U+2066–U+2069. They stay in the payload and are removed only for display. |
| Y8 | A decryption counts as "checked" (P04) only for an event of the same project slug whose `kid` is the project's; a received event that this browser could not decrypt does not count. |
| Y9 | A decryptor refuses an `iv` that is not exactly 12 bytes and a ciphertext‖tag shorter than 16 bytes of tag, even though WebCrypto AES-GCM accepts other IV lengths and a 96-bit `tagLength` (ADR L75 "12 random bytes", research "128-bit tag"). |
| Y10 | The `kid` check comes first: an event whose `kid` matches no key in the tab is never passed to AES-GCM (ADR L57 "the browser can check which key an event used"). In E06 `kid-swapped` both keys are present, so the lookup picks the S4 key and the refusal comes from AES-GCM (another key and another AAD `kid`), not from the lookup. |

## Reference computation

The expected values were computed outside the repository by two independent programs. Neither is committed; they are QA scratch work.

1. **Primary: Node 22.22.0 WebCrypto** (`globalThis.crypto.subtle`: HKDF `deriveBits`, HMAC `sign`, AES-GCM `encrypt` / `decrypt`, SHA-256 `digest`), with its own Crockford base32 and `String.prototype.normalize('NFC')`. It wrote the vector files and asserted its own invariants (HKDF prefix property, every round trip, every refusal, distinctness).
2. **Cross-check: Python 3.13** re-reading every file and recomputing every expected value with code that shares nothing with the first: stdlib `hashlib` / `hmac` for SHA-256 and a hand-written RFC 5869 HKDF, `base64.b32encode` remapped to the Crockford alphabet, `unicodedata` NFC, `json.dumps` for the payload, `cryptography` 50.0.1 `AESGCM` and `HKDF`; plus the **OpenSSL 3.0.13 CLI**: `openssl kdf … HKDF` for every `kid`, L2 and L1 key in K04, `openssl mac … HMAC` for every L1 value, and every E04 ciphertext and tag rebuilt from `aes-256-ecb` / `aes-256-ctr` with a hand-written GHASH. Result: 366 checks, 0 failures; a planted change in E04, K06 and P03 was caught.

## Changes

- 2026-10-30 — Created for S5f task K5 part 1 from ADR-0018 at `e3a2ad5` (QA lane, before any JD-M11 code).
