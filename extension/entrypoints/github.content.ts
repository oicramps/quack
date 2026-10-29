import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { githubTheme, parsePrUrl, readBaseRef, readDiffSelection, readPrTitle } from '../lib/github';
import type { RuntimeMessage, TabRequest } from '../lib/messages';
import type { PageContext } from '../lib/page';

// Reports the PR, the latest diff selection and the theme to the side panel.
// The panel itself lives in Chrome's side panel, not in the page.
export default defineContentScript({
  // All of github.com, because GitHub navigates to PRs without a page load.
  matches: ['https://github.com/*'],

  main(ctx) {
    let context: PageContext = { pr: null, lastSelection: null, theme: githubTheme() };
    let lastSent = '';

    const publish = () => {
      const json = JSON.stringify(context);
      if (json === lastSent) return;
      lastSent = json;
      // Fails harmlessly when the side panel is closed.
      browser.runtime.sendMessage({ kind: 'page-context', context } satisfies RuntimeMessage).catch(() => {});
    };

    const readContext = () => {
      const pr = parsePrUrl(location.href);
      const prChanged = pr?.number !== context.pr?.number || pr?.repo !== context.pr?.repo || pr?.owner !== context.pr?.owner;
      context = {
        pr: pr ? { ...pr, title: readPrTitle(), baseRef: readBaseRef() } : null,
        lastSelection: prChanged ? null : context.lastSelection,
        theme: githubTheme(),
      };
      publish();
    };

    readContext();
    ctx.addEventListener(window, 'wxt:locationchange', () => {
      readContext();
      // GitHub fills the title in after navigating.
      ctx.setTimeout(readContext, 800);
    });

    let selectionTimer: number | undefined;
    ctx.addEventListener(document, 'selectionchange', () => {
      clearTimeout(selectionTimer);
      selectionTimer = ctx.setTimeout(() => {
        const selection = readDiffSelection();
        if (selection && context.pr) {
          context = { ...context, lastSelection: selection };
          publish();
        }
      }, 150);
    });

    const observer = new MutationObserver(readContext);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-color-mode', 'data-dark-theme'] });
    ctx.onInvalidated(() => observer.disconnect());

    const onMessage = (msg: TabRequest, _sender: unknown, sendResponse: (r: unknown) => void) => {
      if (msg?.kind === 'get-context') {
        readContext();
        sendResponse(context);
      } else if (msg?.kind === 'get-selection') {
        sendResponse(readDiffSelection() ?? context.lastSelection);
      }
      return false;
    };
    browser.runtime.onMessage.addListener(onMessage);
    ctx.onInvalidated(() => browser.runtime.onMessage.removeListener(onMessage));
  },
});
