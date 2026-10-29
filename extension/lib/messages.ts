import type { CompanionMessage, ExtensionMessage } from '@quack/shared';

/** Content script -> background. */
export type ToBackground = { kind: 'send'; message: ExtensionMessage };

/** Background -> content script. */
export type FromBackground =
  | { kind: 'companion'; message: CompanionMessage }
  | { kind: 'disconnected'; error: string; requestIds: string[] };
