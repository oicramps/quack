import { useState } from 'react';
import type { CheckRun } from '@quack/shared';
import { type CiFinding, parseCiReport } from '@quack/shared';
import { StatusIcon } from './brand';
import { type RepoLink, Markdown } from './Markdown';

const VERDICT = {
  caused_by_pr: { label: 'Caused by this PR', className: 'caused' },
  flaky: { label: 'Looks flaky', className: 'flaky' },
  unclear: { label: 'Unclear', className: 'unclear' },
} as const;

function matchCheck(checks: CheckRun[], name: string): CheckRun | undefined {
  const wanted = name.trim().toLowerCase();
  return (
    checks.find((check) => check.name.toLowerCase() === wanted) ??
    checks.find((check) => wanted.includes(check.name.toLowerCase()) || check.name.toLowerCase().includes(wanted))
  );
}

function Patch({ patch }: { patch: string }) {
  return (
    <pre className="ci-patch">
      {patch.split('\n').map((line, i) => {
        const kind = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.trim().startsWith('//') ? 'note' : '';
        return (
          <div key={i} className={kind}>
            {line || ' '}
          </div>
        );
      })}
    </pre>
  );
}

function CiCard({ finding, link, job }: { finding: CiFinding; link: RepoLink; job?: CheckRun }) {
  const verdict = VERDICT[finding.verdict];
  const [copied, setCopied] = useState(false);
  return (
    <section className={`ci-card ${verdict.className}`}>
      <div className="ci-card-head">
        <StatusIcon kind="error" size={16} />
        <span className="ci-card-name">{finding.check}</span>
        <span className={`verdict ${verdict.className}`}>{verdict.label}</span>
      </div>
      {finding.summary && <Markdown text={finding.summary} link={link} />}
      {finding.fix?.patch && <Patch patch={finding.fix.patch} />}
      {(finding.fix?.patch || job?.link) && (
        <div className="row">
          {finding.fix?.patch && (
            <button
              type="button"
              className="secondary"
              onClick={() => {
                navigator.clipboard.writeText(finding.fix!.patch).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }, () => {});
              }}
            >
              {copied ? 'Copied' : 'Copy fix'}
            </button>
          )}
          {job?.link && (
            <button type="button" className="secondary" onClick={() => window.open(job.link, '_blank', 'noopener,noreferrer')}>
              {finding.verdict === 'flaky' ? 'Open job to re-run' : 'Open job log'}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/** Renders a CI answer as cards when it contains a valid quack-ci block, otherwise as Markdown. */
export function AnswerBody({
  text,
  link,
  streaming,
  checks,
}: {
  text: string;
  link: RepoLink;
  streaming?: boolean;
  checks: CheckRun[];
}) {
  const report = parseCiReport(text);
  if (!report.findings) {
    return <Markdown text={report.pending ? report.prose : text} link={link} streaming={streaming} />;
  }
  return (
    <div className="ci-report">
      {report.prose && <Markdown text={report.prose} link={link} streaming={streaming} />}
      {report.findings.map((finding, i) => (
        <CiCard key={`${finding.check}-${i}`} finding={finding} link={link} job={matchCheck(checks, finding.check)} />
      ))}
    </div>
  );
}
