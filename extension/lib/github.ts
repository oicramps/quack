import type { CodeSelection, PrRef } from '@quack/shared';
import type { PrStats } from './page';

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
  return readRef('.base-ref, [class*="BaseRef"] a, .commit-ref.base-ref');
}

export function readHeadRef(): string | undefined {
  return readRef('.head-ref, [class*="HeadRef"] a, .commit-ref.head-ref');
}

function readRef(selector: string): string | undefined {
  const text = document.querySelector(selector)?.textContent?.trim().replace(/^[^:]+:/, '');
  return text && /^[A-Za-z0-9._\/-]+$/.test(text) ? text : undefined;
}

const toCount = (text: string | null | undefined) => {
  const n = Number(text?.replace(/[^\d]/g, ''));
  return text && /\d/.test(text) && Number.isFinite(n) ? n : undefined;
};

/** Reads the tab counter after a PR tab link ("Commits 3"), in either of GitHub's page UIs. */
function tabCount(counterId: string, tab: 'commits' | 'files' | 'changes'): number | undefined {
  const counter = document.getElementById(counterId);
  if (counter) return toCount(counter.getAttribute('title') ?? counter.textContent);
  for (const link of document.querySelectorAll<HTMLAnchorElement>(`a[href*="/pull/"][href$="/${tab}"]`)) {
    const label = link.querySelector('[data-component="CounterLabel"], .Counter');
    const n = toCount(label?.getAttribute('title') ?? label?.textContent);
    if (n !== undefined) return n;
  }
  return undefined;
}

export function readPrStats(): PrStats {
  const diffstat = document.getElementById('diffstat');
  return {
    commits: tabCount('commits_tab_counter', 'commits'),
    files: tabCount('files_tab_counter', 'files') ?? tabCount('files_tab_counter', 'changes'),
    additions: toCount(diffstat?.querySelector('.color-fg-success, .fgColor-success')?.textContent),
    deletions: toCount(diffstat?.querySelector('.color-fg-danger, .fgColor-danger')?.textContent),
  };
}

/**
 * The PR's latest head commit, from the JSON GitHub embeds in the page
 * ("headSha" in the React UI, "head_sha"/data attributes in the classic one).
 * Falls back to the commit pinned in the URL.
 */
export function readHeadSha(): string | undefined {
  for (const el of document.querySelectorAll('script[type="application/json"], react-app script, [data-target="react-app.embeddedData"]')) {
    const m = el.textContent?.match(/"headSha"\s*:\s*"([0-9a-f]{40})"/);
    if (m) return m[1];
  }
  const attr = document.querySelector('[data-head-sha], input[name="head_sha"], input[name="commit_id"]');
  const value = attr?.getAttribute('data-head-sha') ?? (attr as HTMLInputElement | null)?.value;
  if (value && /^[0-9a-f]{40}$/.test(value)) return value;
  return parsePrUrl(location.href)?.headSha;
}

export function prKey(pr: Pick<PrRef, 'owner' | 'repo' | 'number'>): string {
  return `${pr.owner}/${pr.repo}#${pr.number}`.toLowerCase();
}

// GitHub serves both classic table diffs and React diffs; selectors below cover both DOM structures.

const PATH_ATTRS = ['data-tagsearch-path', 'data-path', 'data-file-path'];

function elementOf(node: Node): Element | null {
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

/** Walks up the DOM from `el` to resolve the repository-relative file path for a diff block. */
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

/** Extracts the diff line number from the row containing `el`, preferring the new (right) side. */
export function lineNumberFor(el: Element | null): number | undefined {
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
  const fields = 'textarea, input, [contenteditable="true"]';
  if (startEl?.closest(fields) || document.activeElement?.matches(fields)) return null;
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

/**
 * Lines picked by clicking line numbers, which GitHub records in the URL as
 * "#diff-<sha256 of path>R45-R52" (R = new file, L = old file).
 */
export function readHashSelection(hash = location.hash): CodeSelection | null {
  const m = hash.match(/^#diff-([0-9a-f]{64})([LR])(\d+)(?:-([LR])(\d+))?$/);
  if (!m) return null;
  const [, fileAnchor, side, start, , end] = m;
  return lineSelection(fileAnchor, side, Number(start), end ? Number(end) : Number(start));
}

function lineSelection(fileAnchor: string, side: string, start: number, end: number): CodeSelection {
  const fileEl = document.getElementById(`diff-${fileAnchor}`);
  const path = fileEl ? filePathFor(fileEl) ?? filePathFor(fileEl.querySelector('[data-file-path], [data-path], a[href^="#diff-"]')) : undefined;
  const [startLine, endLine] = end < start ? [end, start] : [start, end];
  return { path, fileAnchor, side: side === 'L' ? 'old' : 'new', startLine, endLine };
}

/** The file anchor of the diff file containing `el`, from its "diff-<sha256>" id. */
function fileAnchorFor(el: Element): string | undefined {
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    const m = cur.id.match(/^diff-([0-9a-f]{64})$/);
    if (m) return m[1];
  }
  return undefined;
}

/** "Add a comment on lines R15 to R30" / "Add a comment on line L7", the title of GitHub's inline comment box. */
const COMMENT_TITLE = /Add a comment on lines? ([LR])(\d+)(?: to ([LR])(\d+))?/;

/**
 * GitHub's inline comment box around `textarea`: the smallest ancestor that
 * also holds the "Add a comment on lines …" title.
 */
export function commentBoxFor(textarea: HTMLTextAreaElement): Element | null {
  for (let el = textarea.parentElement, depth = 0; el && depth < 12; el = el.parentElement, depth++) {
    const text = el.textContent ?? '';
    if (text.length > 5000) return null;
    if (COMMENT_TITLE.test(text)) return el;
  }
  return null;
}

export function readCommentBoxSelection(box: Element): CodeSelection | null {
  const m = box.textContent?.match(COMMENT_TITLE);
  const fileAnchor = fileAnchorFor(box) ?? readHashSelection()?.fileAnchor;
  if (!m || !fileAnchor) return null;
  const [, side, start, , end] = m;
  return lineSelection(fileAnchor, side, Number(start), end ? Number(end) : Number(start));
}

/** The element showing one of a selection's line numbers, used to place the in-page button. */
export function lineElementFor(s: CodeSelection, line: number): Element | null {
  if (!s.fileAnchor) return null;
  const letter = s.side === 'old' ? 'L' : 'R';
  const id = `diff-${s.fileAnchor}${letter}${line}`;
  const direct = document.getElementById(id) ?? document.querySelector(`[data-line-anchor="${id}"]`);
  if (direct) return direct;
  const fileEl = document.getElementById(`diff-${s.fileAnchor}`);
  if (!fileEl) return null;
  const n = String(line);
  const sideAttr = s.side === 'old' ? 'left' : 'right';
  const numbered = [...fileEl.querySelectorAll(`[data-line-number="${n}"]`)];
  const exact = numbered.find((el) => el.getAttribute('data-diff-side') === sideAttr);
  if (exact) return exact;
  // Line-number cells that show only the number: the old side comes first, the new side last.
  const cells = numbered.length
    ? numbered
    : [...fileEl.querySelectorAll('td, [role="gridcell"], [role="cell"], span, div')].filter(
        (el) =>
          el.childElementCount === 0 &&
          el.textContent?.trim() === n &&
          el.closest('tr, [role="row"]') &&
          el.getClientRects().length > 0 &&
          !el.closest('code, pre, [class*="diff-text"], [class*="blob-code"]'),
      );
  if (!cells.length) return null;
  const byX = cells.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
  return s.side === 'old' ? byX[0] : byX[byX.length - 1];
}

/**
 * Puts GitHub's comment box for `s` on screen: highlights the lines through
 * the URL hash, then clicks that line's "add comment" button when the diff
 * has one. Without lines, focuses the conversation's comment box.
 * Returns whether a comment box was found.
 */
export function openCommentFor(s: CodeSelection | null): boolean {
  if (!s?.fileAnchor || !s.startLine) {
    const box = document.querySelector<HTMLTextAreaElement>('#new_comment_field, textarea[name="comment[body]"], [data-testid="markdown-editor-input"]');
    box?.scrollIntoView({ block: 'center' });
    box?.focus();
    return !!box;
  }
  const letter = s.side === 'old' ? 'L' : 'R';
  const end = s.endLine && s.endLine !== s.startLine ? `-${letter}${s.endLine}` : '';
  location.hash = `diff-${s.fileAnchor}${letter}${s.startLine}${end}`;
  const line = lineElementFor(s, s.endLine ?? s.startLine);
  const row = line?.closest('tr, [role="row"]') ?? line;
  row?.scrollIntoView({ block: 'center' });
  const button = row?.querySelector<HTMLElement>(
    'button.js-add-line-comment, button.add-line-comment, button[aria-label*="comment" i], [data-testid*="add-comment" i]',
  );
  button?.click();
  return !!button;
}

export function selectionLabel(s: CodeSelection): string {
  const lines = s.startLine ? ` · L${s.startLine}${s.endLine && s.endLine !== s.startLine ? `–${s.endLine}` : ''}` : '';
  const name = s.path ?? (s.fileAnchor ? 'Selected lines' : 'Selected code');
  return `${name}${lines}${s.side === 'old' ? ' (old)' : ''}`;
}

/** Folder (muted), file name, and the line-range pill for a composer chip. */
export function selectionChip(s: CodeSelection): { dir: string; name: string; lines: string } {
  const full = s.path ?? (s.fileAnchor ? 'Selected lines' : 'Selected code');
  const slash = full.lastIndexOf('/');
  const range = s.startLine ? `L${s.startLine}${s.endLine && s.endLine !== s.startLine ? `–${s.endLine}` : ''}` : '';
  return {
    dir: slash >= 0 ? full.slice(0, slash + 1) : '',
    name: slash >= 0 ? full.slice(slash + 1) : full,
    lines: range ? `${range}${s.side === 'old' ? ' old' : ''}` : '',
  };
}

export function githubTheme(): 'light' | 'dark' {
  const html = document.documentElement;
  const mode = html.getAttribute('data-color-mode');
  if (mode === 'dark') return 'dark';
  if (mode === 'light') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
