import { useEffect, useMemo, useRef, useState } from 'react';
import type { Browser } from 'wxt/browser';
import { browser } from 'wxt/browser';
import type { CodeSelection, PrRef } from '@quack/shared';
import { Panel } from '../../components/Panel';
import { CompanionClient } from '../../lib/client';
import { parsePrUrl } from '../../lib/github';
import type { RuntimeMessage, TabRequest } from '../../lib/messages';
import type { PageContext, PanelPage } from '../../lib/page';

const samePr = (a: PrRef | null, b: PrRef | null) =>
  !!a && !!b && a.owner === b.owner && a.repo === b.repo && a.number === b.number;

const systemTheme = (): 'light' | 'dark' => (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

/** The side panel follows whichever tab is active in its window. */
export function App() {
  const client = useMemo(() => new CompanionClient(), []);
  const [tabId, setTabId] = useState<number | null>(null);
  const [context, setContext] = useState<PageContext>({ pr: null, lastSelection: null, theme: systemTheme() });
  const [notice, setNotice] = useState<string | undefined>();
  const [attachRequest, setAttachRequest] = useState<{ seq: number; selection: CodeSelection | null }>({ seq: 0, selection: null });
  const tabIdRef = useRef<number | null>(null);
  tabIdRef.current = tabId;
  const contextRef = useRef(context);
  contextRef.current = context;

  const attach = (selection: CodeSelection | null) => setAttachRequest((r) => ({ seq: r.seq + 1, selection }));

  async function loadTab(tab: Browser.tabs.Tab | undefined) {
    if (!tab?.id) return;
    setTabId(tab.id);
    const pr = tab.url ? parsePrUrl(tab.url) : null;
    if (!pr) {
      setContext((c) => ({ pr: null, lastSelection: null, theme: c.theme }));
      setNotice(undefined);
      return;
    }
    // Same PR (e.g. only the #hash changed as lines were picked): keep showing
    // what we have instead of flashing a title-less header while the page answers.
    if (!samePr(contextRef.current.pr, pr) || tab.id !== tabIdRef.current) {
      setContext((c) => ({ pr, lastSelection: null, theme: c.theme }));
    }
    try {
      const fromPage = (await browser.tabs.sendMessage(tab.id, { kind: 'get-context' } satisfies TabRequest)) as PageContext | undefined;
      if (fromPage && tabIdRef.current === tab.id) setContext(fromPage);
      setNotice(undefined);
    } catch {
      setNotice('Reload this GitHub tab so Quack can read the PR title and your diff selections.');
    }
  }

  async function loadActiveTab() {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    await loadTab(tab);
  }

  useEffect(() => {
    loadActiveTab();

    // Pick up a selection sent by the keyboard shortcut that opened this panel.
    browser.runtime.sendMessage({ kind: 'panel-ready' } satisfies RuntimeMessage).then((pending) => {
      const p = pending as { tabId: number; selection: CodeSelection | null } | null;
      if (p) attach(p.selection);
    });

    const onActivated = () => loadActiveTab();
    const onUpdated = (id: number, info: Browser.tabs.OnUpdatedInfo, tab: Browser.tabs.Tab) => {
      if (id !== tabIdRef.current || !(info.url || info.status === 'complete')) return;
      // Picking lines changes only the #hash; the content script reports that itself.
      if (info.url && !info.status && samePr(contextRef.current.pr, parsePrUrl(info.url))) return;
      loadTab(tab);
    };
    const onMessage = (msg: RuntimeMessage, sender: Browser.runtime.MessageSender) => {
      if (msg.kind === 'page-context' && sender.tab?.id === tabIdRef.current) {
        setContext(msg.context);
        setNotice(undefined);
      } else if (msg.kind === 'attach' && msg.tabId === tabIdRef.current) {
        attach(msg.selection);
      }
    };
    browser.tabs.onActivated.addListener(onActivated);
    browser.tabs.onUpdated.addListener(onUpdated);
    browser.runtime.onMessage.addListener(onMessage);
    return () => {
      browser.tabs.onActivated.removeListener(onActivated);
      browser.tabs.onUpdated.removeListener(onUpdated);
      browser.runtime.onMessage.removeListener(onMessage);
    };
  }, []);

  useEffect(() => {
    document.body.dataset.theme = context.theme;
  }, [context.theme]);

  const page: PanelPage = { ...context, attachRequest, notice };
  return <Panel page={page} client={client} />;
}
