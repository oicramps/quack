import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { prepareWorktree, unlinkEscapingSymlinks } from '../src/worktree.ts';

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Quack Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Quack Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
};

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

test('checking out a PR worktree does not run its post-checkout hook', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quack-hooks-'));
  const repo = path.join(root, 'repo');
  const wt = path.join(root, 'wt');
  const marker = path.join(root, 'marker');
  try {
    fs.mkdirSync(repo);
    git(repo, ['init', '-q', '-b', 'main']);
    fs.mkdirSync(path.join(repo, '.husky'));
    fs.writeFileSync(path.join(repo, '.husky', 'post-checkout'), `#!/bin/sh\necho ran >> "${marker}"\n`, { mode: 0o755 });
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'Quack Test']);
    git(repo, ['config', 'core.hooksPath', '.husky']);
    git(repo, ['add', '.husky']);
    git(repo, ['commit', '-q', '-m', 'base']);
    const base = git(repo, ['rev-parse', 'HEAD']).trim();
    fs.writeFileSync(path.join(repo, 'file'), 'pr\n');
    git(repo, ['add', 'file']);
    git(repo, ['commit', '-q', '-m', 'pr']);
    const head = git(repo, ['rev-parse', 'HEAD']).trim();

    await prepareWorktree(repo, wt, head);
    await prepareWorktree(repo, wt, base);
    assert.equal(fs.existsSync(marker), false);

    git(wt, ['checkout', '--detach', '--quiet', head]);
    assert.equal(fs.readFileSync(marker, 'utf8').includes('ran'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('symlinks that resolve outside the worktree are removed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quack-links-'));
  const repo = path.join(root, 'repo');
  try {
    fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'readme'), 'hello\n');
    fs.symlinkSync('readme', path.join(repo, 'inside'));
    fs.symlinkSync('../readme', path.join(repo, 'docs', 'up'));
    fs.symlinkSync('/etc/passwd', path.join(repo, 'outside'));
    fs.symlinkSync(path.join(root, 'secret'), path.join(repo, 'sneak'));
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'Quack Test']);
    git(repo, ['add', '--', 'readme', 'inside', 'docs/up', 'outside', 'sneak']);
    git(repo, ['commit', '-q', '-m', 'links']);

    const removed = await unlinkEscapingSymlinks(repo);
    assert.equal(removed, 2);
    assert.equal(fs.existsSync(path.join(repo, 'inside')), true);
    assert.equal(fs.existsSync(path.join(repo, 'docs', 'up')), true);
    assert.equal(fs.existsSync(path.join(repo, 'outside')), false);
    assert.equal(fs.existsSync(path.join(repo, 'sneak')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
