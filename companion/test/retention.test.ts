import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { Config } from '../src/config.ts';
import { enforceRetention, prRef } from '../src/worktree.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

function git(args: string[]): void {
  execFileSync('git', args, { stdio: 'ignore' });
}

function hasRef(clone: string, name: string): boolean {
  try {
    execFileSync('git', ['-C', clone, 'show-ref', '--verify', '--quiet', name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('retention deletes old and excess worktrees only under the worktree root', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quack-retention-'));
  const clone = path.join(root, 'clone');
  const worktreeRoot = path.join(root, 'worktrees');
  const repoDir = path.join(worktreeRoot, 'acme', 'widgets');
  const pr1 = path.join(repoDir, 'pr-1');
  const pr2 = path.join(repoDir, 'pr-2');
  const pr3 = path.join(repoDir, 'pr-3');
  const outside = path.join(root, 'outside');
  const secret = path.join(root, 'secret-outside');
  const escaped = path.join(root, 'escaped');
  const now = Date.now();
  const calls: string[] = [];
  try {
    git(['init', '-q', clone]);
    git(['-C', clone, '-c', 'user.email=quack@example.com', '-c', 'user.name=Quack', 'commit', '--allow-empty', '-m', 'init']);
    fs.mkdirSync(repoDir, { recursive: true });
    for (const [dir, n] of [
      [pr1, 1],
      [pr2, 2],
      [pr3, 3],
    ] as const) {
      git(['-C', clone, 'worktree', 'add', '--detach', '--quiet', dir, 'HEAD']);
      git(['-C', clone, 'update-ref', prRef(n), 'HEAD']);
    }
    fs.writeFileSync(path.join(repoDir, 'notes.txt'), 'keep');
    fs.utimesSync(pr1, now / 1000, (now - 8 * DAY_MS) / 1000);
    fs.utimesSync(pr2, now / 1000, (now - 2 * DAY_MS) / 1000);
    fs.utimesSync(pr3, now / 1000, (now - 60 * 60 * 1000) / 1000);

    fs.mkdirSync(secret);
    fs.writeFileSync(path.join(secret, 'keep.txt'), 'keep');
    fs.symlinkSync(secret, path.join(repoDir, 'pr-9'));

    fs.mkdirSync(path.join(escaped, 'pr-99'), { recursive: true });
    fs.writeFileSync(path.join(escaped, 'pr-99', 'keep.txt'), 'keep');
    fs.symlinkSync(escaped, path.join(worktreeRoot, 'linked-owner'));

    fs.mkdirSync(path.join(outside, 'pr-1'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'pr-1', 'keep.txt'), 'keep');

    const config: Config = {
      scanRoots: [],
      repoPaths: {},
      worktreeRoot,
      retentionDays: 7,
      maxWorktrees: 2,
    };
    const removed = await enforceRetention(
      config,
      async (owner, repo) => {
        calls.push(`${owner}/${repo}`);
        return owner === 'acme' && repo === 'widgets' ? clone : null;
      },
      now,
    );

    assert.deepEqual(calls, ['acme/widgets']);
    assert.equal(fs.existsSync(pr1), false);
    assert.equal(fs.existsSync(pr2), false);
    assert.equal(fs.existsSync(pr3), true);
    assert.equal(fs.readFileSync(path.join(repoDir, 'notes.txt'), 'utf8'), 'keep');
    assert.equal(fs.readFileSync(path.join(secret, 'keep.txt'), 'utf8'), 'keep');
    assert.equal(fs.lstatSync(path.join(repoDir, 'pr-9')).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(path.join(escaped, 'pr-99', 'keep.txt'), 'utf8'), 'keep');
    assert.equal(fs.readFileSync(path.join(outside, 'pr-1', 'keep.txt'), 'utf8'), 'keep');
    assert.equal(hasRef(clone, prRef(1)), false);
    assert.equal(hasRef(clone, prRef(2)), false);
    assert.equal(hasRef(clone, prRef(3)), true);
    assert.ok(removed.includes(pr1));
    assert.ok(removed.includes(pr2));
    assert.equal(removed.includes(pr3), false);
    assert.equal(
      removed.some((dir) => dir.startsWith(outside) || dir.startsWith(secret) || dir.startsWith(escaped)),
      false,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
