import type { Browser } from 'wxt/browser';
import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import type { CodeSelection, CompanionMessage, ExtensionMessage } from '@quack/shared';
import { HOST_NAME } from '@quack/shared';
import type { FromBackground, RuntimeMessage, TabRequest, ToBackground } from '../lib/messages';

type Port = Browser.runtime.Port;

export default defineBackground(() => {
  // The toolbar icon opens Chrome's side panel.
  browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

  // Cmd/Ctrl+Shift+K and the in-page "Ask Quack" button open the panel and attach
  // the selected diff lines. sidePanel.open needs the user gesture, so it is
  // called before anything asynchronous.
  let pendingAttach: { tabId: number; selection: CodeSelection | null } | null = null;

  const attach = (tabId: number, selection: CodeSelection | null) => {
    pendingAttach = { tabId, selection };
    // Reaches the panel if it was already open; otherwise it asks on load.
    browser.runtime.sendMessage({ kind: 'attach', ...pendingAttach } satisfies RuntimeMessage).catch(() => {});
  };

  browser.commands.onCommand.addListener((command, tab) => {
    if (command !== 'ask-about-selection' || tab?.id === undefined) return;
    const tabId = tab.id;
    browser.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
    browser.tabs
      .sendMessage(tabId, { kind: 'get-selection' } satisfies TabRequest)
      .catch(() => null)
      .then((selection) => attach(tabId, (selection as CodeSelection | null) ?? null));
  });

  browser.runtime.onMessage.addListener((msg: RuntimeMessage, sender, sendResponse) => {
    if (msg?.kind === 'ask-selection' && sender.tab?.id !== undefined) {
      browser.sidePanel.open({ windowId: sender.tab.windowId }).catch(() => {});
      attach(sender.tab.id, msg.selection);
    } else if (msg?.kind === 'panel-ready') {
      sendResponse(pendingAttach);
      pendingAttach = null;
    }
    return false;
  });

  // Multiplex a single native messaging port across all open side panels.
  // Opens on first request and disconnects when the last panel closes.
  let native: Port | null = null;
  const panels = new Set<Port>();
  /** Maps in-flight `requestId` -> originating side panel port. */
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
        (msg.type === 'status' && !msg.pending?.length) || (msg.type === 'event' && (msg.event.type === 'done' || msg.event.type === 'error'));
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
      if (message.type === 'status' || message.type === 'ask') owners.set(message.requestId, port);
      try {
        openNative().postMessage(message);
      } catch (err) {
        owners.delete(message.requestId);
        post(port, { kind: 'disconnected', error: String(err), requestIds: [message.requestId] });
      }
    });

    // Side panel closed: stop its agents.
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
