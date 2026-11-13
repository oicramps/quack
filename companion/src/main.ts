import { QUACK_VERSION } from '@quack/shared';
import { adapters } from './adapters/index.ts';
import { loadConfig } from './config.ts';
import { startHost } from './host.ts';
import { install, uninstall } from './install.ts';
import { findClone } from './repo.ts';
import { pruneAll } from './worktree.ts';

const [arg] = process.argv.slice(2);

async function main(): Promise<void> {
  // Chrome passes the caller's origin as the first argument.
  if (arg?.startsWith('chrome-extension://')) {
    startHost(arg);
    return;
  }
  switch (arg) {
    case 'install':
      install(process.argv[1]);
      break;
    case 'uninstall':
      uninstall();
      break;
    case 'prune': {
      const config = loadConfig();
      const removed = await pruneAll(config, (owner, repo) => findClone(config, owner, repo));
      console.log(removed.length ? `Removed:\n${removed.join('\n')}` : 'No worktrees to remove.');
      break;
    }
    case 'doctor': {
      const statuses = await Promise.all(Object.values(adapters).map((a) => a.isAvailable()));
      console.log(JSON.stringify({ version: QUACK_VERSION, config: loadConfig(), agents: statuses }, null, 2));
      break;
    }
    case '--version':
      console.log(QUACK_VERSION);
      break;
    default:
      console.log(`quack-companion ${QUACK_VERSION}

Usage:
  quack-companion install     Register the native messaging host for Chrome, Edge and Chromium
  quack-companion uninstall   Remove the host registration
  quack-companion prune       Remove all Quack worktrees and their refs/pr-review refs
  quack-companion doctor      Print config and agent readiness

The browser starts the companion itself; you never need to run it in a terminal.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
