import fs from 'node:fs';
import path from 'node:path';
import type { AgentStatus, FixStep } from '@quack/shared';
import { findBinary, run } from '../exec.ts';
import { log } from '../log.ts';
import { QUACK_DIR } from '../paths.ts';
import { type AcpModel, askAcp, closeAcpSession, closeAllAcpSessions, probeAcpModels } from './acp.ts';
import { stripAnsi } from './stream.ts';
import type { Adapter, AskOpts } from './types.ts';

const INSTALL: FixStep = { text: 'Install the Cursor CLI', command: 'curl https://cursor.com/install -fsS | bash' };
const RECHECK: FixStep = { text: 'Then press Re-check.' };

// Shown when the model list can't be read from the CLI.
const FALLBACK_MODELS = ['', 'auto', 'gpt-5', 'sonnet-4', 'sonnet-4-thinking'];

interface Cli {
  bin: string;
  name: string;
  version: string;
  /** Can run as an Agent Client Protocol server (`<bin> acp`), which Quack requires. */
  acp: boolean;
}

async function findCli(): Promise<Cli | null> {
  const bin = findBinary(['cursor-agent', 'agent']);
  if (!bin) return null;
  // `acp` is missing from the main help, so ask the subcommand itself.
  const [version, help, acpHelp] = await Promise.all([
    run(bin, ['--version'], { timeoutMs: 15_000 }),
    run(bin, ['--help'], { timeoutMs: 15_000 }),
    run(bin, ['acp', '--help'], { timeoutMs: 15_000 }),
  ]);
  if (path.basename(bin) === 'agent' && !/cursor/i.test(help.stdout + help.stderr)) return null;
  return {
    bin,
    name: path.basename(bin),
    version: version.stdout.trim(),
    acp: /Agent Client Protocol/i.test(acpHelp.stdout + acpHelp.stderr),
  };
}

async function loggedIn(cli: Cli): Promise<boolean> {
  if (process.env.CURSOR_API_KEY) return true;
  const res = await run(cli.bin, ['status'], { timeoutMs: 20_000 });
  const out = stripAnsi(res.stdout + res.stderr);
  if (/not logged in|not authenticated/i.test(out)) return false;
  return /logged in|authenticated as|signed in/i.test(out);
}

const MODEL_CACHE = path.join(QUACK_DIR, 'cursor-models.json');
const MODEL_CACHE_MS = 24 * 60 * 60_000;

function readModelCache(): { at: number; ids: string[] } | null {
  try {
    const c = JSON.parse(fs.readFileSync(MODEL_CACHE, 'utf8'));
    return typeof c.at === 'number' && Array.isArray(c.ids) ? c : null;
  } catch {
    return null;
  }
}

function rememberModels(models: AcpModel[]): void {
  try {
    fs.writeFileSync(MODEL_CACHE, JSON.stringify({ at: Date.now(), ids: models.map((m) => m.id) }));
  } catch (err) {
    log('could not cache Cursor models:', String(err));
  }
}

/** ACP names models without the CLI's effort variants, e.g. `gpt-5.6-luna`. */
async function models(cli: Cli): Promise<string[]> {
  const cached = readModelCache();
  if (cached && Date.now() - cached.at < MODEL_CACHE_MS) return ['', ...cached.ids];
  try {
    const dir = path.join(QUACK_DIR, 'model-probe');
    fs.mkdirSync(dir, { recursive: true });
    const list = await probeAcpModels(cli.bin, dir);
    if (list.length) {
      rememberModels(list);
      return ['', ...list.map((m) => m.id)];
    }
  } catch (err) {
    log('could not list Cursor models over ACP:', (err as Error).message);
  }
  return cached ? ['', ...cached.ids] : FALLBACK_MODELS;
}

export const cursorAdapter: Adapter = {
  id: 'cursor',
  label: 'Cursor',

  async isAvailable(): Promise<AgentStatus> {
    const cli = await findCli();
    if (!cli) {
      return { id: 'cursor', label: 'Cursor', state: 'not_installed', models: [], fixSteps: [INSTALL, { text: 'Log in', command: 'cursor-agent login' }, RECHECK] };
    }
    if (!cli.acp) {
      return {
        id: 'cursor',
        label: 'Cursor',
        state: 'not_installed',
        version: cli.version,
        models: [],
        fixSteps: [{ text: `Cursor CLI ${cli.version} is too old for Quack. Update it`, command: `${cli.name} update` }, RECHECK],
      };
    }
    const [isLoggedIn, list] = await Promise.all([loggedIn(cli), models(cli)]);
    if (!isLoggedIn) {
      return {
        id: 'cursor',
        label: 'Cursor',
        state: 'not_logged_in',
        version: cli.version,
        models: list,
        fixSteps: [{ text: 'Log in to the Cursor CLI (opens your browser)', command: `${cli.name} login` }, RECHECK],
      };
    }
    return { id: 'cursor', label: 'Cursor', state: 'ready', version: cli.version, models: list, fixSteps: [] };
  },

  async *ask(opts: AskOpts) {
    const cli = await findCli();
    if (!cli?.acp) {
      yield { type: 'error', message: cli ? 'This Cursor CLI is too old for Quack. Update it and try again.' : 'Cursor CLI not found.' };
      return;
    }
    yield* askAcp(cli.bin, opts, rememberModels);
  },

  closeSession: closeAcpSession,
  shutdown: closeAllAcpSessions,
};
