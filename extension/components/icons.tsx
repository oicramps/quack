import type { ReactNode } from 'react';

// 16px line icons matching the design files: 1.5px strokes, round caps.
function Icon({ size = 16, children, className }: { size?: number; children: ReactNode; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {children}
    </svg>
  );
}

type P = { size?: number; className?: string };

export const ChevronDown = (p: P) => (
  <Icon {...p}>
    <path d="M4.5 6.5L8 10l3.5-3.5" />
  </Icon>
);
export const ChevronRight = (p: P) => (
  <Icon {...p}>
    <path d="M6.5 4.5L10 8l-3.5 3.5" />
  </Icon>
);
export const Check = (p: P) => (
  <Icon {...p}>
    <path d="M3.5 8.5l3 3 6-7" />
  </Icon>
);
export const Circle = (p: P) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="5.25" />
  </Icon>
);
export const Spinner = ({ size = 16, className = '' }: P) => (
  <Icon size={size} className={`spinner ${className}`}>
    <path d="M8 2.75A5.25 5.25 0 1 1 2.75 8" />
  </Icon>
);
export const Search = (p: P) => (
  <Icon {...p}>
    <circle cx="7" cy="7" r="4.25" />
    <path d="M10.25 10.25L13.5 13.5" />
  </Icon>
);
export const FileIcon = (p: P) => (
  <Icon {...p}>
    <path d="M4 1.75h5l3 3v9.5H4z" />
    <path d="M9 1.75v3h3" />
  </Icon>
);
export const Terminal = (p: P) => (
  <Icon {...p}>
    <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" />
    <path d="M4.5 6.5L6.5 8l-2 1.5M8 10h3" />
  </Icon>
);
export const CopyIcon = (p: P) => (
  <Icon {...p}>
    <rect x="5.25" y="5.25" width="8" height="8" rx="1.5" />
    <path d="M10.75 5.25V3.5a.75.75 0 0 0-.75-.75H3.5a.75.75 0 0 0-.75.75V10c0 .41.34.75.75.75h1.75" />
  </Icon>
);
export const Retry = (p: P) => (
  <Icon {...p}>
    <path d="M13 8a5 5 0 1 1-1.46-3.54" />
    <path d="M13 2.75v2.5h-2.5" />
  </Icon>
);
export const ArrowUp = (p: P) => (
  <Icon {...p}>
    <path d="M8 13V3.5M4 7.5l4-4 4 4" />
  </Icon>
);
export const StopSquare = ({ size = 10 }: P) => (
  <svg aria-hidden="true" width={size} height={size} viewBox="0 0 10 10">
    <rect width="10" height="10" rx="1.5" fill="currentColor" />
  </svg>
);
export const Warning = (p: P) => (
  <Icon {...p}>
    <path d="M8 2l6.5 11.5h-13z" />
    <path d="M8 6.5v3M8 11.5v.5" />
  </Icon>
);
export const ErrorCircle = (p: P) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="6.25" />
    <path d="M8 4.75v3.75M8 10.75v.5" />
  </Icon>
);
export const Close = (p: P) => (
  <Icon {...p}>
    <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
  </Icon>
);
export const CollapsePanel = (p: P) => (
  <Icon {...p}>
    <rect x="2" y="2.5" width="12" height="11" rx="2" />
    <path d="M10 2.5v11M5.5 6.5L7 8l-1.5 1.5" />
  </Icon>
);
export const Summary = (p: P) => (
  <Icon {...p}>
    <path d="M3 3.5h10M3 7h10M3 10.5h6" />
  </Icon>
);
export const Lines = (p: P) => (
  <Icon {...p}>
    <path d="M2.5 4h11M2.5 8h7M2.5 12h9" />
  </Icon>
);
export const ExternalArrow = (p: P) => (
  <Icon {...p}>
    <path d="M6 3.5h6.5V10M12.5 3.5L4 12" />
  </Icon>
);

// The Quack logo: a yellow duck in braces. `size` is the height; the mark is 3:2.
export const QuackMark = ({ size = 16, className }: P) => (
  <svg role="img" aria-label="Quack" width={size * 1.5} height={size} viewBox="0 0 36 24" className={className}>
    <path
      d="M7 3C4.6 3 4.4 4.8 4.4 7V9.6C4.4 11 3.6 12 2 12C3.6 12 4.4 13 4.4 14.4V17C4.4 19.2 4.6 21 7 21M29 3C31.4 3 31.6 4.8 31.6 7V9.6C31.6 11 32.4 12 34 12C32.4 12 31.6 13 31.6 14.4V17C31.6 19.2 31.4 21 29 21"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path d="M12.4 7.4C10.9 7.2 9.3 7.8 8.6 9.1C9.4 10.4 11.3 10.9 12.9 10.6Z" fill="#ff980f" />
    <path
      d="M10.8 13.2C10.4 17.7 13.3 20.2 18.1 20.2C23.3 20.2 26.5 17.5 26.9 12.6C27 11.1 26.2 10.5 25.1 11.4C23.5 12.8 21.5 13.2 19.4 12.6C18.7 12.4 18.2 12.1 17.9 11.6L14 11.8C12.4 12 11.2 12.4 10.8 13.2Z"
      fill="#ffcc33"
    />
    <circle cx="15.6" cy="8.2" r="4.3" fill="#ffcc33" />
    <circle cx="16.7" cy="7.2" r="1" fill="#1c222e" />
    <path d="M17.2 15.4C19.2 17 22.1 16.8 23.6 14.7" fill="none" stroke="#e0a800" strokeWidth="1.1" strokeLinecap="round" />
  </svg>
);
export const Plus = (p: P) => (
  <Icon {...p}>
    <path d="M8 3.5v9M3.5 8h9" />
  </Icon>
);
