import type { CodeSelection } from '@quack/shared';
import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { createCommentBoxButton, createFloatingButton } from '../lib/askButton';
import {
  COMMENT_HEADER,
  githubTheme,
  lineElementFor,
  parsePrUrl,
  readBaseRef,
  readCommentBoxSelection,
  readDiffSelection,
  readHashSelection,
  readPrTitle,
} from '../lib/github';
import type { RuntimeMessage, TabRequest } from '../lib/messages';
import type { PageContext } from '../lib/page';

// Reports the PR, the latest diff selection and the theme to the side panel,
// and shows "Ask AI" buttons next to selected lines and in GitHub's comment box.
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

    const askAbout = (selection: CodeSelection | null) => {
      if (!selection) return;
      context = { ...context, lastSelection: selection };
      publish();
      browser.runtime.sendMessage({ kind: 'ask-selection', selection } satisfies RuntimeMessage).catch(() => {});
    };

    const readContext = () => {
      const pr = parsePrUrl(location.href);
      const prChanged = pr?.number !== context.pr?.number || pr?.repo !== context.pr?.repo || pr?.owner !== context.pr?.owner;
      context = {
        pr: pr ? { ...pr, title: readPrTitle(), baseRef: readBaseRef() } : null,
        lastSelection: (pr && readHashSelection()) || (prChanged ? null : context.lastSelection),
        theme: githubTheme(),
      };
      publish();
      schedulePlace();
    };

    // Floating button: after a text selection in the diff, otherwise next to
    // the lines picked with the line numbers (kept in the URL hash).
    let textSelection: CodeSelection | null = null;
    const floating = createFloatingButton(() => {
      askAbout(textSelection && !window.getSelection()?.isCollapsed ? readDiffSelection() : readHashSelection());
      floating.hide();
    });
    ctx.onInvalidated(() => floating.remove());

    const sameLines = (a: CodeSelection, b: CodeSelection | null) =>
      !!b && a.fileAnchor === b.fileAnchor && a.side === b.side && a.startLine === b.startLine && a.endLine === b.endLine;

    const place = () => {
      if (!context.pr) return floating.hide();
      const sel = window.getSelection();
      const inDiff = textSelection && (textSelection.path || textSelection.startLine);
      if (inDiff && sel && !sel.isCollapsed && sel.rangeCount) {
        const rects = sel.getRangeAt(0).getClientRects();
        const last = rects[rects.length - 1];
        if (last) return floating.showAfter(last);
      }
      const hash = readHashSelection();
      // GitHub's comment box for these lines already carries its own button.
      if (hash && !commentBoxes.some((box) => box.isConnected && sameLines(hash, box.selection()))) {
        const line = lineElementFor(hash);
        if (line) {
          const row = line.closest('tr, [role="row"]') ?? line.parentElement ?? line;
          return floating.showInRow(row.getBoundingClientRect(), line.getBoundingClientRect());
        }
      }
      floating.hide();
    };

    let placeFrame = 0;
    const schedulePlace = () => {
      cancelAnimationFrame(placeFrame);
      placeFrame = requestAnimationFrame(place);
    };

    // Comment box button: GitHub's inline comment box names its lines in a
    // header such as "Add a comment on lines R15 to R30".
    const commentBoxes: { isConnected: boolean; selection: () => CodeSelection | null }[] = [];
    const seenTextareas = new WeakSet<HTMLTextAreaElement>();

    const findHeader = (textarea: HTMLTextAreaElement): Element | null => {
      let container: Element | null = textarea;
      for (let depth = 0; container && depth < 10; depth++, container = container.parentElement) {
        const headers = [...container.querySelectorAll('h1, h2, h3, h4, h5, h6, span, div, p, strong')].filter(
          (el) => (el.textContent?.length ?? 0) < 80 && COMMENT_HEADER.test(el.textContent?.trim() ?? ''),
        );
        if (headers.length) return headers[headers.length - 1];
      }
      return null;
    };

    const addCommentBoxButtons = () => {
      if (!context.pr) return;
      for (const textarea of document.querySelectorAll('textarea')) {
        if (seenTextareas.has(textarea)) continue;
        seenTextareas.add(textarea);
        const header = findHeader(textarea);
        if (!header) continue;
        let cancel: HTMLButtonElement | undefined;
        for (let el = textarea.parentElement, depth = 0; el && depth < 12 && !cancel; el = el.parentElement, depth++) {
          if (el.contains(header)) cancel = [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Cancel');
        }
        if (!cancel?.parentElement) continue;
        const read = () => (header.isConnected ? readCommentBoxSelection(header) : null) ?? readHashSelection();
        const button = createCommentBoxButton(() => askAbout(read()));
        cancel.parentElement.insertBefore(button, cancel);
        commentBoxes.push({
          get isConnected() {
            return button.isConnected;
          },
          selection: read,
        });
      }
      for (let i = commentBoxes.length - 1; i >= 0; i--) if (!commentBoxes[i].isConnected) commentBoxes.splice(i, 1);
    };

    let scanTimer: number | undefined;
    const pageObserver = new MutationObserver(() => {
      if (scanTimer !== undefined) return;
      scanTimer = ctx.setTimeout(() => {
        scanTimer = undefined;
        addCommentBoxButtons();
        schedulePlace();
      }, 200);
    });
    pageObserver.observe(document.documentElement, { childList: true, subtree: true });
    ctx.onInvalidated(() => pageObserver.disconnect());

    readContext();
    ctx.addEventListener(window, 'hashchange', readContext);
    ctx.addEventListener(window, 'wxt:locationchange', () => {
      readContext();
      // GitHub fills the title in after navigating.
      ctx.setTimeout(readContext, 800);
    });
    ctx.addEventListener(window, 'scroll', schedulePlace, { capture: true, passive: true });
    ctx.addEventListener(window, 'resize', schedulePlace);

    let selectionTimer: number | undefined;
    ctx.addEventListener(document, 'selectionchange', () => {
      clearTimeout(selectionTimer);
      selectionTimer = ctx.setTimeout(() => {
        textSelection = context.pr ? readDiffSelection() : null;
        if (textSelection) {
          context = { ...context, lastSelection: textSelection };
          publish();
        }
        schedulePlace();
      }, 150);
    });

    const themeObserver = new MutationObserver(readContext);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-color-mode', 'data-dark-theme'] });
    ctx.onInvalidated(() => themeObserver.disconnect());

    const onMessage = (msg: TabRequest, _sender: unknown, sendResponse: (r: unknown) => void) => {
      if (msg?.kind === 'get-context') {
        readContext();
        sendResponse(context);
      } else if (msg?.kind === 'get-selection') {
        sendResponse(readDiffSelection() ?? readHashSelection() ?? context.lastSelection);
      }
      return false;
    };
    browser.runtime.onMessage.addListener(onMessage);
    ctx.onInvalidated(() => browser.runtime.onMessage.removeListener(onMessage));
  },
});
