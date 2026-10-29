import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageDecoder, encodeMessage } from '../src/framing.ts';
import { isAllowedOrigin } from '../src/host.ts';
import { buildFollowUp, buildPrompt } from '../src/prompt.ts';
import { parseGitHubRemote } from '../src/repo.ts';
import { ValidationError, isSafeRepoPath, validateMessage } from '../src/validate.ts';

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

test('only the Quack extension origin is accepted', () => {
  assert.ok(isAllowedOrigin('chrome-extension://ikkjkdmcnmifldjmajjjgabanjomhikf/'));
  assert.ok(!isAllowedOrigin('chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/'));
  assert.ok(!isAllowedOrigin(undefined));
});

test('GitHub remotes in every form map to owner/repo', () => {
  for (const url of [
    'git@github.com:ProjetoParcas/mynah.git',
    'https://github.com/ProjetoParcas/mynah',
    'https://user@github.com/ProjetoParcas/mynah.git',
    'ssh://git@github.com/ProjetoParcas/mynah.git',
  ]) {
    assert.equal(parseGitHubRemote(url), 'projetoparcas/mynah', url);
  }
  assert.equal(parseGitHubRemote('git@gitlab.com:a/b.git'), null);
});

const ask = (overrides: Record<string, unknown> = {}, pr: Record<string, unknown> = {}) => ({
  type: 'ask',
  requestId: 'r1',
  backend: 'cursor',
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
    ask({ backend: 'bash' }),
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
});
