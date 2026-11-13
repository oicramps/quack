import assert from 'node:assert/strict';
import { test } from 'node:test';
import { failingFromPayload, failureRate, isSafeWorkflow, parseRunLink, redactSecrets, tailLog } from '../src/checks.ts';

test('only failing checks are kept, with the run and job taken from the link', () => {
  const checks = failingFromPayload([
    { name: 'unit', bucket: 'fail', state: 'FAILURE', workflow: 'CI', link: 'https://github.com/o/r/actions/runs/10/job/20' },
    { name: 'lint', bucket: 'pass', state: 'SUCCESS', link: 'https://github.com/o/r/actions/runs/10/job/21' },
    { name: 'e2e', state: 'TIMED_OUT', link: 'https://github.com/o/r/runs/30' },
    { name: '  ', bucket: 'fail' },
    { bucket: 'fail' },
  ]);
  assert.deepEqual(
    checks.map((c) => c.name),
    ['unit', 'e2e'],
  );
  assert.deepEqual(parseRunLink(checks[0].link), { runId: '10', jobId: '20' });
  assert.deepEqual(parseRunLink(checks[1].link), { jobId: '30' });
});

test('secrets in CI logs are masked, including on a second pass', () => {
  const token = `ghp_${'a'.repeat(36)}`;
  const log = `password: supersecret\nexpected 204, got 403\nAuthorization: Bearer ${token}`;
  const once = redactSecrets(log);
  const twice = redactSecrets(once);
  assert.equal(once.includes(token), false);
  assert.equal(once.includes('supersecret'), false);
  assert.ok(once.includes('expected 204, got 403'));
  assert.equal(twice, once);
  assert.equal(tailLog(`keep me\n${log}`, 10, 10_000).includes(token), false);
});

test('log tails keep the end, and recent failures ignore skips', () => {
  const log = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n');
  assert.equal(tailLog(log, 3, 1000), 'line 7\nline 8\nline 9');
  assert.equal(tailLog('abcdef', 10, 3), 'def');
  assert.deepEqual(failureRate(['success', 'failure', 'skipped', 'cancelled', 'timed_out', '']), { failed: 2, total: 3 });
});

test('workflow names that look like flags are rejected', () => {
  assert.ok(isSafeWorkflow('CI'));
  assert.ok(isSafeWorkflow('Test (push)'));
  assert.ok(!isSafeWorkflow('--all'));
  assert.ok(!isSafeWorkflow('a\nb'));
});
