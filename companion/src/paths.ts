import os from 'node:os';
import path from 'node:path';

export const HOME = os.homedir();
export const QUACK_DIR = path.join(HOME, '.quack');
export const CONFIG_FILE = path.join(QUACK_DIR, 'config.json');
export const LOG_FILE = path.join(QUACK_DIR, 'logs', 'companion.log');
export const BIN_DIR = path.join(QUACK_DIR, 'bin');

// Chrome starts native hosts with launchd's minimal PATH, so tools installed by
// Homebrew, npm or the vendors' install scripts are searched for explicitly.
export const EXTRA_BIN_DIRS = [
  path.join(HOME, '.local', 'bin'),
  path.join(HOME, '.claude', 'local'),
  path.join(HOME, '.npm-global', 'bin'),
  path.join(HOME, '.volta', 'bin'),
  path.join(HOME, '.bun', 'bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
];

export function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(HOME, p.slice(1)) : p;
}
