import type { CodeSelection, PrRef } from '@quack/shared';

/** What the content script reports about a GitHub tab. */
export interface PageContext {
  pr: PrRef | null;
  lastSelection: CodeSelection | null;
  theme: 'light' | 'dark';
}

/** What the side panel shows: the active tab's context plus panel-only state. */
export interface PanelPage extends PageContext {
  /** Increments each time the shortcut asks the panel to attach a selection. */
  attachRequest: { seq: number; selection: CodeSelection | null };
  /** Shown above the thread, e.g. when the tab needs a reload. */
  notice?: string;
}
