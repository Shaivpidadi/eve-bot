const PATHS = {
  plus: <path d="M12 5v14M5 12h14" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4-4" />
    </>
  ),
  plug: <path d="M9 3v5M15 3v5M6.5 8h11v3.5a5.5 5.5 0 0 1-11 0ZM12 17v4" />,
  monitor: (
    <>
      <rect x="3" y="4.5" width="18" height="12" rx="2" />
      <path d="M8.5 20h7M12 16.5V20" />
    </>
  ),
  left: <path d="m14.5 18-6-6 6-6" />,
  gear: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.8v2.4M12 18.8v2.4M4.2 4.2l1.7 1.7M18.1 18.1l1.7 1.7M2.8 12h2.4M18.8 12h2.4M4.2 19.8l1.7-1.7M18.1 5.9l1.7-1.7" />
    </>
  ),
  x: <path d="M17.5 6.5 6.5 17.5M6.5 6.5l11 11" />,
  mic: (
    <>
      <rect x="9" y="3" width="6" height="11.5" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
    </>
  ),
  up: <path d="M12 19V5.5M6 11.5l6-6 6 6" />,
  stop: <rect x="7.5" y="7.5" width="9" height="9" rx="1.5" fill="currentColor" stroke="none" />,
  check: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8.5 12.2 2.4 2.4 4.6-4.9" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  file: (
    <>
      <path d="M14 3H7.5A2.5 2.5 0 0 0 5 5.5v13A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V8Z" />
      <path d="M14 3v5h5" />
    </>
  ),
  chev: <path d="m6.5 9.5 5.5 5.5 5.5-5.5" />,
  alert: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.8v5M12 16.2h.01" />
    </>
  ),
  person: (
    <>
      <circle cx="12" cy="8.5" r="3.8" />
      <path d="M4.8 20.5a7.2 7.2 0 0 1 14.4 0" />
    </>
  ),
  dot: <circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none" />,
  folder: <path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h3.8l2 2.2h7.2a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z" />,
  globe: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.4 2.5 3.6 5.3 3.6 8.5s-1.2 6-3.6 8.5c-2.4-2.5-3.6-5.3-3.6-8.5s1.2-6 3.6-8.5Z" />
    </>
  ),
  terminal: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <path d="m7.5 9.5 3 2.5-3 2.5M12.5 15h4" />
    </>
  ),
  mail: (
    <>
      <rect x="3" y="5.5" width="18" height="13" rx="2" />
      <path d="m3.5 7 8.5 6 8.5-6" />
    </>
  ),
  brain: (
    <path d="M9 4.5a3 3 0 0 0-3 3v.3A3.2 3.2 0 0 0 4 13a3 3 0 0 0 2 4.2V17a3 3 0 0 0 6 .5V6.8A2.5 2.5 0 0 0 9 4.5ZM15 4.5a3 3 0 0 1 3 3v.3a3.2 3.2 0 0 1 2 5.2 3 3 0 0 1-2 4.2V17a3 3 0 0 1-6 .5" />
  ),
  signout: <path d="M9.5 20.5h-4a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2h4M15.5 16.5l4.5-4.5-4.5-4.5M20 12H9.5" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="3.8" />
      <path d="M12 2.8v2M12 19.2v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2.8 12h2M19.2 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" />
    </>
  ),
  moon: <path d="M19.5 14.6A7.8 7.8 0 0 1 9.4 4.5a7.8 7.8 0 1 0 10.1 10.1Z" />,
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={className === undefined ? "i" : `i ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}
