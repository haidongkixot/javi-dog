// Test clock for the Gemini conformance runner (gemini-conformance.test.ts), README "Pinned
// clock". The runner preloads this file into every `javi` process it starts, through
// NODE_OPTIONS=--import, so the hook entry keeps the exact argv from .gemini/settings.json. The
// processes those hooks spawn (detached `javi flush`) inherit NODE_OPTIONS and get the same clock.
//
// With JAVI_CONFORMANCE_CLOCK set to an ISO instant, `new Date()` and `Date.now()` return that
// instant for the whole process; every other use of Date (parsing, explicit values) is unchanged.
// Timers stay real. Without the variable this file does nothing.

const pinned = process.env.JAVI_CONFORMANCE_CLOCK;
const at = pinned ? Date.parse(pinned) : NaN;

if (Number.isFinite(at)) {
  const RealDate = Date;
  function PinnedDate(this: unknown, ...args: unknown[]): unknown {
    // Date() called as a function returns a string, like the real one.
    if (!new.target) return new RealDate(at).toString();
    return Reflect.construct(RealDate, args.length ? args : [at], new.target);
  }
  PinnedDate.prototype = RealDate.prototype;
  PinnedDate.now = () => at;
  PinnedDate.parse = RealDate.parse;
  PinnedDate.UTC = RealDate.UTC;
  globalThis.Date = PinnedDate as unknown as DateConstructor;
}

export {};
