// Reads a request body with a hard byte limit applied AFTER decompression (ADR-0008),
// so a small gzip that inflates past the limit is cut off instead of fully inflated.

export type BodyResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'empty' | 'too_large' | 'bad_encoding' | 'unsupported_encoding' };

export const readBoundedBody = async (request: Request, maxBytes: number): Promise<BodyResult> => {
  const encoding = (request.headers.get('content-encoding') ?? 'identity').trim().toLowerCase();
  if (encoding !== 'identity' && encoding !== 'gzip') {
    return { ok: false, reason: 'unsupported_encoding' };
  }
  if (!request.body) return { ok: false, reason: 'empty' };

  const stream =
    encoding === 'gzip'
      ? request.body.pipeThrough(
          new DecompressionStream('gzip') as TransformStream<Uint8Array, Uint8Array>,
        )
      : request.body;
  const reader = stream.getReader();
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
    // Corrupt gzip or an aborted upload.
    return { ok: false, reason: 'bad_encoding' };
  }
  if (total === 0) return { ok: false, reason: 'empty' };

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    return { ok: false, reason: 'bad_encoding' };
  }
};
