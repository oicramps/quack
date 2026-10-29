import ReactDOM from 'react-dom/client';
import { createShadowRootUi } from 'wxt/utils/content-script-ui/shadow-root';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { Panel } from '../components/Panel';
import { CompanionClient } from '../lib/client';
import { parsePrUrl, readBaseRef, readDiffSelection, readPrTitle } from '../lib/github';
import { createPageStore, setDock } from '../lib/page';
import '../components/panel.css';

export default defineContentScript({
  // All of github.com, because GitHub navigates to PRs without a page load.
  matches: ['https://github.com/*'],
  cssInjectionMode: 'ui',

  async main(ctx) {
    const store = createPageStore({ pr: null, open: true, lastSelection: null, attachRequest: { seq: 0, selection: null } });
    const client = new CompanionClient();

    const readPr = () => {
      const pr = parsePrUrl(location.href);
      if (!pr) return null;
      return { ...pr, title: readPrTitle(), baseRef: readBaseRef() };
    };

    const ui = await createShadowRootUi(ctx, {
      name: 'quack-panel',
      position: 'inline',
      anchor: 'html',
      append: 'last',
      // Keep typing in the panel from triggering GitHub's keyboard shortcuts.
      isolateEvents: ['keydown', 'keyup', 'keypress'],
      onMount(container, _shadow, host) {
        Object.assign(host.style, { position: 'fixed', top: '0', right: '0', height: '100vh', zIndex: '2147483000' });
        const root = ReactDOM.createRoot(container);
        root.render(<Panel store={store} client={client} />);
        return root;
      },
      onRemove(root) {
        root?.unmount();
        setDock(0);
      },
    });

    const sync = () => {
      const pr = readPr();
      const prev = store.get().pr;
      if (pr?.owner !== prev?.owner || pr?.repo !== prev?.repo || pr?.number !== prev?.number || pr?.headSha !== prev?.headSha) {
        store.set({ pr });
      } else if (pr && (pr.title !== prev?.title || pr.baseRef !== prev?.baseRef)) {
        store.set({ pr });
      }
      if (pr && !ui.mounted) ui.mount();
      if (!pr && ui.mounted) ui.remove();
    };

    sync();
    ctx.addEventListener(window, 'wxt:locationchange', () => {
      sync();
      // GitHub fills the title in after navigating.
      ctx.setTimeout(sync, 800);
    });

    let selectionTimer: number | undefined;
    ctx.addEventListener(document, 'selectionchange', () => {
      clearTimeout(selectionTimer);
      selectionTimer = ctx.setTimeout(() => {
        const selection = readDiffSelection();
        if (selection) store.set({ lastSelection: selection });
      }, 150);
    });

    ctx.addEventListener(
      document,
      'keydown',
      (e: KeyboardEvent) => {
        if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'k' && store.get().pr) {
          e.preventDefault();
          e.stopPropagation();
          const { attachRequest, lastSelection } = store.get();
          store.set({ open: true, attachRequest: { seq: attachRequest.seq + 1, selection: readDiffSelection() ?? lastSelection } });
        }
      },
      { capture: true },
    );
  },
});
