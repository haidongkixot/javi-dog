// Privacy classes L1/L2 conformance runner (S5f K5, ADR-0018) for JD-M11 @javis-dog/crypto.
// Runs every case of docs/jgr/conformance/privacy/ (README: "Runner rules") against the
// public API only. Environment: Node 22 WebCrypto (`globalThis.crypto.subtle`), vitest `node`.
//
// What is NOT RUN here, and why (each also appears as a skipped `it` naming the reason):
// - E02 `pipe-class`: buildAad takes no class part; JD-M11 always writes the constant
//   AAD_CLASS "L2" (README reading Y5 allows the literal), so a class with "|" cannot be
//   passed in.
// - E06 AEAD-layer cases whose AAD decryptL2 can never build (another version or class, a
//   non-canonical event_id, an empty AAD): JD-M11 exposes no raw AES-GCM decryption.
// - P03 `threadText` and P04 project labels, `open` and `reload` steps: rendered text, browser
//   profiles and reloads belong to the web lane (JD-APP). This runner checks only the crypto
//   part of P03 (the decryption state) and of P04 `decrypt` steps (whether the decryption
//   counts as a check, reading Y8).
import { describe, expect, it } from 'vitest';
import {
  AAD_CLASS,
  buildAad,
  decodeL2Payload,
  decryptL2,
  encodeL2Payload,
  encodeRecoveryKey,
  encryptL2,
  hkdfInfo,
  HKDF_INFO_KID,
  HKDF_INFO_L1_PREFIX,
  HKDF_INFO_L2,
  L1_FIELDS,
  L2_ALG,
  L2_PAYLOAD_BYTES,
  l1Hash,
  parseRecoveryKey,
  type DecryptL2Result,
} from '../src/index.ts';
import {
  aeadPartsOf,
  base64UrlToHex,
  bytesToHex,
  contextOf,
  DECRYPT_REASON_MAP,
  deriveFromHex,
  deviceKeyMap,
  hexToBase64Url,
  hexToBytes,
  importAeadKey,
  LABEL_STATE_MAP,
  loaded,
  nodeAesGcmHex,
  nodeHmacHex,
  payloadInputOf,
  sha256Hex,
  UNCHECKED_PROJECT_LABEL,
  utf8Hex,
  vector,
  vectorFiles,
  type AadVector,
  type AesGcmVector,
  type DecryptCase,
  type DecryptVector,
  type DeriveVector,
  type L1HashVector,
  type LabelSequenceVector,
  type LabelVector,
  type PayloadVector,
  type RecoveryKeyFormatVector,
  type RecoveryKeyParseVector,
} from './conformance-vectors.ts';

/** Every case first requires its file to be valid against schema.json. */
const schemaValid = (v: { file: string; schemaErrors: string[] }) =>
  expect(v.schemaErrors, `${v.file} must be valid against schema.json`).toEqual([]);

/** A refusal carries no plaintext, not even a partial one. */
const expectRefusal = (result: DecryptL2Result, reason: string) => {
  expect(result.ok).toBe(false);
  expect(Object.keys(result).sort()).toEqual(['ok', 'reason']);
  expect(result).toEqual({ ok: false, reason });
};

describe('privacy conformance: inventory and schema.json', () => {
  it('holds the 17 vectors and 153 cases the README lists (K 61, E 64, P 28)', () => {
    expect(vectorFiles.map((f) => f.slice(0, 3))).toEqual([
      ...['E01', 'E02', 'E03', 'E04', 'E05', 'E06'],
      ...['K01', 'K02', 'K03', 'K04', 'K05', 'K06', 'K07'],
      ...['P01', 'P02', 'P03', 'P04'],
    ]);
    const counts = { K: 0, E: 0, P: 0 };
    for (const { file, data } of loaded.values()) {
      const d = data as { cases?: unknown[]; sequences?: { steps: unknown[] }[] };
      const n = d.cases?.length ?? d.sequences?.reduce((sum, s) => sum + s.steps.length, 0) ?? 0;
      counts[file[0] as 'K' | 'E' | 'P'] += n;
    }
    expect(counts).toEqual({ K: 61, E: 64, P: 28 });
  });

  for (const { file, data, schemaErrors } of loaded.values()) {
    it(`${file.slice(0, 3)} ${file} is valid against schema.json`, () => {
      expect(schemaErrors).toEqual([]);
      expect((data as { id: string }).id).toBe(file.slice(0, 3));
    });
  }
});

// ---------------------------------------------------------------------------------------
// K: recovery key, HKDF derivations, L1 hashes.

describe('K01 recovery-key-format (encodeRecoveryKey)', () => {
  const v = vector<RecoveryKeyFormatVector>('K01');
  for (const c of v.cases) {
    it(`K01 ${c.label}`, async () => {
      schemaValid(v);
      const key = await encodeRecoveryKey(hexToBytes(c.secretHex));
      expect(key).toBe(c.expect.recoveryKey);
      // JD-M11 exposes body and checksum only inside the display string.
      const compact = key.slice('JDK1-'.length).replaceAll('-', '');
      expect(compact.slice(0, 52)).toBe(c.expect.body);
      expect(compact.slice(52)).toBe(c.expect.checksum);
    });
  }
});

for (const id of ['K02', 'K03']) {
  describe(`${id} recovery-key-parse (parseRecoveryKey)`, () => {
    const v = vector<RecoveryKeyParseVector>(id);
    for (const c of v.cases) {
      it(`${id} ${c.label}`, async () => {
        schemaValid(v);
        const result = await parseRecoveryKey(c.input);
        if (c.expect.ok) {
          expect(result.ok).toBe(true);
          if (result.ok) expect(bytesToHex(result.secret)).toBe(c.expect.secretHex);
        } else {
          // `reason` is informative and not compared (README "Runner rules").
          expect(result.ok).toBe(false);
          expect('secret' in result).toBe(false);
        }
      });
    }
  });
}

describe('K04 derive (deriveProjectKeys; keys proven by their outputs)', () => {
  // JD-M11 imports every derived key as non-extractable and has no byte seam, so the runner
  // proves the key bytes by outputs (README "derive"): the L2 key by an AES-256-GCM
  // ciphertext equal to Node/OpenSSL's under l2KeyHex, each L1 key by an HMAC equal to
  // Node/OpenSSL's under l1KeyHex. The kid and the info strings are compared directly.
  const v = vector<DeriveVector>('K04');
  const probeIvHex = '000102030405060708090a0b';
  const probeContext = {
    eventId: '01JBZ4XQ80000000000000001A',
    slug: 'web-app',
    producerId: 'prod_conformance',
    threadRef: 'cc_privacy_t1',
    type: 'x.javi.thread.identity',
  };
  for (const c of v.cases) {
    it(`K04 ${c.label}`, async () => {
      schemaValid(v);
      const keys = await deriveFromHex(c.secretHex, c.slug);
      expect(keys.kid).toBe(c.expect.kid);

      expect(hkdfInfo(HKDF_INFO_KID, c.slug)).toBe(c.expect.info.kid);
      expect(hkdfInfo(HKDF_INFO_L2, c.slug)).toBe(c.expect.info.l2);
      for (const field of L1_FIELDS) {
        expect(hkdfInfo(`${HKDF_INFO_L1_PREFIX}${field}`, c.slug)).toBe(c.expect.info.l1[field]);
      }

      const sealed = await encryptL2(
        keys.l2Key,
        keys.kid,
        { ...probeContext, slug: c.slug },
        { repo: 'probe', branch: 'main' },
        { unsafeFixedIvForTests: hexToBytes(probeIvHex) },
      );
      const aad = buildAad({ ...probeContext, slug: c.slug, kid: keys.kid });
      const plaintext = encodeL2Payload({ repo: 'probe', branch: 'main' });
      expect(base64UrlToHex(sealed.ciphertext)).toBe(
        nodeAesGcmHex(c.expect.l2KeyHex, probeIvHex, aad, plaintext),
      );

      for (const field of L1_FIELDS) {
        const probe = `probe-${field}`;
        expect(await l1Hash(keys.l1Keys, field, probe)).toBe(
          `sha256:${nodeHmacHex(c.expect.l1KeyHex[field], probe)}`,
        );
      }
    });
  }
});

for (const id of ['K05', 'K06', 'K07']) {
  describe(`${id} l1-hash (deriveProjectKeys + l1Hash)`, () => {
    const v = vector<L1HashVector>(id);
    const plain = Object.values(v.plainSha256 ?? {});
    for (const c of v.cases) {
      it(`${id} ${c.label}`, async () => {
        schemaValid(v);
        // The value reaches JD-M11 exactly as parsed (NFD stays NFD).
        expect(utf8Hex(c.value)).toBe(c.valueUtf8Hex);
        const keys = await deriveFromHex(c.secretHex, c.slug);
        const hash = await l1Hash(keys.l1Keys, c.field, c.value);
        expect(hash).toBe(c.expect.hash);
        expect(plain).not.toContain(hash);
        if (id === 'K07') {
          // Separation: every value in K07 differs from every other case's value.
          const others = v.cases.filter((o) => o.label !== c.label).map((o) => o.expect.hash);
          expect(others).not.toContain(hash);
        }
      });
    }
  });
}

// ---------------------------------------------------------------------------------------
// E: AAD, payload padding, AES-256-GCM, decryption.

for (const id of ['E01', 'E02']) {
  describe(`${id} aad (buildAad)`, () => {
    const v = vector<AadVector>(id);
    for (const c of v.cases) {
      const parts = { ...contextOf(c.input), kid: c.input.kid };
      if (c.input.privacy_class !== AAD_CLASS && !c.expect.ok) {
        it.skip(`${id} ${c.label} — NOT RUN: buildAad has no class input; JD-M11 always writes the constant "${AAD_CLASS}" (reading Y5)`, () => {});
        continue;
      }
      it(`${id} ${c.label}`, () => {
        schemaValid(v);
        expect(c.input.privacy_class).toBe(AAD_CLASS);
        if (c.expect.ok) {
          const aad = buildAad(parts);
          expect(bytesToHex(aad)).toBe(c.expect.aadHex);
          expect(new TextDecoder().decode(aad)).toBe(c.expect.aadUtf8);
        } else {
          expect(() => buildAad(parts)).toThrow(TypeError);
        }
      });
    }
  });
}

for (const id of ['E03', 'P01', 'P02']) {
  describe(`${id} payload (encodeL2Payload)`, () => {
    const v = vector<PayloadVector>(id);
    for (const c of v.cases) {
      it(`${id} ${c.label}`, () => {
        schemaValid(v);
        const padded = encodeL2Payload(payloadInputOf(c.input));
        expect(padded.length).toBe(c.expect.paddedByteLength);
        expect(padded.length).toBe(L2_PAYLOAD_BYTES);
        expect(bytesToHex(padded)).toBe(c.expect.paddedHex);
        expect(sha256Hex(padded)).toBe(c.expect.paddedSha256Hex);
        // The unpadded JSON is not exposed by JD-M11: read it back from the padded bytes.
        const json = padded.subarray(0, c.expect.jsonByteLength);
        expect(new TextDecoder().decode(json)).toBe(c.expect.json);
        expect(padded.subarray(c.expect.jsonByteLength).every((b) => b === 0x20)).toBe(true);
        // Round trip: absent keys stay absent (not null, not "").
        expect(decodeL2Payload(padded)).toStrictEqual(c.expect.payload);
      });
    }
  });
}

describe('E04 aes-gcm (encryptL2 with the test-only fixed IV; decryptL2)', () => {
  const v = vector<AesGcmVector>('E04');
  for (const c of v.cases) {
    it(`E04 ${c.label}`, async () => {
      schemaValid(v);
      const { event, ciphertextAndTagHex, tagHex } = c.expect;
      const keys = await deriveFromHex(c.key.secretHex, c.key.slug);
      expect(keys.kid).toBe(event.encrypted.kid);
      expect(event.privacy_class).toBe(AAD_CLASS);
      const context = contextOf(event);
      expect(new TextDecoder().decode(buildAad({ ...context, kid: keys.kid }))).toBe(c.aadUtf8);

      // encryptL2 takes a payload object: the one whose padded bytes are exactly plaintextHex.
      const plaintext = hexToBytes(c.plaintextHex);
      const payload = decodeL2Payload(plaintext);
      expect(payload).not.toBeNull();
      if (payload === null) return;
      expect(bytesToHex(encodeL2Payload(payload))).toBe(c.plaintextHex);

      // Encrypt direction.
      const encrypted = await encryptL2(keys.l2Key, keys.kid, context, payload, {
        unsafeFixedIvForTests: hexToBytes(c.ivHex),
      });
      expect(encrypted).toStrictEqual(event.encrypted);
      expect(base64UrlToHex(encrypted.ciphertext)).toBe(ciphertextAndTagHex);
      expect(ciphertextAndTagHex.slice(-32)).toBe(tagHex);
      expect(encrypted.iv).toBe(hexToBase64Url(c.ivHex));

      // Decrypt direction.
      const result = await decryptL2(new Map([[keys.kid, keys.l2Key]]), event.encrypted, context);
      expect(result).toStrictEqual({ ok: true, payload });
    });
  }
});

const runDecryptCase = (
  id: string,
  c: DecryptCase,
  v: { file: string; schemaErrors: string[] },
) => {
  if (c.layer === 'aead') {
    const aead = c.aead;
    if (aead === null) throw new Error(`${id} ${c.label}: aead layer without aead data`);
    const parts = aeadPartsOf(aead.aadUtf8);
    if (!parts.ok) {
      it.skip(`${id} ${c.label} — NOT RUN: ${parts.why}; JD-M11 exposes no raw AES-GCM`, () => {});
      return;
    }
    it(`${id} ${c.label} (aead layer through decryptL2)`, async () => {
      schemaValid(v);
      // decryptL2 must feed AES-GCM exactly the vector's AAD bytes.
      const aad = buildAad({ ...parts.context, kid: parts.kid });
      expect(new TextDecoder().decode(aad)).toBe(aead.aadUtf8);
      const key = await importAeadKey(aead.l2KeyHex);
      const encrypted = {
        alg: L2_ALG,
        kid: parts.kid,
        iv: hexToBase64Url(aead.ivHex),
        ciphertext: hexToBase64Url(aead.ciphertextAndTagHex),
      };
      const result = await decryptL2(new Map([[parts.kid, key]]), encrypted, parts.context);
      if (c.expect.ok) {
        expect(result).toStrictEqual({ ok: true, payload: c.expect.payload });
      } else {
        const reason = c.expect.reason === null ? undefined : DECRYPT_REASON_MAP[c.expect.reason];
        expect(reason).toBeDefined();
        expectRefusal(result, reason ?? '');
      }
    });
    return;
  }

  it(`${id} ${c.label}`, async () => {
    schemaValid(v);
    const event = c.event;
    if (event === null) throw new Error(`${id} ${c.label}: envelope layer without event`);
    const context = contextOf(event);
    const keys = await deviceKeyMap(c.deviceKeys);
    const result = await decryptL2(keys, event.encrypted, context);
    if (c.expect.ok) {
      expect(result).toStrictEqual({ ok: true, payload: c.expect.payload });
      // decryptL2 does not return its AAD; buildAad is the function it uses.
      const aad = buildAad({ ...context, kid: event.encrypted.kid });
      expect(new TextDecoder().decode(aad)).toBe(c.expect.aadUtf8);
    } else {
      const reason = c.expect.reason === null ? undefined : DECRYPT_REASON_MAP[c.expect.reason];
      expect(reason).toBeDefined();
      expectRefusal(result, reason ?? '');
    }
  });
};

for (const id of ['E05', 'E06']) {
  describe(`${id} decrypt (decryptL2)`, () => {
    const v = vector<DecryptVector>(id);
    for (const c of v.cases) runDecryptCase(id, c, v);
  });
}

// ---------------------------------------------------------------------------------------
// P03, P04: only the crypto part; the rendered labels belong to the web lane.

describe('P03 label — decryption state only (threadText: NOT RUN here, web lane)', () => {
  const v = vector<LabelVector>('P03');
  for (const c of v.cases) {
    it(`P03 ${c.label} — decrypt state "${c.expect.state}" (threadText NOT RUN: web lane)`, async () => {
      schemaValid(v);
      const keys = await deviceKeyMap(c.deviceKeys);
      const result = await decryptL2(keys, c.event.encrypted, contextOf(c.event));
      const expected = LABEL_STATE_MAP[c.expect.state];
      if (expected === 'ok') {
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        // A name payload (never the canary) carries what the row shows.
        expect('canary' in result.payload).toBe(false);
      } else {
        expectRefusal(result, expected);
      }
    });
  }
});

describe('P04 label-sequence — decrypt steps only (labels, open, reload: NOT RUN here, web lane)', () => {
  const v = vector<LabelSequenceVector>('P04');
  for (const sequence of v.sequences) {
    let checkedBefore = false;
    sequence.steps.forEach((step, index) => {
      const name = `P04 ${sequence.label} step ${index + 1} ${step.action}`;
      const checkedAfter = step.expect.projectLabel !== UNCHECKED_PROJECT_LABEL;
      const wasChecked = checkedBefore;
      checkedBefore = checkedAfter;
      if (step.action !== 'decrypt' || step.event === null) {
        it.skip(`${name} — NOT RUN: project label, browser profile and reload are web lane`, () => {});
        return;
      }
      const event = step.event;
      it(`${name} — decryption counts as a check: ${checkedAfter && !wasChecked} (label NOT RUN: web lane)`, async () => {
        schemaValid(v);
        const keys = await deviceKeyMap(step.deviceKeys);
        const result = await decryptL2(keys, event.encrypted, contextOf(event));
        // Reading Y8: a check is a successful decryption of an event of this project and kid.
        const counts =
          result.ok &&
          event.project_slug === v.project.slug &&
          event.encrypted.kid === v.project.kid;
        if (!wasChecked) expect(counts).toBe(checkedAfter);
        if (!result.ok) expect(Object.keys(result).sort()).toEqual(['ok', 'reason']);
      });
    });
  }
});
