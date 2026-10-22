// ULIDs (https://github.com/ulid/spec): 48-bit ms timestamp + 80 random bits, Crockford
// base32. Monotonic within one generator: ids from the same millisecond increment the
// random part, so lexical order = creation order (the file spool relies on this).

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;

type RandomBytes = (n: number) => Uint8Array;
const cryptoBytes: RandomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

export const createUlid = (randomBytes: RandomBytes = cryptoBytes) => {
  let lastTime = -1;
  let lastRandom: number[] = [];

  return (now: number = Date.now()): string => {
    if (!Number.isInteger(now) || now < 0 || now > 2 ** 48 - 1) {
      throw new RangeError('ULID time must be a 48-bit millisecond timestamp.');
    }
    let random: number[];
    if (now <= lastTime) {
      // Same (or earlier) millisecond: keep the previous time and increment the randomness.
      now = lastTime;
      random = [...lastRandom];
      let i = RANDOM_CHARS - 1;
      while (i >= 0 && random[i] === 31) random[i--] = 0;
      if (i < 0) throw new RangeError('ULID random part overflowed within one millisecond.');
      random[i]! += 1;
    } else {
      random = [...randomBytes(RANDOM_CHARS)].map((b) => b & 31);
    }
    lastTime = now;
    lastRandom = random;

    let time = '';
    for (let i = 0, t = now; i < TIME_CHARS; i++, t = Math.floor(t / 32)) {
      time = ALPHABET[t % 32] + time;
    }
    return time + random.map((d) => ALPHABET[d]).join('');
  };
};
