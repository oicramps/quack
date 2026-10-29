import type { CodeSelection, PrRef } from '@quack/shared';

/** Reads owner, repo, PR number and, when the URL pins one, the viewed head commit. */
export function parsePrUrl(url: string): PrRef | null {
  const { pathname } = new URL(url);
  const m = pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/([^/]+)(?:\/([0-9a-f]{7,40})(?:\.\.([0-9a-f]{7,40}))?)?)?/);
  if (!m) return null;
  const [, owner, repo, number, , sha1, sha2] = m;
  return { owner, repo, number: Number(number), headSha: sha2 ?? sha1 };
}

export function readPrTitle(): string | undefined {
  const el = document.querySelector('.js-issue-title, [data-testid="issue-title"], bdi.markdown-title');
  const fromDom = el?.textContent?.trim();
  if (fromDom) return fromDom;
  // "Title by author · Pull Request #14 · owner/repo · GitHub"
  const fromTitle = document.title.split(' · Pull Request #')[0]?.replace(/ by [^ ]+$/, '').trim();
  return fromTitle || undefined;
}

export function readBaseRef(): string | undefined {
  const el = document.querySelector('.base-ref, [class*="BaseRef"] a, .commit-ref.base-ref');
  const text = el?.textContent?.trim().replace(/^[^:]+:/, '');
  return text && /^[A-Za-z0-9._\/-]+$/.test(text) ? text : undefined;
}

export function prKey(pr: Pick<PrRef, 'owner' | 'repo' | 'number'>): string {
  return `${pr.owner}/${pr.repo}#${pr.number}`.toLowerCase();
}

// GitHub has shipped two diff UIs (the classic table and the newer React one),
// so file paths and line numbers are read with several fallbacks.

const PATH_ATTRS = ['data-tagsearch-path', 'data-path', 'data-file-path'];

function elementOf(node: Node): Element | null {
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

function filePathFor(el: Element | null): string | undefined {
  for (let cur = el, depth = 0; cur && depth < 30; cur = cur.parentElement, depth++) {
    for (const attr of PATH_ATTRS) {
      const v = cur.getAttribute(attr);
      if (v) return v;
    }
    if (cur.id.startsWith('diff-') || cur.classList.contains('file') || cur.getAttribute('data-testid') === 'diff-file') {
      const tagged = cur.querySelector(PATH_ATTRS.map((a) => `[${a}]`).join(','));
      for (const attr of PATH_ATTRS) {
        const v = tagged?.getAttribute(attr);
        if (v) return v;
      }
      const link = cur.querySelector('.file-info a[title], .file-header a[title], h3 a[title]');
      const title = link?.getAttribute('title');
      if (title) return title;
      const headerLink = cur.querySelector('h3 a[href^="#diff-"], a[href^="#diff-"] code');
      const text = headerLink?.textContent?.replace(/[\u200e\u200f]/g, '').trim();
      if (text && /^[^\s]+\.[^\s]+$|\//.test(text)) return text;
    }
  }
  return undefined;
}

function lineNumberFor(el: Element | null): number | undefined {
  const row = el?.closest('tr, [role="row"]');
  if (!row) return undefined;
  const numbers: { n: number; side: string | null }[] = [];
  for (const cell of row.querySelectorAll('[data-line-number]')) {
    const n = Number(cell.getAttribute('data-line-number'));
    if (Number.isInteger(n) && n > 0) numbers.push({ n, side: cell.getAttribute('data-diff-side') });
  }
  const right = numbers.find((x) => x.side === 'right');
  if (right) return right.n;
  if (numbers.length) return numbers[numbers.length - 1].n;
  // Anchors like "diff-<hash>R12" (new file side) or "...L12" (old side).
  let left: number | undefined;
  for (const cell of row.querySelectorAll('[id], [data-line-anchor]')) {
    const m = (cell.getAttribute('data-line-anchor') ?? cell.id).match(/([LR])(\d+)$/);
    if (m?.[1] === 'R') return Number(m[2]);
    if (m) left ??= Number(m[2]);
  }
  if (left) return left;
  // Last resort: the last cell that holds only a number.
  const numericCells = [...row.children].map((c) => c.textContent?.trim() ?? '').filter((t) => /^\d+$/.test(t));
  return numericCells.length ? Number(numericCells[numericCells.length - 1]) : undefined;
}

/** The current text selection, if it is inside a diff. */
export function readDiffSelection(): CodeSelection | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const text = sel.toString();
  if (!text.trim()) return null;
  const range = sel.getRangeAt(0);
  const startEl = elementOf(range.startContainer);
  const endEl = elementOf(range.endContainer);
  const path = filePathFor(startEl) ?? filePathFor(endEl);
  let startLine = lineNumberFor(startEl);
  let endLine = lineNumberFor(endEl) ?? startLine;
  // Ignore selections in GitHub's header and navigation; keep anything else on the PR page.
  if (!path && startLine === undefined && startEl?.closest('header, nav, [role="navigation"], [role="banner"]')) {
    return null;
  }
  if (startLine !== undefined && endLine !== undefined && endLine < startLine) [startLine, endLine] = [endLine, startLine];
  return { path, startLine, endLine, text: text.slice(0, 20_000) };
}

export function selectionLabel(s: CodeSelection): string {
  const lines = s.startLine ? ` · L${s.startLine}${s.endLine && s.endLine !== s.startLine ? `–${s.endLine}` : ''}` : '';
  return `${s.path ?? 'Selected code'}${lines}`;
}

export function githubTheme(): 'light' | 'dark' {
  const html = document.documentElement;
  const mode = html.getAttribute('data-color-mode');
  if (mode === 'dark') return 'dark';
  if (mode === 'light') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
