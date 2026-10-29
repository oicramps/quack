import { useState } from 'react';
import type { FixStep } from '@quack/shared';
import { Check, CopyIcon } from './icons';

export function FixSteps({ steps }: { steps: FixStep[] }) {
  return (
    <ol className="fix-steps">
      {steps.map((step, i) => (
        <li key={i}>
          <span>{step.text}</span>
          {step.command && <CommandBlock command={step.command} />}
        </li>
      ))}
    </ol>
  );
}

export function CommandBlock({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="command">
      <code>{command}</code>
      <button
        type="button"
        className="ghost icon-only"
        aria-label={copied ? 'Copied' : 'Copy command'}
        title={copied ? 'Copied' : 'Copy'}
        onClick={() => {
          navigator.clipboard.writeText(command);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check size={14} /> : <CopyIcon size={14} />}
      </button>
    </div>
  );
}
