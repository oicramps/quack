import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageDecoder, encodeMessage } from '../src/framing.ts';
import { isAllowedOrigin } from '../src/host.ts';
import { buildCiPrompt, buildFollowUp, buildPrompt } from '../src/prompt.ts';
import { parseGitHubRemote } from '../src/repo.ts';
import { fileAnchor } from '../src/selection.ts';
import { ciCommentText, parseCiReport } from '@quack/shared';
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
        log: 'expected 204, got 403',
        recent: { failed: 1, total: 20, branch: 'main' },
      },
    ],
  });
  for (const s of ['quack-ci', 'caused_by_pr', 'expected 204, got 403', 'failed 1 of the last 20', 'Explain failing CI']) {
    assert.ok(p.includes(s), s);
  }
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
