'use client';

import { useEffect, useState } from 'react';
import { absoluteTime } from '@/components/dashboard/format';

// Absolute UTC times for the usage blocks (product rule 2). The blocks are read once per visit,
// so a relative age ("2 min ago") would freeze and look current on a page left open. Instead the
// time is absolute, and the date is dropped only while it is the viewer's current UTC date —
// checked on the client clock and re-checked every minute, so it reappears after UTC midnight.
// The server render (and the hydrating first client render) always carries the date: neither
// can know the viewer's clock, and both must produce the same HTML.

/** How often the viewer's UTC date is re-checked. */
export const UTC_DATE_TICK_MS = 60_000;

const dateFmt = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'UTC' });
const timeFmt = (seconds: boolean) =>
  new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    ...(seconds && { second: '2-digit' }),
    hourCycle: 'h23',
    timeZone: 'UTC',
  });
const hm = timeFmt(false);
const hms = timeFmt(true);

const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * "10:15 UTC" when `iso` falls on `today` (a UTC date, YYYY-MM-DD), else "27 Oct 2026, 10:15 UTC";
 * with `seconds`, "10:15:03 UTC". `today === null` (clock unknown) always shows the date.
 */
export const utcStampText = (iso: string, today: string | null, seconds = false) => {
  const at = new Date(iso);
  const time = `${(seconds ? hms : hm).format(at)} UTC`;
  return utcDate(at.getTime()) === today ? time : `${dateFmt.format(at)}, ${time}`;
};

/** The viewer's current UTC date, or null until mounted (server render and hydration). */
function useUtcToday(): string | null {
  const [today, setToday] = useState<string | null>(null);
  useEffect(() => {
    const tick = () => setToday(utcDate(Date.now()));
    tick();
    const id = setInterval(tick, UTC_DATE_TICK_MS);
    return () => clearInterval(id);
  }, []);
  return today;
}

/** An absolute UTC time with the full time in the title; the date only when not today. */
export function UtcStamp({ at, seconds = false }: { at: string; seconds?: boolean }) {
  const today = useUtcToday();
  return (
    <time dateTime={at} title={absoluteTime(at)} className="tabular-nums">
      {utcStampText(at, today, seconds)}
    </time>
  );
}
