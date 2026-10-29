import type { CodeSelection } from '@quack/shared';

export interface PromptInput {
  owner: string;
  repo: string;
  prNumber: number;
  title: string;
  body: string;
  baseSha: string;
  headSha: string;
  diff: string;
  diffTruncated: boolean;
  selections: CodeSelection[];
  question: string;
  guidelines?: string;
}

const RULES = [
  'You are helping a reviewer understand a pull request. The working directory is the whole repository checked out at the PR head commit.',
  'Do not create, modify or delete any files, and do not run commands that change state. Only read and search.',
  "Before saying something doesn't exist in the codebase, search the repository for it.",
  'Cite code as `path:line` (for example `src/utils/date.ts:112`), with paths relative to the repository root.',
  'Be concise. Lead with the answer.',
];

function describeSelection(s: CodeSelection): string {
  const where = s.path
    ? `${s.path}${s.startLine ? ` lines ${s.startLine}${s.endLine && s.endLine !== s.startLine ? `-${s.endLine}` : ''}` : ''}`
    : 'Selected code (file unknown)';
  return s.text ? `${where}:\n\`\`\`\n${s.text}\n\`\`\`` : where;
}

function selectionBlock(selections: CodeSelection[]): string {
  if (!selections.length) return 'No code is selected: the question is about the whole PR.';
  return `The reviewer selected this code in the PR diff:\n\n${selections.map(describeSelection).join('\n\n')}`;
}

export function buildPrompt(input: PromptInput): string {
  const parts = [
    `# Instructions\n\n${RULES.map((r) => `- ${r}`).join('\n')}`,
    `# Pull request\n\n${input.owner}/${input.repo}#${input.prNumber}: ${input.title}\nBase ${input.baseSha.slice(0, 12)}, head ${input.headSha.slice(0, 12)}.`,
  ];
  if (input.body.trim()) parts.push(`## Description\n\n${input.body.trim().slice(0, 8000)}`);
  if (input.guidelines?.trim()) parts.push(`# Team review guidelines\n\n${input.guidelines.trim()}`);
  parts.push(
    `# Diff (git diff base...head)\n\n\`\`\`diff\n${input.diff}\n\`\`\`` +
      (input.diffTruncated ? '\n\nThe diff was truncated; read the changed files directly for the rest.' : ''),
  );
  parts.push(`# Context\n\n${selectionBlock(input.selections)}`);
  parts.push(`# Question\n\n${input.question.trim()}`);
  return parts.join('\n\n');
}

/** Follow-ups resume the agent session, which already has the PR context. */
export function buildFollowUp(selections: CodeSelection[], question: string): string {
  // Leading text also keeps a question like "-v?" from being read as a CLI flag.
  const parts = ['Follow-up from the reviewer.'];
  if (selections.length) parts.push(selectionBlock(selections));
  parts.push(question.trim());
  parts.push('Reminder: read-only, search before claiming something is missing, cite code as `path:line`.');
  return parts.join('\n\n');
}
