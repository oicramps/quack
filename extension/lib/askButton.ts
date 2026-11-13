// Quack's only UI inside GitHub's page: a floating "Ask Quack" button above the
// selected diff lines. It lives in a shadow root so GitHub's styles don't reach it.
import logo from '../assets/brand/quack-logo-on-dark.svg?raw';

const SHORTCUT = /Mac/.test(navigator.platform) ? '⌘⇧K' : 'Ctrl+Shift+K';

const ICON = `<span class="badge">${logo.replace(/\s(role|aria-label)="[^"]*"/g, '').replace('<svg', '<svg aria-hidden="true" width="15" height="10"')}</span>`;

// The logo sits on an ink circle because the duck would vanish into a yellow fill. Same in light and dark.
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
  root.innerHTML = `<style>${STYLE}</style><button type="button" title="Ask Quack about the selected lines (${SHORTCUT})">${ICON}<span>Ask Quack</span><kbd>${SHORTCUT}</kbd></button>`;
  const button = root.querySelector('button')!;
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
      button.title = lines ? `Ask Quack about ${lines} (${SHORTCUT})` : `Ask Quack (${SHORTCUT})`;
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
