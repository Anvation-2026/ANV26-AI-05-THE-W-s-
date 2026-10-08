import type { ReactNode } from 'react';

/**
 * Custom icon set. 24px grid, 1.75px stroke, square caps, miter joins.
 * Drawn for this product. No stock icon pack.
 */
const P = (d: string) => <path d={d} />;

const ICONS = {
  play: P('M7 4 L19 12 L7 20 Z'),
  pause: P('M6 4h4v16H6z M14 4h4v16h-4z'),
  restart: P('M4 4v5h5 M5.5 9A8 8 0 1 1 4 12'),
  step: P('M6 4 L16 12 L6 20 Z M19 4 V20'),
  upload: P('M12 16 V4 M6 10 L12 4 L18 10 M4 20 H20'),
  download: P('M12 4 V16 M6 10 L12 16 L18 10 M4 20 H20'),
  drawLine: P('M5 19 L19 5 M3 17h4v4H3z M17 3h4v4h-4z'),
  drawZone: P('M5 6 L19 4 L20 18 L6 20 Z'),
  calibrate: (
    <>
      <path d="M12 2 V8 M12 16 V22 M2 12 H8 M16 12 H22" />
      <rect x="9" y="9" width="6" height="6" />
    </>
  ),
  camera: (
    <>
      <path d="M3 7 H8 L10 4 H14 L16 7 H21 V19 H3 Z" />
      <circle cx="12" cy="13" r="3.5" />
    </>
  ),
  video: P('M2 5h14v14H2z M16 10 L22 7 V17 L16 14'),
  vehicle: P('M7 3h10v18H7z M7 8h10 M7 16h10'),
  bus: P('M6 2h12v20H6z M6 7h12 M6 17h12'),
  twoWheeler: P('M10 3h4v18h-4z M8 8h8'),
  signal: (
    <>
      <rect x="8" y="2" width="8" height="20" />
      <circle cx="12" cy="7" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="12" cy="17" r="1.8" />
    </>
  ),
  people: (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 20v-2a6 6 0 0 1 12 0v2" />
      <circle cx="17.5" cy="9" r="2.5" />
      <path d="M17 14.5a4 4 0 0 1 4 3.5V20" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7 V12 L16 14" />
    </>
  ),
  queue: P('M4 5h16v4H4z M4 11h12v4H4z M4 17h8v3H4z'),
  balance: P('M12 3 V21 M5 7 H19 M5 7 L2 14 H8 Z M19 7 L16 14 H22 Z M8 21 H16'),
  siren: P('M7 20 V13 a5 5 0 0 1 10 0 V20 M4 20 H20 M12 3 V5 M4 7 L6 8.5 M20 7 L18 8.5'),
  settings: P('M4 7 H20 M4 17 H20 M9 4 V10 M15 14 V20'),
  report: P('M6 2h9l4 4v16H6z M9 12h7 M9 16h7 M9 8h3'),
  flask: P('M9 2h6 M10 2v7L4 20h16L14 9V2 M7.5 15h9'),
  book: P('M4 4h7a1 1 0 0 1 1 1v15a1 1 0 0 0-1-1H4z M20 4h-7a1 1 0 0 0-1 1v15a1 1 0 0 1 1-1h7z'),
  theme: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" />
    </>
  ),
  keyboard: P('M2 6h20v12H2z M6 10h2 M10 10h2 M14 10h2 M18 10h0 M7 14h10'),
  close: P('M5 5 L19 19 M19 5 L5 19'),
  warning: P('M12 3 L22 20 H2 Z M12 9 V14 M12 17 V17.5'),
  chart: P('M3 3V21H21 M7 16 L11 11 L14 14 L20 6'),
  junction: P('M9 2v7H2 M15 2v7h7 M2 15h7v7 M22 15h-7v7'),
  check: P('M4 12 L10 18 L20 6'),
  menu: P('M3 6H21 M3 12H21 M3 18H21'),
  search: (
    <>
      <circle cx="10" cy="10" r="6" />
      <path d="M15 15 L21 21" />
    </>
  ),
  trash: P('M4 7H20 M9 7V3H15V7 M6 7L7 21H17L18 7'),
  copy: P('M8 8h12v12H8z M16 8V4H4v12h4'),
  plus: P('M12 5V19 M5 12H19'),
  minus: P('M5 12H19'),
  undo: P('M9 4 L4 9 L9 14 M4 9H15a5 5 0 0 1 0 10H10'),
  redo: P('M15 4 L20 9 L15 14 M20 9H9a5 5 0 0 0 0 10H14'),
  cursor: P('M5 3 L19 12 L12 13 L9 20 Z'),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11V17 M12 7V7.5" />
    </>
  ),
  chevron: P('M9 5 L16 12 L9 19'),
  stopwatch: (
    <>
      <circle cx="12" cy="13" r="8" />
      <path d="M12 9V13L15 15 M9 2h6" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={`icon ${className ?? ''}`}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      width={size}
      height={size}
    >
      {ICONS[name]}
    </svg>
  );
}

export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" fill="var(--sign)" />
      <rect x="13" y="3" width="6" height="10" fill="var(--sign-ink)" />
      <rect x="13" y="19" width="6" height="10" fill="var(--sign-ink)" />
      <rect x="3" y="13" width="10" height="6" fill="var(--sign-ink)" />
      <rect x="19" y="13" width="10" height="6" fill="var(--sign-ink)" />
    </svg>
  );
}
