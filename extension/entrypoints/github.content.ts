import type { CodeSelection } from '@quack/shared';
import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { createFloatingButton } from '../lib/askButton';
import {
  commentBoxFor,
  githubTheme,
  lineElementFor,
  lineNumberFor,
  parsePrUrl,
  readBaseRef,
  readHeadRef,
  readCommentBoxSelection,
  readDiffSelection,
  readHashSelection,
  readPrStats,
  readPrTitle,
} from '../lib/github';
import type { RuntimeMessage, TabRequest } from '../lib/messages';
import type { PageContext } from '../lib/page';

// Reports the PR, the latest diff selection and the theme to the side panel,
// and shows a floating "Ask AI" button above the selected lines.
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

    // Lines picked with the line numbers live in the URL hash. One already there
    // when the page loaded is ignored: GitHub doesn't highlight it again.
    let loadedHash: string | null = location.hash;
    const pickedLines = () => {
      if (location.hash === loadedHash) return null;
      loadedHash = null;
      return readHashSelection();
    };

    const readContext = () => {
      const pr = parsePrUrl(location.href);
      const prChanged = pr?.number !== context.pr?.number || pr?.repo !== context.pr?.repo || pr?.owner !== context.pr?.owner;
      context = {
        pr: pr ? { ...pr, title: readPrTitle(), baseRef: readBaseRef(), headRef: readHeadRef(), ...readPrStats() } : null,
        lastSelection: (pr && pickedLines()) || (prChanged ? null : context.lastSelection),
        theme: githubTheme(),
      };
      publish();
      schedulePlace();
    };

    // Floating button, placed above (in order of preference) a text selection
    // in the diff, GitHub's open comment box, or the first of the lines picked
    // with the line numbers (kept in the URL hash).
    let textSelection: CodeSelection | null = null;
    let commentBoxes: Element[] = [];

    const sameLines = (a: CodeSelection | null, b: CodeSelection | null) =>
      !!a && !!b && a.fileAnchor === b.fileAnchor && a.side === b.side && a.startLine === b.startLine && a.endLine === b.endLine;

    const visible = (el: Element) => el.isConnected && el.getClientRects().length > 0;

    const openCommentBox = (hash: CodeSelection | null): Element | undefined => {
      const open = commentBoxes.filter(visible);
      return open.find((box) => sameLines(readCommentBoxSelection(box), hash)) ?? open[open.length - 1];
    };

    const hasTextSelection = () => {
      const sel = window.getSelection();
      return !!(textSelection && (textSelection.path || textSelection.startLine) && sel && !sel.isCollapsed && sel.rangeCount);
    };

    // Rows clicked or dragged across in the diff, by line number, so the button
    // can sit on the first selected line whatever markup GitHub uses.
    let clickedRows = new Map<number, Element>();
    const rememberRow = (e: Event) => {
      const target = e.target instanceof Element ? e.target : null;
      const row = target?.closest('tr, [role="row"]');
      const line = row && lineNumberFor(row);
      if (row && line) clickedRows.set(line, row);
      if (clickedRows.size > 20) clickedRows = new Map([...clickedRows].slice(-10));
    };
    ctx.addEventListener(document, 'pointerdown', rememberRow, { capture: true });
    ctx.addEventListener(document, 'pointerup', rememberRow, { capture: true });

    const firstLineRow = (s: CodeSelection): Element | null => {
      if (!s.startLine) return null;
      const clicked = clickedRows.get(s.startLine);
      if (clicked?.isConnected) return clicked;
      const line = lineElementFor(s, s.startLine);
      return line ? line.closest('tr, [role="row"]') ?? line : null;
    };

    const linesLabel = (s: CodeSelection | null) =>
      s?.startLine ? `L${s.startLine}${s.endLine && s.endLine !== s.startLine ? `–${s.endLine}` : ''}` : undefined;

    const place = () => {
      if (!context.pr) return floating.hide();
      if (hasTextSelection()) {
        const range = window.getSelection()!.getRangeAt(0);
        const first = range.getClientRects()[0];
        if (first) return floating.showAbove(first.top, range.getBoundingClientRect().right, linesLabel(textSelection));
      }
      const hash = pickedLines();
      const box = openCommentBox(hash);
      if (box) {
        const r = box.getBoundingClientRect();
        return floating.showAbove(r.top, r.right, linesLabel(readCommentBoxSelection(box) ?? hash));
      }
      const row = hash && firstLineRow(hash);
      if (row) {
        const r = row.getBoundingClientRect();
        return floating.showAbove(r.top, r.right - 16, linesLabel(hash));
      }
      floating.hide();
    };

    const floating = createFloatingButton(() => {
      const hash = pickedLines();
      const box = openCommentBox(hash);
      askAbout(hasTextSelection() ? readDiffSelection() : (box && readCommentBoxSelection(box)) ?? hash);
      floating.hide();
    });
    ctx.onInvalidated(() => floating.remove());

    let placeFrame = 0;
    const schedulePlace = () => {
      cancelAnimationFrame(placeFrame);
      placeFrame = requestAnimationFrame(place);
    };

    const findCommentBoxes = () => {
      commentBoxes = context.pr
        ? [...document.querySelectorAll('textarea')].map(commentBoxFor).filter((box): box is Element => !!box)
        : [];
    };

    let scanTimer: number | undefined;
    const pageObserver = new MutationObserver(() => {
      if (scanTimer !== undefined) return;
      scanTimer = ctx.setTimeout(() => {
        scanTimer = undefined;
        findCommentBoxes();
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
    ctx.addEventListener(document, 'keydown', (e) => {
      if (e.key !== 'Escape' || !location.hash) return;
      loadedHash = location.hash;
      schedulePlace();
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
        sendResponse(readDiffSelection() ?? pickedLines() ?? context.lastSelection);
      }
      return false;
    };
    browser.runtime.onMessage.addListener(onMessage);
    ctx.onInvalidated(() => browser.runtime.onMessage.removeListener(onMessage));
  },
});
