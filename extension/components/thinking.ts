/**
 * Rotating "thinking" headlines. They are decoration
 * only: the factual activity lines underneath carry the meaning, so the
 * headline is hidden from screen readers.
 */

export type Phase = 'waking' | 'preparing' | 'searching' | 'reading' | 'thinking' | 'writing' | 'slow' | 'ci';

export const PHASE_MESSAGES: Record<Phase, string[]> = {
  waking: [
    'Waking the duck. It is not a morning duck.',
    'Finding the pond.',
    'Counting ducks. One. Good.',
    'Clearing its throat.',
    'Coffee for the duck. Decaf. It’s a duck.',
    'Stretching wings. Mostly for show.',
    'Fluffing feathers. Professionally.',
  ],
  preparing: [
    'Filling the pond…',
    'Checking out the branch. Quietly.',
    'Lining up the ducks…',
    'Starting {agent}. The duck supervises.',
    'Fetching commits. Ducks don’t fetch, but okay.',
    'Laying out the worktree. Like an egg, but useful.',
    'Getting its ducks in a row. Literally.',
  ],
  searching: [
    'Rummaging through the reeds…',
    'Dabbling through {n} matches…',
    'Following a paper trail of imports…',
    'Looking for something that already does this.',
    'Grepping. Ducks call it foraging.',
    'Bottoms up. Searching the deep end.',
    'Checking if someone wrote this in 2019.',
    'Hunting for the other caller.',
  ],
  reading: [
    'Reading {file}. Judgmentally.',
    'Paddling through {n} files…',
    'Skimming. Ducks are good at skimming.',
    'Reading the tests. Someone has to.',
    'Reading {file}. Raising one eyebrow.',
    'Reading the comments. Trusting none of them.',
    'Following the types upstream…',
    'Reading git blame. No names, just vibes.',
  ],
  thinking: [
    'Thinking it over, mostly in quacks.',
    'Rubber-ducking your code back at you…',
    'Connecting dots. And dots to dots.',
    'Mulling. Ducks mull.',
    'Staring at the code until it confesses.',
    'Weighing edge cases. They’re heavier than they look.',
    'Considering nulls. Someone always forgets the nulls.',
    'Calm on the surface, paddling hard below.',
  ],
  writing: [
    'Drafting an answer. Feathers may ruffle.',
    'Putting it in words a reviewer would sign.',
    'Citing line numbers, like a pro.',
    'Almost there. Smoothing the feathers.',
    'Cutting the fluff. Ducks know fluff.',
    'Fewer words, more line numbers.',
    'Writing it down before it waddles off.',
  ],
  slow: [
    'Still paddling. Big diff, small duck.',
    'This one has depth. The duck dove in.',
    'Worth the wait, probably. Esc to stop.',
    'Still here. Still quacking.',
    'Long PR. The duck packed a snack.',
    'Taking the scenic route through the pond.',
    'Not stuck. Thorough. Esc if you disagree.',
  ],
  ci: [
    'Reading the build log so you don’t have to…',
    'Following the stack trace downstream…',
    'Asking the tests what upset them.',
    'Checking if it’s you or it’s flaky.',
    'Scrolling past 4,000 lines of npm warnings…',
    'Was it green yesterday? Checking.',
    'Blaming the runner. Provisionally.',
  ],
};

export const SLOW_AFTER_MS = 30_000;
export const ROTATE_MS = 3500;

export interface PhaseInput {
  preparing: boolean;
  activity: string[];
  text: string;
  elapsedMs: number;
  /** Set while a "Check CI" answer is running, before it starts writing. */
  task?: 'explain_ci';
}

export function pickPhase({ preparing, activity, text, elapsedMs, task }: PhaseInput): Phase {
  if (elapsedMs >= SLOW_AFTER_MS) return 'slow';
  if (preparing) return 'preparing';
  if (task === 'explain_ci' && !text) return 'ci';
  if (text) return 'writing';
  const last = activity.at(-1) ?? '';
  if (last.startsWith('Search')) return 'searching';
  if (last.startsWith('Read')) return 'reading';
  return 'thinking';
}

export interface Fill {
  agent: string;
  activity: string[];
}

const matchCount = (line: string) => Number(/(\d+) match/.exec(line)?.[1] ?? NaN);
const fileOf = (line: string) => /^Read\s+(\S+)/.exec(line)?.[1]?.split('/').at(-1);

/** Messages for a phase whose placeholders can be filled from real data. */
export function messagesFor(phase: Phase, { agent, activity }: Fill): string[] {
  const reads = activity.filter((a) => a.startsWith('Read '));
  const last = activity.at(-1) ?? '';
  const matches = matchCount(last);
  const file = fileOf(last);
  return PHASE_MESSAGES[phase].flatMap((m) => {
    if (m.includes('{n}')) {
      const n = phase === 'searching' ? matches : reads.length;
      if (!Number.isFinite(n) || n < 2) return [];
      m = m.replace('{n}', String(n));
    }
    if (m.includes('{file}')) {
      if (!file) return [];
      m = m.replace('{file}', file);
    }
    return [m.replace('{agent}', agent)];
  });
}

/** A random message, never the same as the previous one. */
export function nextMessage(options: string[], previous?: string): string {
  const pool = options.length > 1 ? options.filter((m) => m !== previous) : options;
  return pool[Math.floor(Math.random() * pool.length)] ?? '';
}
