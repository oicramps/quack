import { createRoot } from 'react-dom/client';
import type { AgentEvent, BackendStatus, CompanionMessage, ExtensionMessage, ProgressStep } from '@quack/shared';
import { QUACK_VERSION } from '@quack/shared';
import '../components/panel.css';
import { Panel } from '../components/Panel';
import type { CompanionClient } from '../lib/client';
import type { PanelPage } from '../lib/page';
import { seedStorage } from './mockBrowser';

const params = new URLSearchParams(location.search);
const scenario = params.get('scenario') ?? 'done';
document.body.dataset.theme = params.get('theme') === 'dark' ? 'dark' : 'light';

const SHA = '44b360d9c1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6';

const backends: BackendStatus[] = [
  { id: 'cursor', label: 'Cursor', state: 'ready', version: '2025.08.15', models: ['', 'auto', 'gpt-5', 'sonnet-4', 'sonnet-4-thinking'], fixSteps: [] },
  {
    id: 'claude-code',
    label: 'Claude Code',
    state: 'not_installed',
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

### Suggestion

Keep the plugin and drop the duplicate keys from the config:

\`\`\`js mobile/app.config.ts
android: {
  enableProguardInReleaseBuilds: true,
},
\`\`\`
`;

type Script = { at: number; msg: (requestId: string) => CompanionMessage | 'disconnect' }[];

const progress = (step: ProgressStep, at: number, detail?: string) => ({
  at,
  msg: (requestId: string): CompanionMessage => ({ type: 'progress', requestId, step, detail }),
});
const event = (ev: AgentEvent, at: number) => ({ at, msg: (requestId: string): CompanionMessage => ({ type: 'event', requestId, event: ev }) });
const PREP = [progress('finding_repo', 10), progress('fetching_pr', 60), progress('preparing_worktree', 900, SHA), progress('starting_agent', 1000, 'Cursor')];
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
  streaming: [...PREP, ...TOOLS, ...chunks(ANSWER.slice(0, 260), 1600)],
  done: [...PREP, ...TOOLS, ...chunks(ANSWER, 1600), event({ type: 'done', sessionId: 's1', headSha: SHA, model: 'auto' }, 2400)],
  error: [
    ...PREP,
    ...TOOLS.slice(0, 2),
    event({ type: 'error', code: 'timeout', message: 'No response for 5 min while reading the repo. The worktree is fine; retrying usually works.' }, 1700),
  ],
};

class FakeClient {
  private disconnect = new Set<(error: string, ids: string[]) => void>();
  send(message: ExtensionMessage, listener?: (m: CompanionMessage) => void) {
    if (scenario === 'offline') {
      setTimeout(() => this.disconnect.forEach((l) => l('Specified native messaging host not found.', [message.requestId])), 10);
      return;
    }
    if (message.type === 'status') {
      setTimeout(() => listener?.({ type: 'status', requestId: message.requestId, version: QUACK_VERSION, backends }), 10);
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

seedStorage({ 'quack.prefs': { backend: scenario === 'not-installed' ? 'claude-code' : 'cursor', models: { cursor: 'auto' } } });

const selection = { path: 'mobile/plugins/withReleaseOptimizations.js', startLine: 15, endLine: 30, side: 'new' as const };
const page: PanelPage = {
  pr: { owner: 'ProjetoParcas', repo: 'mynah', number: 14, title: 'Local release APK build with release optimizations', baseRef: 'main', headRef: 'cursor/local-release-apk' },
  lastSelection: selection,
  theme: document.body.dataset.theme as 'light' | 'dark',
  attachRequest: { seq: ['selection', 'preparing', 'streaming', 'done', 'error'].includes(scenario) ? 1 : 0, selection },
};

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
  if (scripts[scenario]) await type('Does this duplicate anything we already have?', true);
  if (scenario === 'backend-menu') document.querySelector<HTMLButtonElement>('[aria-label="AI backend"]')?.click();
  if (scenario === 'model-menu') document.querySelector<HTMLButtonElement>('[aria-label="Model"]')?.click();
})();
