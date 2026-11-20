// Quacksteps's only UI inside GitHub's page: a floating "Ask Quacksteps" button above the
// selected diff lines. It lives in a shadow root so GitHub's styles don't reach it.
import logo from '../assets/brand/quacksteps-logo-on-dark.svg?raw';

const SHORTCUT = /Mac/.test(navigator.platform) ? '⌘⇧K' : 'Ctrl+Shift+K';

// Everything here is built with DOM calls, never innerHTML, so no markup string
// reaches GitHub's page (AMO's linter flags innerHTML in content scripts).

/** The logo on its ink circle. Parsed as SVG, so it can't carry HTML. */
function badge(): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = 'badge';
  const svg = new DOMParser().parseFromString(logo, 'image/svg+xml').documentElement;
  svg.removeAttribute('role');
  svg.removeAttribute('aria-label');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('width', '15');
  svg.setAttribute('height', '10');
  span.append(document.importNode(svg, true));
  return span;
}

function styleTag(css: string): HTMLStyleElement {
  const style = document.createElement('style');
  style.textContent = css;
  return style;
}

function textTag<K extends keyof HTMLElementTagNameMap>(tag: K, text: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.textContent = text;
  return el;
}

// The logo sits on an ink circle because the footprint would vanish into a yellow fill. Same in light and dark.
const STYLE = `
  :host { all: initial; }
  button {
    display: flex; align-items: center; gap: 8px; box-sizing: border-box;
    height: 30px; margin: 0; padding: 0 6px 0 4px; border: 1px solid #d4a72c; border-radius: 6px;
    font: 700 12px/20px -apple-system, system-ui, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif;
    color: #1c222e; background: #f2c94c; cursor: pointer; white-space: nowrap;
    box-shadow: 0 4px 8px rgb(0 0 0 / 20%);
  }
  button:hover { filter: brightness(1.04); }
  button:focus-visible { outline: none; box-shadow: 0 4px 8px rgb(0 0 0 / 20%), 0 0 0 2px #0099e5; }
  .badge {
    display: flex; align-items: center; justify-content: center; flex: none;
    width: 24px; height: 24px; border-radius: 999px; background: #1c222e;
  }
  .badge svg { display: block; }
  kbd {
    display: block; height: 18px; padding: 0 5px; border: 0; border-radius: 4px;
    font: 700 11px/18px -apple-system, system-ui, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif;
    color: inherit; background: rgb(28 34 46 / 12%);
  }
`;

export interface FloatingButton {
  /** Just above `top`, with its right edge at `right` (viewport coordinates). */
  showAbove(top: number, right: number, lines?: string): void;
  hide(): void;
  remove(): void;
}

const MARGIN = 8;

export function createFloatingButton(onAsk: () => void): FloatingButton {
  const host = document.createElement('quack-ask');
  const root = host.attachShadow({ mode: 'closed' });
  const button = document.createElement('button');
  button.type = 'button';
  button.title = `Ask Quacksteps about the selected lines (${SHORTCUT})`;
  button.append(badge(), textTag('span', 'Ask Quacksteps'), textTag('kbd', SHORTCUT));
  root.append(styleTag(STYLE), button);
  // Keep the diff's text selection when the button is pressed.
  host.addEventListener('mousedown', (e) => e.preventDefault());
  button.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    onAsk();
  });
  host.style.cssText = 'position: fixed; top: 0; left: 0; z-index: 2147483646; display: none;';
  // documentElement rather than body: GitHub swaps <body> when it navigates.
  document.documentElement.append(host);

  return {
    showAbove(top, right, lines) {
      button.title = lines ? `Ask Quacksteps about ${lines} (${SHORTCUT})` : `Ask Quacksteps (${SHORTCUT})`;
      host.style.display = 'block';
      const { width, height } = host.getBoundingClientRect();
      const y = top - height - 4;
      if (y + height < 0 || y > window.innerHeight) {
        host.style.display = 'none';
        return;
      }
      const x = Math.max(MARGIN, Math.min(right - width, window.innerWidth - width - MARGIN));
      host.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    },
    hide() {
      host.style.display = 'none';
    },
    remove() {
      host.remove();
    },
  };
}

const HINT_STYLE = `
  :host { all: initial; }
  div {
    display: flex; align-items: center; gap: 10px; box-sizing: border-box; max-width: 360px;
    padding: 10px 12px 10px 10px; border-radius: 8px;
    font: 13px/18px -apple-system, system-ui, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif;
    color: #f3f5f7; background: #1c222e; box-shadow: 0 8px 24px rgb(0 0 0 / 30%);
  }
  .badge {
    display: flex; align-items: center; justify-content: center; flex: none;
    width: 28px; height: 28px; border-radius: 999px; background: #2b3242;
  }
  .badge svg { display: block; }
  kbd {
    padding: 0 5px; border-radius: 4px; font: 700 11px/18px -apple-system, system-ui, sans-serif;
    color: #1c222e; background: #f2c94c;
  }
`;

let hintTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Shown when the browser would not open the panel from the page (Firefox only
 * opens its sidebar from the toolbar button or a keyboard shortcut). The
 * selection is already attached, so opening the panel picks it up.
 */
export function showOpenHint(): void {
  let host = document.querySelector('quack-hint');
  if (!host) {
    host = document.createElement('quack-hint');
    const root = host.attachShadow({ mode: 'open' });
    const message = document.createElement('span');
    message.append('Lines attached. Open Quacksteps from the toolbar or press ', textTag('kbd', SHORTCUT), '.');
    const box = document.createElement('div');
    box.setAttribute('role', 'status');
    box.append(badge(), message);
    root.append(styleTag(HINT_STYLE), box);
    (host as HTMLElement).style.cssText = 'position: fixed; right: 16px; bottom: 16px; z-index: 2147483646;';
    document.documentElement.append(host);
  }
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => host?.remove(), 6000);
}
