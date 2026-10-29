import type { Browser } from 'wxt/browser';
import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import type { CompanionMessage, ExtensionMessage } from '@quack/shared';
import { HOST_NAME } from '@quack/shared';
import type { FromBackground, ToBackground } from '../lib/messages';

type Port = Browser.runtime.Port;

// One native port per browser session, shared by every PR tab. It is opened on
// the first request and closed when the last panel goes away, which lets Chrome
// stop the companion.
export default defineBackground(() => {
  let native: Port | null = null;
  const panels = new Set<Port>();
  const owners = new Map<string, Port>();

  const post = (port: Port, message: FromBackground) => {
    try {
      port.postMessage(message);
    } catch {
      panels.delete(port);
    }
  };

  function openNative(): Port {
    if (native) return native;
    const port = browser.runtime.connectNative(HOST_NAME);
    port.onMessage.addListener((msg: CompanionMessage) => {
      const owner = owners.get(msg.requestId);
      if (!owner) return;
      post(owner, { kind: 'companion', message: msg });
      const finished =
        msg.type === 'status' || (msg.type === 'event' && (msg.event.type === 'done' || msg.event.type === 'error'));
      if (finished) owners.delete(msg.requestId);
    });
    port.onDisconnect.addListener(() => {
      const error = browser.runtime.lastError?.message ?? 'The companion stopped.';
      native = null;
      for (const panel of panels) post(panel, { kind: 'disconnected', error, requestIds: [...owners.keys()] });
      owners.clear();
    });
    native = port;
    return port;
  }

  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== 'quack-panel') return;
    panels.add(port);

    port.onMessage.addListener((msg: ToBackground) => {
      if (msg.kind !== 'send') return;
      const message: ExtensionMessage = msg.message;
      if (message.type !== 'cancel') owners.set(message.requestId, port);
      try {
        openNative().postMessage(message);
      } catch (err) {
        owners.delete(message.requestId);
        post(port, { kind: 'disconnected', error: String(err), requestIds: [message.requestId] });
      }
    });

    // Panel closed or tab navigated away: stop its agents.
    port.onDisconnect.addListener(() => {
      panels.delete(port);
      for (const [requestId, owner] of owners) {
        if (owner !== port) continue;
        owners.delete(requestId);
        native?.postMessage({ type: 'cancel', requestId } satisfies ExtensionMessage);
      }
      if (panels.size === 0 && native) {
        native.disconnect();
        native = null;
      }
    });
  });
});
