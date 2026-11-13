/** One failing check, as the agent describes it inside a `quack-ci` block. */
export interface CiFinding {
  check: string;
  verdict: 'caused_by_pr' | 'flaky' | 'unclear';
  summary: string;
  refs: { path: string; line?: number }[];
  fix?: { path?: string; patch: string };
}

export interface CiReport {
  /** Markdown before and after the block. The whole answer when there is no valid block. */
  prose: string;
  /** Null when the answer has no valid block, so the caller renders plain Markdown. */
  findings: CiFinding[] | null;
  /** A `quack-ci` fence has opened but not closed yet (the answer is still streaming). */
  pending: boolean;
}

const OPEN = /```quack-ci\b[^\n]*\n/;
const VERDICT_LABEL = { caused_by_pr: 'Caused by this PR', flaky: 'Looks flaky', unclear: 'Unclear' } as const;

function refOf(value: unknown): { path: string; line?: number } | null {
  if (!value || typeof value !== 'object') return null;
  const ref = value as { path?: unknown; line?: unknown };
  if (typeof ref.path !== 'string' || !ref.path.trim()) return null;
  const line = typeof ref.line === 'number' && Number.isInteger(ref.line) && ref.line > 0 ? ref.line : undefined;
  return { path: ref.path.trim(), ...(line !== undefined && { line }) };
}

function fixOf(value: unknown): CiFinding['fix'] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const fix = value as { path?: unknown; patch?: unknown };
  if (typeof fix.patch !== 'string' || !fix.patch.trim()) return undefined;
  const path = typeof fix.path === 'string' && fix.path.trim() ? fix.path.trim() : undefined;
  return { ...(path && { path }), patch: fix.patch };
}

function findingsOf(value: unknown): CiFinding[] | null {
  if (!Array.isArray(value)) return null;
  const findings: CiFinding[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const row = item as { check?: unknown; verdict?: unknown; summary?: unknown; refs?: unknown; fix?: unknown };
    if (typeof row.check !== 'string' || !row.check.trim()) continue;
    const verdict = row.verdict === 'caused_by_pr' || row.verdict === 'flaky' || row.verdict === 'unclear' ? row.verdict : 'unclear';
    const finding: CiFinding = {
      check: row.check.trim(),
      verdict,
      summary: typeof row.summary === 'string' ? row.summary.trim() : '',
      refs: Array.isArray(row.refs) ? row.refs.flatMap((ref) => refOf(ref) ?? []) : [],
    };
    const fix = fixOf(row.fix);
    if (fix) finding.fix = fix;
    findings.push(finding);
  }
  return findings;
}

/** Splits an answer into prose and structured CI cards. Invalid JSON falls back to the raw text. */
export function parseCiReport(text: string): CiReport {
  const open = OPEN.exec(text);
  if (!open) return { prose: text, findings: null, pending: false };
  const rest = text.slice(open.index + open[0].length);
  const close = rest.indexOf('```');
  if (close < 0) return { prose: text.slice(0, open.index).trimEnd(), findings: null, pending: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(rest.slice(0, close));
  } catch {
    return { prose: text, findings: null, pending: false };
  }
  const findings = findingsOf(parsed);
  if (!findings) return { prose: text, findings: null, pending: false };
  const prose = `${text.slice(0, open.index)}${rest.slice(close + 3)}`.trim();
  return { prose, findings, pending: false };
}

/** The answer as a review comment: cards become a list, and the JSON block is left out. */
export function ciCommentText(text: string): string {
  const report = parseCiReport(text);
  if (!report.findings) return report.pending ? report.prose : text;
  const cards = report.findings.map((finding) => {
    const lines = [`- **${finding.check}** — ${VERDICT_LABEL[finding.verdict]}.${finding.summary ? ` ${finding.summary}` : ''}`];
    if (finding.fix?.patch) lines.push(`\`\`\`\n${finding.fix.patch.trim()}\n\`\`\``);
    return lines.join('\n');
  });
  return [report.prose, ...cards].filter(Boolean).join('\n\n');
}
