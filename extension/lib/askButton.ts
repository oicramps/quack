// Quack's only UI inside GitHub's page: a floating "Ask AI" button above the
// selected diff lines. It lives in a shadow root so GitHub's styles don't reach it.

const SHORTCUT = /Mac/.test(navigator.platform) ? '⌘⇧K' : 'Ctrl+Shift+K';

const ICON =
  '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/></svg>';

// Colors from the panel design: the single blue accent, white text.
const STYLE = `
  :host { all: initial; }
  button {
    display: inline-flex; align-items: center; gap: 6px; box-sizing: border-box;
    height: 28px; padding: 0 6px 0 10px; border: 0; border-radius: 6px;
    font: 600 12px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif;
    color: #ffffff; background: #0074ad; cursor: pointer; white-space: nowrap;
    box-shadow: 0 1px 2px rgb(0 41 61 / 20%), 0 4px 12px rgb(0 41 61 / 18%);
  }
  button:hover { filter: brightness(1.08); }
  button:focus-visible { outline: 2px solid #0099e5; outline-offset: 2px; }
  kbd {
    font: inherit; font-weight: 600; font-size: 11px; line-height: 16px; padding: 0 4px;
    border-radius: 4px; background: rgb(255 255 255 / 18%);
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
  root.innerHTML = `<style>${STYLE}</style><button type="button" title="Ask Quack about the selected lines (${SHORTCUT})">${ICON}<span>Ask AI</span><kbd>${SHORTCUT}</kbd></button>`;
  const label = root.querySelector('span')!;
  // Keep the diff's text selection when the button is pressed.
  host.addEventListener('mousedown', (e) => e.preventDefault());
  root.querySelector('button')!.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    onAsk();
  });
  host.style.cssText = 'position: fixed; top: 0; left: 0; z-index: 2147483646; display: none;';
  // documentElement rather than body: GitHub swaps <body> when it navigates.
  document.documentElement.append(host);

  return {
    showAbove(top, right, lines) {
      label.textContent = lines ? `Ask AI about ${lines}` : 'Ask AI';
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
