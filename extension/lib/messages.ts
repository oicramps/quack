import type { CodeSelection, CompanionMessage, ExtensionMessage } from '@quack/shared';
import type { PageContext } from './page';

/** Side panel -> background, over the panel's port. */
export type ToBackground = { kind: 'send'; message: ExtensionMessage };

/** Background -> side panel, over the panel's port. */
export type FromBackground =
  | { kind: 'companion'; message: CompanionMessage }
  | { kind: 'disconnected'; error: string; requestIds: string[] };

/** Sent to a GitHub tab's content script with tabs.sendMessage. */
export type TabRequest = { kind: 'get-context' } | { kind: 'get-selection' };

/** One-off runtime messages between the content script, background and side panel. */
export type RuntimeMessage =
  | { kind: 'page-context'; context: PageContext }
  | { kind: 'attach'; tabId: number; selection: CodeSelection | null }
  | { kind: 'panel-ready' };
