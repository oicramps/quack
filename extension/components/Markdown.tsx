import { useMemo, useState } from 'react';
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { highlight, languageFor } from './highlight';
import { CopyIcon } from './icons';

/** Where file references in an answer link to: the PR's code on GitHub. */
export interface RepoLink {
  owner: string;
  repo: string;
  sha?: string;
}

// GitHub-flavored Markdown via react-markdown, which builds React elements and
// never renders raw HTML. The only HTML is highlight.js output for code, which
// escapes its input. Inline code that looks like a file reference
// ("src/a.ts:12") links to the file at the PR's commit.

const FILE_REF = /^([\w@.\-/]+\.[A-Za-z0-9]+)(?::(\d+)(?:[-–](\d+))?)?$/;

function fileUrl(link: RepoLink, ref: string): string | null {
  const m = ref.match(FILE_REF);
  if (!m || !link.sha || (!m[2] && !m[1].includes('/'))) return null;
  const [, path, start, end] = m;
  const lines = start ? `#L${start}${end ? `-L${end}` : ''}` : '';
  return `https://github.com/${link.owner}/${link.repo}/blob/${link.sha}/${path.replace(/^\.?\//, '')}${lines}`;
}

function CodeBlock({ info, code }: { info: string; code: string }) {
  const [copied, setCopied] = useState(false);
  // "ts", "ts src/a.ts" or "src/a.ts": show the file and the language when given.
  const parts = info.split(/[\s:]+/).filter(Boolean);
  const file = parts.find((p) => p.includes('/') || (p.includes('.') && !p.startsWith('.')));
  const lang = parts.find((p) => p !== file);
  const label = [file, lang].filter(Boolean).join(' · ');
  const language = languageFor(lang, file);
  const html = useMemo(() => (language ? highlight(code, language) : null), [code, language]);
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
      <pre>{html ? <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} /> : <code>{code}</code>}</pre>
    </figure>
  );
}

type HastNode = { type: string; value?: string; tagName?: string; properties?: { className?: unknown }; data?: { meta?: unknown }; children?: HastNode[] };

const textOf = (node: HastNode): string => node.value ?? (node.children ?? []).map(textOf).join('');

/** A fenced block arrives as <pre><code class="language-js"> plus the fence's remaining words as `meta`. */
function FencedCode({ node }: ExtraProps) {
  const code = (node?.children as HastNode[] | undefined)?.find((c) => c.tagName === 'code');
  if (!code) return null;
  const classes = Array.isArray(code.properties?.className) ? (code.properties.className as string[]) : [];
  const lang = classes.find((c) => c.startsWith('language-'))?.slice('language-'.length) ?? '';
  const meta = typeof code.data?.meta === 'string' ? code.data.meta : '';
  return <CodeBlock info={`${lang} ${meta}`.trim()} code={textOf(code).replace(/\n$/, '')} />;
}

function components(link: RepoLink): Components {
  return {
    pre: FencedCode,
    code: ({ children }) => {
      const text = String(children ?? '');
      const url = fileUrl(link, text);
      return url ? (
        <a className="file-ref" href={url} target="_blank" rel="noreferrer">
          {text}
        </a>
      ) : (
        <code>{children}</code>
      );
    },
    a: ({ href, children }) => (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    ),
    // The panel only needs two heading sizes, and doesn't load remote images.
    h1: ({ children }) => <h3>{children}</h3>,
    h2: ({ children }) => <h3>{children}</h3>,
    h3: ({ children }) => <h4>{children}</h4>,
    h5: ({ children }) => <h4>{children}</h4>,
    h6: ({ children }) => <h4>{children}</h4>,
    img: ({ alt }) => <span>{alt}</span>,
    table: ({ children }) => (
      <div className="table-wrap">
        <table>{children}</table>
      </div>
    ),
  };
}

const PLUGINS = [remarkGfm];

export function Markdown({ text, link, streaming }: { text: string; link: RepoLink; streaming?: boolean }) {
  const mapped = useMemo(() => components(link), [link.owner, link.repo, link.sha]);
  return (
    <div className={`markdown${streaming ? ' streaming' : ''}`}>
      <ReactMarkdown remarkPlugins={PLUGINS} components={mapped}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
