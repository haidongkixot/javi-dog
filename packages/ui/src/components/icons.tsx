// Stroke icons from the Concept 0.1 HTML template (24×24, 1.8 stroke). Decorative by default.
const paths = {
  overview:
    '<rect x="3" y="3" width="8" height="8" rx="2"/><rect x="14" y="3" width="7" height="5" rx="2"/><rect x="14" y="11" width="7" height="10" rx="2"/><rect x="3" y="14" width="8" height="7" rx="2"/>',
  projects:
    '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2h6.5A2.5 2.5 0 0 1 21 9.5v8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5Z"/><path d="M3 10h18"/>',
  agents:
    '<rect x="5" y="7" width="14" height="12" rx="3"/><path d="M12 3v4M9 12h.01M15 12h.01M9 16h6M3 11v4M21 11v4"/>',
  network:
    '<circle cx="8" cy="8" r="4"/><circle cx="16" cy="16" r="4"/><path d="m11 11 2 2M16 4v3M4 16h3"/>',
  shield:
    '<path d="M12 3 4.5 6v5.5c0 5 3.2 8.1 7.5 9.5 4.3-1.4 7.5-4.5 7.5-9.5V6Z"/><path d="m9 12 2 2 4-4"/>',
  bolt: '<path d="m13 2-9 12h7l-1 8 10-13h-7z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  coins:
    '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
  trend: '<path d="m3 17 6-6 4 3 8-9M15 5h6v6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  alert: '<path d="M12 3 2.8 20h18.4L12 3Z"/><path d="M12 9v4m0 3h.01"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  git: '<path d="M8 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm8 12a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM8 8v9a3 3 0 0 0 3 3h3M8 12a4 4 0 0 1 4-4h2"/>',
} as const;

export type IconName = keyof typeof paths;

export function Icon({ name, className = 'size-4' }: { name: IconName; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
      dangerouslySetInnerHTML={{ __html: paths[name] }}
    />
  );
}

/** The Signal Hound mark on its mint tile (logo concept 0.1, trademark clearance pending). */
export function BrandTile({ size = 40 }: { size?: number }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden className="flex-none">
      <rect width="64" height="64" rx="21" fill="var(--jd-brand-good-signal-mint)" />
      <g transform="translate(4 4) scale(.875)">
        <path
          d="M13 22 7 10Q6 6 12 8l13 8q7-3 14 0l13-8q6-2 5 4l-6 13q5 9 0 18-6 10-19 10T13 43q-5-9 0-21Z"
          fill="var(--jd-brand-pack-night)"
        />
        <ellipse cx="22" cy="32" rx="3.5" ry="4.5" fill="var(--jd-brand-good-signal-mint)" />
        <ellipse cx="42" cy="32" rx="3.5" ry="4.5" fill="var(--jd-brand-good-signal-mint)" />
        <path
          d="M27 41q5 4 10 0"
          fill="none"
          stroke="var(--jd-brand-good-signal-mint)"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
        <circle cx="32" cy="36" r="3" fill="var(--jd-brand-alert-coral)" />
      </g>
    </svg>
  );
}
