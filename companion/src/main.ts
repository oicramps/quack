import { HOST_NAME, QUACK_VERSION } from '@quacksteps/shared';
import { adapters } from './adapters/index.ts';
import { loadConfig } from './config.ts';
import { startHost } from './host.ts';
import { install, uninstall } from './install.ts';
import { findClone, linkClone } from './repo.ts';
import { enforceRetention } from './worktree.ts';

const [arg] = process.argv.slice(2);

async function main(): Promise<void> {
  // Chrome passes the caller's origin as the first argument.
  if (arg?.startsWith('chrome-extension://')) {
    startHost(arg);
    return;
  }
  // Firefox passes the host manifest's path, then the add-on id.
  const firefoxId = process.argv[3];
  if (arg?.endsWith(`${HOST_NAME}.json`) && firefoxId) {
    startHost(firefoxId);
    return;
  }
  switch (arg) {
    case 'install':
      install(process.argv[1], { dev: process.argv.includes('--dev') });
      break;
    case 'uninstall':
      uninstall();
      break;
    case 'link': {
      const target = process.argv[3] ?? '.';
      const ownerRepo = process.argv[4];
      const linked = await linkClone(target, ownerRepo);
      console.log(`Linked ${linked.key} -> ${linked.path} in ~/.quack/config.json`);
      break;
    }
    case 'prune': {
      const config = loadConfig();
      const removed = await enforceRetention(config, (owner, repo) => findClone(config, owner, repo));
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
  quack-companion install [--dev]            Register the native messaging host for Chrome, Edge, Brave, Chromium, and Firefox
                                             --dev also allows the unpacked extension id
  quack-companion uninstall                  Remove the host registration
  quack-companion link [path] [owner/repo]   Map an existing local clone in ~/.quack/config.json
  quack-companion prune                      Delete PR worktrees past retentionDays, then the oldest past maxWorktrees
  quack-companion doctor                     Print config and agent readiness

The browser starts the companion itself; you never need to run it in a terminal.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
