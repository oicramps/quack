import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { MessageDecoder, encodeMessage } from '../src/framing.ts';
import { isAllowedOrigin } from '../src/host.ts';
import { firefoxHostDir, install, nativeMessagingHostDirs, selectInstallHostDirs, uninstall } from '../src/install.ts';
import { buildCiPrompt, buildFollowUp, buildPrompt } from '../src/prompt.ts';
import { hasConfigFile } from '../src/config.ts';
import { contractHome } from '../src/paths.ts';
import { findCloneWithDiagnostics, inspectWorkspace, linkClone, parseGitHubRemote, saveWorkspace } from '../src/repo.ts';
import { fileAnchor } from '../src/selection.ts';
import { ciCommentText, isOlderVersion, parseCiReport } from '@quacksteps/shared';
import { claudeGuardArgs, claudeRequiresUpdate } from '../src/adapters/claude.ts';
import { cursorAcpArgs, cursorSandboxAdvertised } from '../src/adapters/cursor.ts';
import { agentEnv } from '../src/exec.ts';
import { prDiff } from '../src/pr.ts';
import { ValidationError, asCommitSha, isSafeRepoPath, validateMessage } from '../src/validate.ts';
import { GitError, ensureCommit, hasCommit } from '../src/worktree.ts';

test('framing round-trips messages split across chunks', () => {
  const a = encodeMessage({ type: 'status', requestId: 'r1' });
  const b = encodeMessage({ type: 'cancel', requestId: 'r2', note: 'ünïcödé' });
  const all = Buffer.concat([a, b]);
  const decoder = new MessageDecoder();
  const out = [...decoder.push(all.subarray(0, 3)), ...decoder.push(all.subarray(3, a.length + 5)), ...decoder.push(all.subarray(a.length + 5))];
  assert.deepEqual(out, [
    { type: 'status', requestId: 'r1' },
    { type: 'cancel', requestId: 'r2', note: 'ünïcödé' },
  ]);
});

test('native messaging hosts include every Brave channel and respect XDG_CONFIG_HOME', () => {
  const darwin = nativeMessagingHostDirs('darwin', '/Users/ada', {});
  const linux = nativeMessagingHostDirs('linux', '/home/ada', {});
  const xdg = nativeMessagingHostDirs('linux', '/home/ada', { XDG_CONFIG_HOME: '/home/ada/.xdg' });
  const relativeXdg = nativeMessagingHostDirs('linux', '/home/ada', { XDG_CONFIG_HOME: 'relative/path' });
  for (const channel of ['Brave-Browser', 'Brave-Browser-Beta', 'Brave-Browser-Dev', 'Brave-Browser-Nightly']) {
    assert.ok(darwin.includes(`/Users/ada/Library/Application Support/BraveSoftware/${channel}/NativeMessagingHosts`));
    assert.ok(linux.includes(`/home/ada/.config/BraveSoftware/${channel}/NativeMessagingHosts`));
    assert.ok(xdg.includes(`/home/ada/.xdg/BraveSoftware/${channel}/NativeMessagingHosts`));
    assert.ok(relativeXdg.includes(`/home/ada/.config/BraveSoftware/${channel}/NativeMessagingHosts`));
  }
  assert.equal(darwin.length, 7);
  assert.throws(() => nativeMessagingHostDirs('win32', '/Users/ada', {}), /Unsupported platform/);
});

test('install registers installed browsers without creating unused channel dirs, and uninstall cleans up', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quack-install-test-'));
  try {
    const home = path.join(tmp, 'home');
    const binDir = path.join(tmp, 'bin');
    const bundle = path.join(tmp, 'bundle.cjs');
    fs.writeFileSync(bundle, 'console.log("ok");\n');

    // Before any browser profile exists, only the primary stable channels are selected.
    const fallback = selectInstallHostDirs('linux', home, {});
    assert.deepEqual(fallback, [
      path.join(home, '.config', 'google-chrome', 'NativeMessagingHosts'),
      path.join(home, '.config', 'microsoft-edge', 'NativeMessagingHosts'),
      path.join(home, '.config', 'chromium', 'NativeMessagingHosts'),
      path.join(home, '.config', 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts'),
    ]);

    // When Brave Stable exists, only Brave Stable is registered (no Edge/Nightly/Beta clutter).
    const braveProfile = path.join(home, '.config', 'BraveSoftware', 'Brave-Browser');
    fs.mkdirSync(braveProfile, { recursive: true });
    install(bundle, { binDir, platform: 'linux', home, env: {} });

    const braveManifest = path.join(braveProfile, 'NativeMessagingHosts', 'com.quack.companion.json');
    assert.ok(fs.existsSync(braveManifest));
    assert.ok(!fs.existsSync(path.join(home, '.config', 'BraveSoftware', 'Brave-Browser-Nightly')));
    assert.ok(!fs.existsSync(path.join(home, '.config', 'microsoft-edge')));

    const parsed = JSON.parse(fs.readFileSync(braveManifest, 'utf8'));
    assert.deepEqual(parsed.allowed_origins, ['chrome-extension://hkdgklakkcffcmegdagdoigpaefhlipj/']);

    uninstall({ binDir, platform: 'linux', home, env: {} });
    assert.ok(!fs.existsSync(braveManifest));
    assert.ok(!fs.existsSync(binDir));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Firefox hosts live in one Mozilla folder per OS', () => {
  assert.deepEqual(firefoxHostDir('darwin', '/Users/ada'), {
    dir: '/Users/ada/Library/Application Support/Mozilla/NativeMessagingHosts',
    profileDir: '/Users/ada/Library/Application Support/Firefox',
  });
  assert.deepEqual(firefoxHostDir('linux', '/home/ada'), {
    dir: '/home/ada/.mozilla/native-messaging-hosts',
    profileDir: '/home/ada/.mozilla/firefox',
  });
  assert.throws(() => firefoxHostDir('win32', '/Users/ada'), /Unsupported platform/);
});

test('install registers Firefox by add-on id only once Firefox has run, and uninstall removes it', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quack-firefox-test-'));
  try {
    const home = path.join(tmp, 'home');
    const binDir = path.join(tmp, 'bin');
    const bundle = path.join(tmp, 'bundle.cjs');
    fs.writeFileSync(bundle, 'console.log("ok");\n');
    const manifest = path.join(home, '.mozilla', 'native-messaging-hosts', 'com.quack.companion.json');

    install(bundle, { binDir, platform: 'linux', home, env: {} });
    assert.ok(!fs.existsSync(manifest));

    fs.mkdirSync(path.join(home, '.mozilla', 'firefox'), { recursive: true });
    install(bundle, { binDir, platform: 'linux', home, env: {} });
    const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    assert.deepEqual(parsed.allowed_extensions, ['quacksteps@oicramps']);
    assert.equal(parsed.allowed_origins, undefined);
    assert.equal(parsed.name, 'com.quack.companion');
    assert.equal(parsed.path, path.join(binDir, 'quack-companion'));

    uninstall({ binDir, platform: 'linux', home, env: {} });
    assert.ok(!fs.existsSync(manifest));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('only the Quacksteps extension origin is accepted', () => {
  assert.ok(isAllowedOrigin('chrome-extension://hkdgklakkcffcmegdagdoigpaefhlipj/'));
  assert.ok(!isAllowedOrigin('chrome-extension://ikkjkdmcnmifldjmajjjgabanjomhikf/'));
  assert.ok(isAllowedOrigin('chrome-extension://ikkjkdmcnmifldjmajjjgabanjomhikf/', true));
  assert.ok(!isAllowedOrigin('chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/'));
  assert.ok(!isAllowedOrigin(undefined));
  assert.ok(isAllowedOrigin('quacksteps@oicramps'));
  assert.ok(!isAllowedOrigin('someone-else@example.com'));
});

test('only real commit ids are passed to git', async () => {
  assert.equal(asCommitSha('--upload-pack=evil'), null);
  assert.equal(asCommitSha('+refs/heads/main:refs/heads/main'), null);
  assert.equal(asCommitSha('A'.repeat(40)), 'a'.repeat(40));
  assert.equal(asCommitSha('abc1234'), 'abc1234');
  await assert.rejects(() => ensureCommit('/tmp', '--upload-pack=evil'), GitError);
  assert.equal(await hasCommit('/tmp', '--force'), false);
  await assert.rejects(() => prDiff('/tmp', '--output=/tmp/x', 'a'.repeat(40)), GitError);
});

test('agent guard flags follow what the installed CLI advertises', () => {
  assert.deepEqual(claudeGuardArgs('--restricted\n--strict-mcp-config\n--permission-prompts\n--disallowedTools'), [
    '--restricted',
    '--strict-mcp-config',
    '--permission-prompts',
    'none',
  ]);
  const older = claudeGuardArgs('--setting-sources\n--disallowed-tools');
  assert.deepEqual(older.slice(0, 2), ['--setting-sources', 'user']);
  assert.ok(older.includes('Bash') && older.includes('mcp__*'));
  assert.deepEqual(claudeGuardArgs('nothing'), []);
  assert.equal(claudeRequiresUpdate('nothing'), true);
  assert.equal(claudeRequiresUpdate('--disallowed-tools'), true);
  assert.equal(claudeRequiresUpdate('--disallowedTools'), true);
  assert.equal(claudeRequiresUpdate('--restricted'), false);
  assert.deepEqual(cursorAcpArgs('--model <model>\n--mode <mode>\n--sandbox <mode>\n--skip-worktree-setup'), [
    '--sandbox',
    'enabled',
    '--skip-worktree-setup',
    '--mode',
    'ask',
    'acp',
  ]);
  assert.equal(cursorSandboxAdvertised('usage: agent acp\n--sandbox <mode>'), true);
  assert.equal(cursorSandboxAdvertised('--model <model>'), false);
  assert.deepEqual(cursorAcpArgs('--model <model>'), ['acp']);
});

test('the review agent does not inherit git, ssh, or cloud credentials', () => {
  const env = agentEnv({
    HOME: '/Users/reviewer',
    PATH: '/usr/bin',
    TMPDIR: '/tmp',
    LANG: 'en_US.UTF-8',
    HTTPS_PROXY: 'http://127.0.0.1:8888',
    SSL_CERT_FILE: '/etc/ssl/cert.pem',
    ANTHROPIC_API_KEY: 'sk-ant-example',
    CURSOR_API_KEY: 'cursor-example',
    GH_TOKEN: 'ghp-example',
    GITHUB_TOKEN: 'github-example',
    SSH_AUTH_SOCK: '/tmp/ssh-agent',
    AWS_SECRET_ACCESS_KEY: 'aws-example',
    AWS_REGION: 'eu-west-1',
    GOOGLE_APPLICATION_CREDENTIALS: '/tmp/gcp.json',
    NPM_TOKEN: 'npm-example',
  });
  assert.equal(env.HOME, '/Users/reviewer');
  assert.equal(env.TMPDIR, '/tmp');
  assert.equal(env.LANG, 'en_US.UTF-8');
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:8888');
  assert.equal(env.SSL_CERT_FILE, '/etc/ssl/cert.pem');
  assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-example');
  assert.equal(env.CURSOR_API_KEY, 'cursor-example');
  assert.equal(env.AWS_REGION, 'eu-west-1');
  for (const secret of ['GH_TOKEN', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK', 'AWS_SECRET_ACCESS_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'NPM_TOKEN']) {
    assert.equal(env[secret], undefined, secret);
  }
});

test('GitHub remotes in every form map to owner/repo', () => {
  for (const url of [
    'git@github.com:ProjetoParcas/mynah.git',
    'https://github.com/ProjetoParcas/mynah',
    'https://user@github.com/ProjetoParcas/mynah.git',
    'ssh://git@github.com/ProjetoParcas/mynah.git',
    'ssh://git@ssh.github.com:443/ProjetoParcas/mynah.git',
  ]) {
    assert.equal(parseGitHubRemote(url), 'projetoparcas/mynah', url);
  }
  assert.equal(parseGitHubRemote('git@gitlab.com:a/b.git'), null);
});

function makeGitStub(dir: string, originUrl: string): void {
  fs.mkdirSync(path.join(dir, '.git', 'objects'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.git', 'refs'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(dir, '.git', 'config'), `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${originUrl}\n`);
}

test('findCloneWithDiagnostics follows symlinks, trusts SSH-alias repoPaths, and reports permission-blocked scan roots', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quack-repo-test-'));
  const blocked = path.join(root, 'blocked');
  const scan = path.join(root, 'scan');
  const realRepo = path.join(root, 'real-clone');
  const linked = path.join(scan, 'symlinked-clone');
  const aliasRepo = path.join(root, 'alias-clone');
  const wrongRepo = path.join(root, 'wrong-clone');
  const cfgFile = path.join(root, 'config.json');
  try {
    fs.mkdirSync(blocked);
    fs.mkdirSync(scan);
    makeGitStub(realRepo, 'git@github.com:Polarsteps/igloo.git');
    fs.symlinkSync(realRepo, linked);
    makeGitStub(aliasRepo, 'git@github-work:polarsteps/alias-repo.git');
    makeGitStub(wrongRepo, 'git@github.com:someone/else.git');
    fs.chmodSync(blocked, 0o000);

    const baseCfg = { scanRoots: [blocked, scan], repoPaths: {}, worktreeRoot: path.join(root, 'wt'), retentionDays: 7, maxWorktrees: 20 };

    // Follows symlink under scanRoots.
    const viaSymlink = await findCloneWithDiagnostics(baseCfg, 'polarsteps', 'igloo');
    assert.equal(viaSymlink.clone, linked);

    // Reports permission-blocked scan root when clone is missing (skip chmod assertion if running as root).
    const missing = await findCloneWithDiagnostics(baseCfg, 'polarsteps', 'nonexistent');
    assert.equal(missing.clone, null);
    if (process.getuid?.() !== 0) {
      assert.deepEqual(missing.blockedRoots, [blocked]);
    }

    // Accepts explicit repoPaths with a custom SSH host alias.
    const viaAlias = await findCloneWithDiagnostics({ ...baseCfg, repoPaths: { 'polarsteps/alias-repo': aliasRepo } }, 'polarsteps', 'alias-repo');
    assert.equal(viaAlias.clone, aliasRepo);

    // Rejects repoPaths pointing to a different GitHub repo with a clear overrideIssue.
    const mismatch = await findCloneWithDiagnostics({ ...baseCfg, repoPaths: { 'polarsteps/target': wrongRepo } }, 'polarsteps', 'target');
    assert.equal(mismatch.clone, null);
    assert.match(mismatch.overrideIssue ?? '', /someone\/else/);

    // linkClone writes auto-detected origin and explicit owner/repo into config.json.
    const autoLinked = await linkClone(realRepo, undefined, cfgFile);
    assert.equal(autoLinked.key, 'polarsteps/igloo');
    const explicitLinked = await linkClone(aliasRepo, 'Polarsteps/Alias-Repo', cfgFile);
    assert.equal(explicitLinked.key, 'polarsteps/alias-repo');
    const saved = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    assert.equal(saved.repoPaths['polarsteps/igloo'], contractHome(path.resolve(realRepo)));
    assert.equal(saved.repoPaths['polarsteps/alias-repo'], contractHome(path.resolve(aliasRepo)));
  } finally {
    fs.chmodSync(blocked, 0o755);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('inspectWorkspace and saveWorkspace report status, add folders or clones, and validate inputs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quack-ws-test-'));
  const cfgFile = path.join(root, 'config.json');
  const codeDir = path.join(root, 'work');
  const repoA = path.join(codeDir, 'igloo');
  const singleAlias = path.join(root, 'elsewhere', 'special');
  try {
    makeGitStub(repoA, 'git@github.com:polarsteps/igloo.git');
    makeGitStub(singleAlias, 'git@github-work:polarsteps/special.git');

    assert.equal(hasConfigFile(cfgFile), false);
    const before = await inspectWorkspace({ configFile: cfgFile });
    assert.equal(before.configured, false);
    assert.equal(before.gitAvailable, true);

    // Adding a missing path returns an error without creating a broken config.
    const missing = await saveWorkspace({ addPath: path.join(root, 'nope') }, cfgFile);
    assert.match(missing.error ?? '', /Folder not found/);

    // Adding a parent folder saves scanRoots and tests it.
    const addedFolder = await saveWorkspace({ addPath: codeDir, pr: { owner: 'polarsteps', repo: 'igloo' } }, cfgFile);
    assert.equal(addedFolder.error, undefined);
    assert.equal(addedFolder.workspace.configured, true);
    assert.ok(addedFolder.workspace.roots.some((r) => r.path === contractHome(codeDir) && r.state === 'ok' && r.repoCount === 1));
    assert.equal(addedFolder.workspace.prMatch?.found, true);

    // Adding an individual clone with an SSH host alias under PR context links repoPaths.
    const addedClone = await saveWorkspace({ addPath: singleAlias, pr: { owner: 'polarsteps', repo: 'special' } }, cfgFile);
    assert.equal(addedClone.error, undefined);
    assert.match(addedClone.notice ?? '', /Linked polarsteps\/special/);
    assert.equal(addedClone.workspace.prMatch?.found, true);
    assert.equal(addedClone.workspace.overrides.find((o) => o.repo === 'polarsteps/special')?.state, 'ok');

    // Validation checks for workspace_check and workspace_save.
    const wc = validateMessage({ type: 'workspace_check', requestId: 'w1', pr: { owner: 'polarsteps', repo: 'igloo' } });
    assert.equal(wc.type, 'workspace_check');
    const ws = validateMessage({ type: 'workspace_save', requestId: 'w2', addPath: '~/work', repoPaths: { 'polarsteps/special': null } });
    assert.equal(ws.type, 'workspace_save');
    assert.throws(() => validateMessage({ type: 'workspace_check', requestId: 'w1', pr: { owner: '../bad', repo: 'x' } }), ValidationError);
    assert.throws(() => validateMessage({ type: 'workspace_save', requestId: 'w2', scanRoots: [''] }), ValidationError);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const ask = (overrides: Record<string, unknown> = {}, pr: Record<string, unknown> = {}) => ({
  type: 'ask',
  requestId: 'r1',
  agent: 'cursor',
  model: '',
  pr: { owner: 'ProjetoParcas', repo: 'mynah', number: 14, ...pr },
  selections: [],
  question: 'Does this exist?',
  sessionId: null,
  ...overrides,
});

test('valid asks pass validation', () => {
  const msg = validateMessage(ask({ selections: [{ path: 'src/a.ts', startLine: 1, endLine: 3, text: 'x' }] }));
  assert.equal(msg.type, 'ask');
});

test('hostile input is rejected before it reaches git', () => {
  const bad = [
    ask({}, { owner: 'a;rm -rf ~' }),
    ask({}, { repo: '..' }),
    ask({}, { repo: 'x/../../etc' }),
    ask({}, { number: -1 }),
    ask({}, { number: 1.5 }),
    ask({}, { headSha: '--upload-pack=evil' }),
    ask({}, { baseRef: '-delete' }),
    ask({}, { baseRef: 'main..evil' }),
    ask({ agent: 'bash' }),
    ask({ model: '--force' }),
    ask({ model: 'a b' }),
    ask({ sessionId: '--force' }),
    ask({ question: '   ' }),
    ask({ selections: [{ path: '../../etc/passwd' }] }),
    ask({ selections: [{ path: '/etc/passwd' }] }),
    ask({ requestId: 'has spaces' }),
    { type: 'exec', requestId: 'r1' },
  ];
  for (const m of bad) assert.throws(() => validateMessage(m), ValidationError, JSON.stringify(m));
});

test("file anchors match GitHub's diff-<sha256(path)> ids", () => {
  assert.equal(fileAnchor('packages/wxt/src/cli/commands.ts'), '9669d08fa74cd8d6b2f85d57c371cc57d15accb62aef510ef2fd6e41d4a4ef4c');
});

test('repo-relative paths', () => {
  assert.ok(isSafeRepoPath('src/utils/date.ts'));
  assert.ok(!isSafeRepoPath('src/../../x'));
  assert.ok(!isSafeRepoPath('./x'));
});

test('prompt contains the rules, diff, selection and question', () => {
  const p = buildPrompt({
    owner: 'o',
    repo: 'r',
    prNumber: 1,
    title: 'Add date helper',
    body: 'Body',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    diff: '+const x = 1;',
    diffTruncated: false,
    selections: [{ path: 'src/date.ts', startLine: 40, endLine: 60 }],
    question: 'Do we already have this?',
  });
  for (const s of ['Do not create, modify or delete', 'search the repository', '`path:line`', '+const x = 1;', 'src/date.ts lines 40-60', 'Do we already have this?']) {
    assert.ok(p.includes(s), s);
  }
  assert.ok(!buildFollowUp([], '-v').startsWith('-'));
  assert.ok(!p.includes('Earlier in this conversation'));
});

test('prompts ask for short answers and code when an alternative is requested', () => {
  const p = buildPrompt({
    owner: 'o',
    repo: 'r',
    prNumber: 1,
    title: 'Add date helper',
    body: '',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    diff: '',
    diffTruncated: false,
    selections: [],
    question: 'Is there a cleaner way?',
  });
  for (const s of ['as few words as possible', 'Do not narrate', 'fenced code block']) assert.ok(p.includes(s), s);
  assert.ok(p.lastIndexOf('reply with code') > p.indexOf('# Question'));
  const f = buildFollowUp([], 'And here?');
  assert.ok(f.includes('Be brief') && f.includes('code block'));
});

test('a thread continued on a new agent carries its earlier turns before the question', () => {
  const p = buildPrompt({
    owner: 'o',
    repo: 'r',
    prNumber: 1,
    title: 'Add date helper',
    body: '',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    diff: '',
    diffTruncated: false,
    selections: [],
    question: 'And the tests?',
    history: [{ question: 'Do we already have this?', answer: 'Yes, `formatTimeAgo` in utils/date.ts:112.' }],
  });
  const earlier = p.indexOf('# Earlier in this conversation');
  assert.ok(earlier > 0);
  assert.ok(p.indexOf('Do we already have this?') > earlier);
  assert.ok(p.indexOf('formatTimeAgo') > earlier);
  assert.ok(p.indexOf('# Question\n\nAnd the tests?') > p.indexOf('formatTimeAgo'));
});

test('ask history is validated and trimmed', () => {
  const base = { type: 'ask', requestId: 'r1', agent: 'cursor', model: '', pr: { owner: 'o', repo: 'r', number: 1 }, selections: [], question: 'q', sessionId: null };
  const ok = validateMessage({ ...base, history: [{ question: 'a', answer: 'x'.repeat(20_000) }] });
  assert.equal(ok.type === 'ask' && ok.history?.[0].answer.length, 8000);
  assert.equal('history' in validateMessage(base), false);
  assert.throws(() => validateMessage({ ...base, history: [{ question: 1, answer: '' }] }), ValidationError);
  assert.throws(() => validateMessage({ ...base, history: Array(11).fill({ question: 'a', answer: 'b' }) }), ValidationError);
});

test('explain_ci asks and checks requests are validated', () => {
  const msg = validateMessage(ask({ task: 'explain_ci' }));
  assert.equal(msg.type === 'ask' && msg.task, 'explain_ci');
  assert.throws(() => validateMessage(ask({ task: 'labels' })), ValidationError);
  const checks = validateMessage({ type: 'checks', requestId: 'r1', pr: { owner: 'o', repo: 'r', number: 14 } });
  assert.equal(checks.type === 'checks' && checks.pr.number, 14);
  assert.throws(() => validateMessage({ type: 'checks', requestId: 'r1', pr: { owner: 'o', repo: '..', number: 1 } }), ValidationError);
});

test('a CI prompt asks for a quack-ci block and includes the log tail', () => {
  const p = buildCiPrompt({
    owner: 'o',
    repo: 'r',
    prNumber: 7,
    title: 'Let admins delete invoices',
    body: '',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    diff: '+ billing:delete',
    diffTruncated: false,
    selections: [],
    question: 'Explain failing CI',
    logsUnavailable: false,
    checks: [
      {
        name: 'test / unit',
        workflow: 'CI',
        link: 'https://github.com/o/r/actions/runs/1/job/2',
        log: `expected 204, got 403\ntoken=ghp_${'a'.repeat(36)}`,
        recent: { failed: 1, total: 20, branch: 'main' },
      },
    ],
  });
  for (const s of ['quack-ci', 'caused_by_pr', 'expected 204, got 403', 'failed 1 of the last 20', 'Explain failing CI', 'untrusted data']) {
    assert.ok(p.includes(s), s);
  }
  assert.equal(p.includes('ghp_'), false);
  const unavailable = buildCiPrompt({
    owner: 'o',
    repo: 'r',
    prNumber: 7,
    title: 't',
    body: '',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    diff: '',
    diffTruncated: false,
    selections: [],
    question: 'Explain failing CI',
    logsUnavailable: true,
    checks: [],
  });
  assert.ok(unavailable.includes('could not be read'));
});

test('quack-ci blocks become findings, and broken JSON stays markdown', () => {
  const text = 'One real failure.\n\n```quack-ci\n[{"check":"unit","verdict":"caused_by_pr","summary":"See `a.ts:1`","refs":[{"path":"a.ts","line":1}],"fix":{"path":"a.ts","patch":"+ x"}}]\n```';
  const report = parseCiReport(text);
  assert.equal(report.prose, 'One real failure.');
  assert.equal(report.findings?.[0].verdict, 'caused_by_pr');
  assert.equal(report.findings?.[0].fix?.patch, '+ x');
  assert.equal(parseCiReport('One real failure.\n\n```quack-ci\n[{"check":"unit"').pending, true);
  assert.equal(parseCiReport('no block here').findings, null);
  assert.equal(parseCiReport('```quack-ci\n{not json}\n```').findings, null);
  assert.ok(ciCommentText(text).includes('Caused by this PR'));
  assert.ok(!ciCommentText(text).includes('quack-ci'));
});

test('close_session messages are validated', () => {
  assert.deepEqual(validateMessage({ type: 'close_session', requestId: 'r1', agent: 'cursor', sessionId: 'abc-1' }), {
    type: 'close_session',
    requestId: 'r1',
    agent: 'cursor',
    sessionId: 'abc-1',
  });
  assert.throws(() => validateMessage({ type: 'close_session', requestId: 'r1', agent: 'cursor', sessionId: '--rm' }), ValidationError);
});

test('an older companion version is detected numerically, not as text', () => {
  assert.ok(isOlderVersion('0.2.1', '0.2.2'));
  assert.ok(isOlderVersion('0.9.0', '0.10.0'));
  assert.ok(isOlderVersion('0.2', '0.2.1'));
  assert.ok(!isOlderVersion('0.2.1', '0.2.1'));
  assert.ok(!isOlderVersion('0.3.0', '0.2.9'));
  assert.ok(!isOlderVersion('0.2.1-beta', '0.2.1'));
});
