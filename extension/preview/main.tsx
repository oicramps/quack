import { createRoot } from 'react-dom/client';
import type { AgentEvent, AgentStatus, CompanionMessage, ExtensionMessage, ProgressStep } from '@quack/shared';
import { PROTOCOL_VERSION, QUACK_VERSION } from '@quack/shared';
import '../components/panel.css';
import { Panel } from '../components/Panel';
import type { CompanionClient } from '../lib/client';
import type { PanelPage } from '../lib/page';
import { seedStorage } from './mockBrowser';

const params = new URLSearchParams(location.search);
const scenario = params.get('scenario') ?? 'done';
document.body.dataset.theme = params.get('theme') === 'dark' ? 'dark' : 'light';

const SHA = '44b360d9c1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6';
const NEWER_SHA = '7be03f1a2b3c4d5e6f708192a3b4c5d6e7f80912';
/** Scenarios that start from a finished answer, then act on it. */
const AFTER_DONE = ['stale', 'draft', 'posted', 'switch'];
const bothReady = ['error-timeout', 'switch'].includes(scenario);

const agents: AgentStatus[] = [
  { id: 'cursor', label: 'Cursor', state: 'ready', version: '2025.08.15', models: ['', 'auto', 'gpt-5', 'sonnet-4', 'sonnet-4-thinking'], fixSteps: [] },
  {
    id: 'claude-code',
    label: 'Claude Code',
    state: bothReady ? 'ready' : 'not_installed',
    models: ['sonnet', 'opus', 'haiku'],
    fixSteps: [
      { text: 'Install Claude Code', command: 'curl -fsSL https://claude.ai/install.sh | bash' },
      { text: 'Log in: run Claude Code once and complete the browser sign-in, then quit it', command: 'claude' },
      { text: 'Then press Recheck.' },
    ],
  },
];

const ANSWER = `**Yes — this mostly duplicates an existing setting.**

The Expo config already enables minification through \`app.config.ts:41\`, and \`mobile/plugins/withReleaseOptimizations.js:15\` sets the same Gradle properties again.

Differences from the new plugin:

- It only runs during \`expo prebuild\`, so it survives \`--clean\`.
- It also turns on \`org.gradle.caching\`, which the config doesn't.

| Property | Effect |
|---|---|
| \`android.enableMinifyInReleaseBuilds=true\` | Turns on \`minifyEnabled\` for release builds, so R8 shrinks the bytecode. |
| \`org.gradle.caching=true\` | Gradle's build cache. Doesn't change the APK. |

### Suggestion

Keep the plugin and drop the duplicate keys from the config:

\`\`\`js mobile/plugins/gradleProperties.js
// Shared by every plugin that edits gradle.properties
function setGradleProperty(props, key, value) {
  const existing = props.find((item) => item.type === 'property' && item.key === key);
  if (existing) {
    existing.value = value;
  } else {
    props.push({ type: 'property', key, value: String(42) });
  }
}

module.exports = { setGradleProperty };
\`\`\`
`;

type Script = { at: number; msg: (requestId: string) => CompanionMessage | 'disconnect' }[];

const progress = (step: ProgressStep, at: number, detail?: string) => ({
  at,
  msg: (requestId: string): CompanionMessage => ({ type: 'progress', requestId, step, detail }),
});
const event = (ev: AgentEvent, at: number) => ({ at, msg: (requestId: string): CompanionMessage => ({ type: 'event', requestId, event: ev }) });
const PREP = [progress('finding_repo', 10), progress('fetching_pr', 60), progress('preparing_worktree', 900, SHA), progress('starting_agent', 1000, 'Cursor')];
const CI_PREP = [progress('finding_repo', 10), progress('fetching_pr', 60), progress('preparing_worktree', 900, SHA), progress('fetching_ci', 950), progress('starting_agent', 1000, 'Cursor')];
const FAILING_CHECKS = [
  { name: 'test / unit (node 20)', workflow: 'CI', link: 'https://github.com/ProjetoParcas/mynah/actions/runs/100/job/200', runId: '100', jobId: '200' },
  { name: 'e2e / billing', workflow: 'CI', link: 'https://github.com/ProjetoParcas/mynah/actions/runs/100/job/201', runId: '100', jobId: '201' },
];
const CI_FINDINGS = [
  {
    check: 'test / unit (node 20)',
    verdict: 'caused_by_pr',
    summary:
      '`DELETE /invoices/:id` expected **204**, got **403**. The new `billing:delete` permission at `src/auth/permissions.ts:42` isn’t in the admin fixture at `test/fixtures/roles.ts:18`.',
    refs: [
      { path: 'src/auth/permissions.ts', line: 42 },
      { path: 'test/fixtures/roles.ts', line: 18 },
    ],
    fix: {
      path: 'test/fixtures/roles.ts',
      patch: "// test/fixtures/roles.ts\nadmin: [\n  'billing:read',\n  'billing:write',\n+ 'billing:delete',\n],",
    },
  },
  {
    check: 'e2e / billing',
    verdict: 'flaky',
    summary: 'Timed out waiting for the PDF preview. Same step failed in 3 of the last 20 runs on `main`; nothing in this diff touches it.',
    refs: [],
  },
];
const CI_ANSWER = `**One real failure, one flake.** The unit test broke because of this PR; the e2e job has been wobbly on main all week.

\`\`\`quack-ci
${JSON.stringify(CI_FINDINGS, null, 2)}
\`\`\`
`;
const TOOLS = [
  event({ type: 'tool', summary: 'Searched repo for enableMinifyInReleaseBuilds' }, 1200),
  event({ type: 'tool', summary: 'Read mobile/app.config.ts' }, 1300),
  event({ type: 'tool', summary: 'Searched repo for withGradleProperties' }, 1400),
  event({ type: 'tool', summary: 'Read mobile/plugins/withReleaseOptimizations.js' }, 1500),
];
const chunks = (text: string, from: number) =>
  text.match(/[\s\S]{1,40}/g)!.map((delta, i) => event({ type: 'text', delta }, from + i * 5));

const scripts: Record<string, Script> = {
  preparing: PREP.slice(0, 3),
  thinking: [...PREP, progress('thinking', 1100)],
  streaming: [...PREP, ...TOOLS, ...chunks(ANSWER.slice(0, 260), 1600)],
  done: [...PREP, ...TOOLS, ...chunks(ANSWER, 1600), event({ type: 'done', sessionId: 's1', headSha: SHA, model: 'auto' }, 2400)],
  error: [
    ...PREP,
    ...TOOLS.slice(0, 2),
    event({ type: 'error', code: 'timeout', message: 'No response for 5 min while reading the repo. The worktree is fine; retrying usually works.' }, 1700),
  ],
  'explain-ci': [
    ...CI_PREP,
    progress('thinking', 1100),
    ...chunks(CI_ANSWER, 1200),
    event({ type: 'done', sessionId: 's1', headSha: SHA, model: 'sonnet' }, 2200),
  ],
  'error-timeout': [
    ...PREP,
    ...TOOLS.slice(0, 2),
    event({ type: 'error', code: 'timeout', message: 'Cursor timed out reading the repo. Retrying usually works.' }, 1700),
  ],
};
for (const s of AFTER_DONE) scripts[s] = scripts.done;

class FakeClient {
  private disconnect = new Set<(error: string, ids: string[]) => void>();
  send(message: ExtensionMessage, listener?: (m: CompanionMessage) => void) {
    if (scenario === 'offline' || scenario === 'no-pr-offline') {
      setTimeout(() => this.disconnect.forEach((l) => l('Specified native messaging host not found.', [message.requestId])), 10);
      return;
    }
    if (message.type === 'status') {
      const reply = (list: AgentStatus[], pending: AgentStatus['id'][]) =>
        listener?.({
          type: 'status',
          requestId: message.requestId,
          version: scenario === 'outdated' ? '0.1.0' : QUACK_VERSION,
          protocol: PROTOCOL_VERSION,
          agents: list,
          pending,
        });
      setTimeout(() => reply([], ['cursor', 'claude-code']), 10);
      // "loading" stays on the companion's first, partial answer.
      if (scenario !== 'loading') setTimeout(() => reply(agents, []), 20);
    } else if (message.type === 'checks') {
      const show = scenario === 'empty-ci' || scenario === 'explain-ci';
      listener?.({ type: 'checks', requestId: message.requestId, available: true, failing: show ? FAILING_CHECKS : [] });
    } else if (message.type === 'ask') {
      for (const step of scripts[scenario] ?? []) {
        setTimeout(() => {
          const m = step.msg(message.requestId);
          if (m !== 'disconnect') listener?.(m);
        }, step.at);
      }
    } else if (message.type === 'cancel') {
      listener?.({ type: 'event', requestId: message.requestId, event: { type: 'error', code: 'cancelled', message: 'Stopped.' } });
    }
  }
  forget() {}
  onDisconnect(l: (error: string, ids: string[]) => void) {
    this.disconnect.add(l);
    return () => this.disconnect.delete(l);
  }
}

seedStorage({
  'quack.prefs': { agent: scenario === 'not-installed' ? 'claude-code' : 'cursor', models: { cursor: 'auto', 'claude-code': 'sonnet' } },
  'quack.recent': [
    { owner: 'ProjetoParcas', repo: 'mynah', number: 14, title: 'Local release APK build with release optimizations', questions: 2, at: Date.now() - 3_600_000 },
    { owner: 'ProjetoParcas', repo: 'mynah', number: 11, title: 'Move settings page to the new form API', questions: 4, at: Date.now() - 26 * 3_600_000 },
    { owner: 'ProjetoParcas', repo: 'api', number: 213, title: 'Fix flaky retry test in upload queue', questions: 1, at: Date.now() - 4 * 86_400_000 },
  ],
});

const selection = { path: 'mobile/plugins/withReleaseOptimizations.js', startLine: 15, endLine: 30, side: 'new' as const };
const noSelection = ['empty', 'empty-ci', 'explain-ci', 'loading'].includes(scenario);
const page: PanelPage = {
  tabId: 1,
  pr:
    scenario === 'no-pr' || scenario === 'no-pr-offline'
      ? null
      : {
          owner: 'ProjetoParcas',
          repo: 'mynah',
          number: 14,
          title: 'Local release APK build with release optimizations',
          baseRef: 'main',
          headRef: 'cursor/local-release-apk',
          headSha: SHA,
          latestSha: scenario === 'stale' ? NEWER_SHA : SHA,
          commits: 3,
          files: 2,
          additions: 25,
          deletions: 3,
        },
  lastSelection: noSelection ? null : selection,
  theme: document.body.dataset.theme as 'light' | 'dark',
  attachRequest: { seq: scenario === 'selection' || (Boolean(scripts[scenario]) && scenario !== 'explain-ci') ? 1 : 0, selection },
};

// The preview isn't focused when screenshotted, so the real clipboard would refuse.
Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text: string) => console.log('copied', text.length) } });

createRoot(document.getElementById('root')!).render(<Panel page={page} client={new FakeClient() as unknown as CompanionClient} />);

// Drive the UI like a user would.
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function type(text: string, send: boolean) {
  const textarea = document.querySelector('textarea')!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, text);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  if (send) {
    await wait(20);
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }
}

(async () => {
  await wait(150);
  if (scenario === 'selection') await type('Does this duplicate anything we already have?', false);
  if (scenario === 'explain-ci') {
    await wait(400);
    [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Check CI')?.click();
  } else if (scripts[scenario]) await type('Does this duplicate anything we already have?', true);
  const click = (text: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim().startsWith(text))?.click();
  if (AFTER_DONE.includes(scenario)) await wait(2600);
  if (scenario === 'draft' || scenario === 'posted') click('Post as review comment');
  if (scenario === 'posted') {
    await wait(50);
    click('Copy and open in GitHub');
  }
  if (scenario === 'switch') {
    document.querySelector<HTMLButtonElement>('[aria-label="Agent"]')?.click();
    await wait(50);
    click('Claude Code');
    await type('And are the tests covering it?', true);
  }
  if (scenario === 'agent-menu') document.querySelector<HTMLButtonElement>('[aria-label="Agent"]')?.click();
  if (scenario === 'model-menu') document.querySelector<HTMLButtonElement>('[aria-label="Model"]')?.click();
})();
