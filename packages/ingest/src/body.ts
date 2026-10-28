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

/**
 * Deepest container nesting a JGR batch body may use. A valid batch needs about 4
 * (`{"events":[{"usage_delta":{…}}]}`); 32 leaves room without letting a producer send ~120 000
 * levels inside the 256 KB limit, which parses but overflows the stack of anything that walks
 * it afterwards (S5a review L3).
 */
export const MAX_JSON_DEPTH = 32;

/**
 * True when JSON text nests arrays/objects deeper than `maxDepth`. One linear pass over the
 * text before `JSON.parse`; brackets inside strings (including escaped quotes) are ignored.
 * Invalid JSON is left for `JSON.parse` to refuse.
 */
export const exceedsJsonDepth = (text: string, maxDepth: number = MAX_JSON_DEPTH): boolean => {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      // A backslash skips the escaped character; an unescaped quote ends the string.
      if (c === 0x5c) i++;
      else if (c === 0x22) inString = false;
    } else if (c === 0x22) {
      inString = true;
    } else if (c === 0x5b || c === 0x7b) {
      if (++depth > maxDepth) return true;
    } else if (c === 0x5d || c === 0x7d) {
      depth--;
    }
  }
  return false;
};
