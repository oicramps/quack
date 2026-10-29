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
export const Plus = (p: P) => (
  <Icon {...p}>
    <path d="M8 3.5v9M3.5 8h9" />
  </Icon>
);
