import { useState } from 'react';
import type { FixStep } from '@quack/shared';

export function FixSteps({ steps }: { steps: FixStep[] }) {
  return (
    <ol className="fix-steps">
      {steps.map((step, i) => (
        <li key={i}>
          <span>{step.text}</span>
          {step.command && <CopyCommand command={step.command} />}
        </li>
      ))}
    </ol>
  );
}

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="command">
      <code>{command}</code>
      <button
        className="link small"
        onClick={() => {
          navigator.clipboard.writeText(command);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
