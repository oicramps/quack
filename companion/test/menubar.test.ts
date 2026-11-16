import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { SwiftcMissingError, findSwiftc, install } from '../src/install.ts';
import { MenuActivity, encodeMenuStatus, menuStatus, startMenuBar } from '../src/menubar.ts';

test('menu is Connected when nothing is running', () => {
  assert.deepEqual(menuStatus([]), { title: 'Connected' });
  assert.equal(encodeMenuStatus({ title: 'Connected' }), '{"title":"Connected"}');
});

test('menu shows the pull request and step for one ask', () => {
  const activity = new MenuActivity();
  activity.begin('a', 'acme/widgets#41');
  assert.deepEqual(activity.progress('a', 'fetching_pr'), {
    title: 'acme/widgets#41',
    subtitle: 'Fetching PR',
  });
  assert.equal(
    encodeMenuStatus({ title: 'acme/widgets#41', subtitle: 'Fetching PR' }),
    '{"title":"acme/widgets#41","subtitle":"Fetching PR"}',
  );
});

test('menu names the newest ask and a count when two are running', () => {
  assert.deepEqual(
    menuStatus([
      { label: 'acme/widgets#41', step: 'Fetching PR', updatedAt: 1 },
      { label: 'acme/other#7', step: 'Thinking', updatedAt: 2 },
    ]),
    { title: 'acme/other#7', subtitle: 'Thinking', count: '2 requests' },
  );

  const activity = new MenuActivity();
  activity.begin('old', 'acme/widgets#41');
  activity.progress('old', 'thinking');
  activity.begin('new', 'acme/other#7');
  assert.deepEqual(activity.progress('new', 'fetching_pr'), {
    title: 'acme/other#7',
    subtitle: 'Fetching PR',
    count: '2 requests',
  });
  assert.deepEqual(activity.end('new'), { title: 'acme/widgets#41', subtitle: 'Thinking' });
});

test('finishing an ask returns the menu to Connected', () => {
  const activity = new MenuActivity();
  activity.begin('a', 'acme/widgets#41');
  activity.progress('a', 'preparing_worktree');
  assert.deepEqual(activity.end('a'), { title: 'Connected' });
  assert.equal(activity.end('a'), null);
  assert.equal(activity.progress('a', 'thinking'), null);
});

test('menu bar does nothing off macOS or when the helper is missing', () => {
  const notes: string[] = [];
  const log = (...parts: unknown[]) => notes.push(parts.map(String).join(' '));
  const linux = startMenuBar({ platform: 'linux', log });
  linux.update({ title: 'Connected' });
  linux.stop();
  linux.stop();

  const missing = startMenuBar({
    platform: 'darwin',
    binary: path.join(os.tmpdir(), `quack-missing-menubar-${process.pid}`),
    log,
  });
  missing.update({ title: 'Connected' });
  missing.stop();
  assert.deepEqual(notes, ['menu bar helper missing; run quack-companion install again']);
});

test('findSwiftc reports the compiler missing when it is not on PATH', () => {
  assert.equal(findSwiftc({ PATH: '/nonexistent' }), null);
});

test('install does not compile a menu bar helper on linux', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quack-menu-linux-'));
  try {
    const home = path.join(tmp, 'home');
    const binDir = path.join(tmp, 'bin');
    const bundle = path.join(tmp, 'bundle.cjs');
    fs.writeFileSync(bundle, 'console.log("ok");\n');
    let compiled = false;
    install(bundle, {
      binDir,
      platform: 'linux',
      home,
      env: {},
      compileMenuBar() {
        compiled = true;
      },
    });
    assert.equal(compiled, false);
    assert.equal(fs.existsSync(path.join(binDir, 'quack-menubar')), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('install compiles the menu bar helper on macOS', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quack-menu-darwin-'));
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  try {
    const home = path.join(tmp, 'home');
    const binDir = path.join(tmp, 'bin');
    const bundle = path.join(tmp, 'bundle.cjs');
    fs.writeFileSync(bundle, 'console.log("ok");\n');
    let source = '';
    let outFile = '';
    install(bundle, {
      binDir,
      platform: 'darwin',
      home,
      env: {},
      compileMenuBar(src, out) {
        source = src;
        outFile = out;
      },
    });
    assert.equal(outFile, path.join(binDir, 'quack-menubar'));
    assert.match(source, /NSStatusItem/);
    assert.ok(lines.includes(`Menu bar helper: ${outFile}`));
  } finally {
    console.log = orig;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('install still succeeds when swiftc is missing', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quack-menu-noswift-'));
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  try {
    const home = path.join(tmp, 'home');
    const binDir = path.join(tmp, 'bin');
    const bundle = path.join(tmp, 'bundle.cjs');
    fs.writeFileSync(bundle, 'console.log("ok");\n');
    install(bundle, {
      binDir,
      platform: 'darwin',
      home,
      env: {},
      compileMenuBar() {
        throw new SwiftcMissingError();
      },
    });
    assert.ok(fs.existsSync(path.join(binDir, 'quack-companion')));
    assert.equal(fs.existsSync(path.join(binDir, 'quack-menubar')), false);
    assert.ok(lines.some((line) => line.includes('Install the Xcode Command Line Tools and run install again.')));
  } finally {
    console.log = orig;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
