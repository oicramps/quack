// Quack's only UI inside GitHub's page: a floating "Ask AI" button above the
// selected diff lines. It lives in a shadow root so GitHub's styles don't reach
// it; GitHub's color variables still do.

const SHORTCUT = /Mac/.test(navigator.platform) ? '⌘⇧K' : 'Ctrl+Shift+K';

const ICON =
  '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/></svg>';

const BASE_STYLE = `
  :host { all: initial; }
  button {
    display: inline-flex; align-items: center; gap: 6px; box-sizing: border-box;
    font: 600 12px/1 var(--fontStack-sansSerif, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif);
    border-radius: 6px; cursor: pointer; white-space: nowrap;
  }
  button:focus-visible { outline: 2px solid var(--focus-outlineColor, #0969da); outline-offset: 2px; }
`;

const FLOATING_STYLE = `${BASE_STYLE}
  button {
    height: 28px; padding: 0 6px 0 8px;
    border: 0; color: var(--fgColor-onEmphasis, #ffffff);
    background: var(--bgColor-accent-emphasis, #0969da);
    box-shadow: var(--shadow-floating-small, 0 1px 3px rgb(0 0 0 / 20%));
  }
  button:hover { filter: brightness(1.08); }
  kbd {
    font: inherit; font-weight: 500; font-size: 11px; line-height: 16px; padding: 0 4px;
    border: 1px solid rgb(255 255 255 / 40%); border-radius: 4px;
  }
`;

function shadowButton(tag: string, style: string, html: string, title: string, onClick: () => void): HTMLElement {
  const host = document.createElement(tag);
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>${style}</style><button type="button" title="${title}">${html}</button>`;
  // Keep the diff's text selection when the button is pressed.
  host.addEventListener('mousedown', (e) => e.preventDefault());
  root.querySelector('button')!.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
  });
  return host;
}

export interface FloatingButton {
  /** Just above `top`, with its right edge at `right` (viewport coordinates). */
  showAbove(top: number, right: number): void;
  hide(): void;
  remove(): void;
}

const MARGIN = 8;

export function createFloatingButton(onAsk: () => void): FloatingButton {
  const host = shadowButton(
    'quack-ask',
    FLOATING_STYLE,
    `${ICON}<span>Ask AI</span><kbd>${SHORTCUT}</kbd>`,
    `Ask Quack about the selected lines (${SHORTCUT})`,
    onAsk,
  );
  host.style.cssText = 'position: fixed; top: 0; left: 0; z-index: 2147483646; display: none;';
  // documentElement rather than body: GitHub swaps <body> when it navigates.
  document.documentElement.append(host);

  return {
    showAbove(top, right) {
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