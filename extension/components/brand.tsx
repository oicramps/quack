import logo from '../assets/brand/quack-logo.svg?raw';
import logoOnDark from '../assets/brand/quack-logo-on-dark.svg?raw';
import duckSuccess from '../assets/brand/duck-success.svg?raw';
import duckError from '../assets/brand/duck-error.svg?raw';
import statusLoading from '../assets/brand/status-loading.svg?raw';
import statusSuccess from '../assets/brand/status-success.svg?raw';
import statusError from '../assets/brand/status-error.svg?raw';

// Brand artwork from assets/brand, inlined so it can follow the theme with CSS.
// The files are ours and contain no scripts.

function Art({ svg, width, height, className, hidden }: { svg: string; width: number; height: number; className: string; hidden?: boolean }) {
  return (
    <span
      className={`art ${className}`}
      style={{ width, height }}
      aria-hidden={hidden || undefined}
      dangerouslySetInnerHTML={{ __html: hidden ? svg.replace(/ role="img" aria-label="[^"]*"/, '') : svg }}
    />
  );
}

/** The mark; `size` is its height (3:2). Off the header it follows the panel theme. */
export function QuackLogo({ size = 16, onDark, hidden = true }: { size?: number; onDark?: boolean; hidden?: boolean }) {
  const props = { width: size * 1.5, height: size, hidden };
  if (onDark) return <Art svg={logoOnDark} className="quack-logo" {...props} />;
  return (
    <>
      <Art svg={logo} className="quack-logo on-light" {...props} />
      <Art svg={logoOnDark} className="quack-logo on-dark" {...props} />
    </>
  );
}

export const DuckSuccess = ({ width = 64 }: { width?: number }) => (
  <Art svg={duckSuccess} className="duck" width={width} height={(width * 3) / 4} />
);

export const DuckError = ({ width = 64 }: { width?: number }) => <Art svg={duckError} className="duck" width={width} height={(width * 3) / 4} />;

const STATUS = { loading: statusLoading, success: statusSuccess, error: statusError };

/** Always shown next to a text label, so it is hidden from screen readers. */
export function StatusIcon({ kind, size = 16 }: { kind: keyof typeof STATUS; size?: number }) {
  return <Art svg={STATUS[kind]} className={`status-icon ${kind}`} width={size} height={size} hidden />;
}
