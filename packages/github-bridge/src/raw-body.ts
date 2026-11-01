// Reads a webhook body as raw bytes with a hard byte limit (ADR-0019 §3.2, D0 L1). The HMAC
// covers the exact bytes GitHub sent, so nothing is decoded here: no UTF-8 decoding (which would
// drop a BOM or fail before the signature is known) and no decompression (`Content-Encoding`
// other than identity is refused before this runs). JD-M05 `readBoundedBody` returns decoded
// text and therefore cannot be used for a signature check.

/** GitHub webhook bodies above this are refused with 413 (1 MiB, ADR-0019 §3.2). */
export const WEBHOOK_MAX_BODY_BYTES = 1_048_576;

export type RawBodyResult =
  | { ok: true; bytes: Uint8Array }
  /** `too_large`: more than `maxBytes`; `unreadable`: the stream failed (an aborted upload). */
  | { ok: false; reason: 'too_large' | 'unreadable' };

/**
 * Reads at most `maxBytes` of the request body and stops (cancelling the stream) as soon as one
 * more byte arrives. A declared `Content-Length` above the limit is refused without reading. A
 * request without a body yields zero bytes.
 */
export const readRawBody = async (request: Request, maxBytes: number): Promise<RawBodyResult> => {
  const declared = request.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared.trim()) > maxBytes) {
    await request.body?.cancel().catch(() => {});
    return { ok: false, reason: 'too_large' };
  }
  if (!request.body) return { ok: true, bytes: new Uint8Array(0) };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, reason: 'too_large' };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: 'unreadable' };
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
};
