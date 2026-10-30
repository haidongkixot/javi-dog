// Bundle-only replacement for crypto-loader.ts (scripts/build.mjs): JD-M11 imported statically.
import * as crypto from '@javis-dog/crypto';

export const loadCrypto = async () => crypto;
