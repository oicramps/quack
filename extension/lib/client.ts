import type { Browser } from 'wxt/browser';
import { browser } from 'wxt/browser';
import type { CompanionMessage, ExtensionMessage } from '@quack/shared';
import type { FromBackground, ToBackground } from './messages';

type Listener = (message: CompanionMessage) => void;
type DisconnectListener = (error: string, requestIds: string[]) => void;

/** Talks to the companion through the background worker's native port. */
export class CompanionClient {
  private port: Browser.runtime.Port | null = null;
  private listeners = new Map<string, Listener>();
  private disconnectListeners = new Set<DisconnectListener>();

  private connect(): Browser.runtime.Port {
    if (this.port) return this.port;
    const port = browser.runtime.connect({ name: 'quack-panel' });
    port.onMessage.addListener((msg: FromBackground) => {
      if (msg.kind === 'companion') {
        this.listeners.get(msg.message.requestId)?.(msg.message);
      } else {
        for (const l of this.disconnectListeners) l(msg.error, msg.requestIds);
        for (const id of msg.requestIds) this.listeners.delete(id);
      }
    });
    // The background worker restarted (e.g. the extension was reloaded).
    port.onDisconnect.addListener(() => {
      this.port = null;
      const ids = [...this.listeners.keys()];
      this.listeners.clear();
      if (ids.length) for (const l of this.disconnectListeners) l('The extension restarted.', ids);
    });
    this.port = port;
    return port;
  }

  send(message: ExtensionMessage, listener?: Listener): void {
    if (listener) this.listeners.set(message.requestId, listener);
    this.connect().postMessage({ kind: 'send', message } satisfies ToBackground);
  }

  forget(requestId: string): void {
    this.listeners.delete(requestId);
  }

  onDisconnect(listener: DisconnectListener): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }
}

export function newRequestId(): string {
  return crypto.randomUUID();
}
