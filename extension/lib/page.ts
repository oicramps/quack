import type { CodeSelection, PrRef } from '@quack/shared';

/** Counts read from the PR page when GitHub shows them. */
export interface PrStats {
  commits?: number;
  files?: number;
  additions?: number;
  deletions?: number;
}

/** What the content script reports about a GitHub tab. */
export interface PageContext {
  /**
   * headRef, latestSha and the stats are shown in the panel only; the companion
   * resolves the PR itself. latestSha is the head commit the page shows.
   */
  pr: (PrRef & { headRef?: string; latestSha?: string } & PrStats) | null;
  lastSelection: CodeSelection | null;
  theme: 'light' | 'dark';
}

/** What the side panel shows: the active tab's context plus panel-only state. */
export interface PanelPage extends PageContext {
  /** The GitHub tab the panel follows, for requests to its content script. */
  tabId: number | null;
  /** Increments each time the shortcut asks the panel to attach a selection. */
  attachRequest: { seq: number; selection: CodeSelection | null };
  /** Shown above the thread, e.g. when the tab needs a reload. */
  notice?: string;
}
