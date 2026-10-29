import type { CodeSelection, PrRef } from '@quack/shared';

/** Page-level state shared between the content script and the React panel. */
export interface PageState {
  pr: PrRef | null;
  open: boolean;
  lastSelection: CodeSelection | null;
  /** Increments each time the shortcut asks the panel to attach the current selection. */
  attachRequest: { seq: number; selection: CodeSelection | null };
}

type Listener = () => void;

export function createPageStore(initial: PageState) {
  let state = initial;
  const listeners = new Set<Listener>();
  return {
    get: () => state,
    set(patch: Partial<PageState>) {
      state = { ...state, ...patch };
      for (const l of listeners) l();
    },
    subscribe(l: Listener) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

export type PageStore = ReturnType<typeof createPageStore>;

export const PANEL_WIDTH = 420;
export const RAIL_WIDTH = 36;

const DOCK_STYLE_ID = 'quack-dock-style';

/** Reserves space on the right so GitHub's layout reflows instead of being covered. */
export function setDock(width: number): void {
  let style = document.getElementById(DOCK_STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = DOCK_STYLE_ID;
    document.head.appendChild(style);
  }
  style.textContent = width ? `html body { margin-right: ${width}px !important; }` : '';
}
