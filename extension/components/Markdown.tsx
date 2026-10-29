import { type ReactNode, useState } from 'react';
import { CopyIcon } from './icons';

/** Where file references in an answer link to: the PR's code on GitHub. */
export interface RepoLink {
  owner: string;
  repo: string;
  sha?: string;
}

// A small Markdown subset rendered as React elements (never as HTML): headings,
// paragraphs, lists, fenced code, inline code, bold, italics and http(s) links.
// Inline code that looks like a file reference ("src/a.ts:12") links to the file.

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'code'; info: string; code: string }
  | { kind: 'quote'; text: string };

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*(```|~~~)\s*(.*)$/);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith(fence[1])) body.push(lines[i++]);
      i++;
      blocks.push({ kind: 'code', info: fence[2].trim(), code: body.join('\n') });
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] });
      i++;
      continue;
    }
    const item = /^\s*([-*+]|\d+[.)])\s+/;
    if (item.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: string[] = [];
      while (i < lines.length && (item.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        if (item.test(lines[i])) items.push(lines[i].replace(item, ''));
        else items[items.length - 1] += ` ${lines[i].trim()}`;
        i++;
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }
    if (line.startsWith('>')) {
      const quote: string[] = [];
      while (i < lines.length && lines[i].startsWith('>')) quote.push(lines[i++].replace(/^>\s?/, ''));
      blocks.push({ kind: 'quote', text: quote.join(' ') });
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*(```|~~~)/.test(lines[i]) &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !item.test(lines[i]) &&
      !lines[i].startsWith('>')
    ) {
      para.push(lines[i++].trim());
    }
    blocks.push({ kind: 'paragraph', text: para.join(' ') });
  }
  return blocks;
}

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*|__[^_]+__)|(\[[^\]]+\]\(https?:\/\/[^)\s]+\))|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;
const FILE_REF = /^([\w@.\-/]+\.[A-Za-z0-9]+)(?::(\d+)(?:[-–](\d+))?)?$/;

function fileUrl(link: RepoLink, ref: string): string | null {
  const m = ref.match(FILE_REF);
  if (!m || !link.sha || (!m[2] && !m[1].includes('/'))) return null;
  const [, path, start, end] = m;
  const lines = start ? `#L${start}${end ? `-L${end}` : ''}` : '';
  return `https://github.com/${link.owner}/${link.repo}/blob/${link.sha}/${path.replace(/^\.?\//, '')}${lines}`;
}

function inline(text: string, link: RepoLink): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const [token] = m;
    const key = m.index;
    if (m[1]) {
      const code = token.slice(1, -1);
      const url = fileUrl(link, code);
      out.push(
        url ? (
          <a key={key} className="file-ref" href={url} target="_blank" rel="noreferrer">
            {code}
          </a>
        ) : (
          <code key={key}>{code}</code>
        ),
      );
    } else if (m[2]) {
      out.push(<strong key={key}>{inline(token.slice(2, -2), link)}</strong>);
    } else if (m[3]) {
      const [, label, url] = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/)!;
      out.push(
        <a key={key} href={url} target="_blank" rel="noreferrer">
          {inline(label, link)}
        </a>,
      );
    } else {
      out.push(<em key={key}>{inline(token.slice(1, -1), link)}</em>);
    }
    last = m.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function CodeBlock({ info, code }: { info: string; code: string }) {
  const [copied, setCopied] = useState(false);
  // "ts", "ts src/a.ts" or "src/a.ts": show the file and the language when given.
  const parts = info.split(/[\s:]+/).filter(Boolean);
  const file = parts.find((p) => p.includes('/') || (p.includes('.') && !p.startsWith('.')));
  const lang = parts.find((p) => p !== file);
  const label = [file, lang].filter(Boolean).join(' · ');
  return (
    <figure className="code-block">
      <figcaption>
        <span>{label || 'code'}</span>
        <button
          type="button"
          className="ghost small"
          onClick={() => {
            navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          <CopyIcon size={14} /> {copied ? 'Copied' : 'Copy'}
        </button>
      </figcaption>
      <pre>
        <code>{code}</code>
      </pre>
    </figure>
  );
}

export function Markdown({ text, link, streaming }: { text: string; link: RepoLink; streaming?: boolean }) {
  const blocks = parseBlocks(text);
  const caret = streaming ? <span className="caret" aria-hidden="true" /> : null;
  return (
    <div className="markdown">
      {blocks.map((b, i) => {
        const end = i === blocks.length - 1 ? caret : null;
        switch (b.kind) {
          case 'heading':
            return b.level <= 2 ? (
              <h3 key={i}>
                {inline(b.text, link)}
                {end}
              </h3>
            ) : (
              <h4 key={i}>
                {inline(b.text, link)}
                {end}
              </h4>
            );
          case 'paragraph':
            return (
              <p key={i}>
                {inline(b.text, link)}
                {end}
              </p>
            );
          case 'quote':
            return (
              <blockquote key={i}>
                {inline(b.text, link)}
                {end}
              </blockquote>
            );
          case 'list': {
            const items = b.items.map((it, j) => (
              <li key={j}>
                {inline(it, link)}
                {j === b.items.length - 1 ? end : null}
              </li>
            ));
            return b.ordered ? <ol key={i}>{items}</ol> : <ul key={i}>{items}</ul>;
          }
          case 'code':
            return (
              <div key={i}>
                <CodeBlock info={b.info} code={b.code} />
                {end}
              </div>
            );
        }
      })}
      {!blocks.length && caret}
    </div>
  );
}
