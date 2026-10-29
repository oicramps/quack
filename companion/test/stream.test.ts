import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runJsonLines } from '../src/adapters/stream.ts';
import type { AdapterEvent } from '../src/adapters/types.ts';

function fakeAgent(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quack-fake-'));
  const file = path.join(dir, 'agent');
  fs.writeFileSync(file, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  return file;
}

const parse = (obj: Record<string, unknown>): AdapterEvent[] => [{ type: 'text', delta: String(obj.t) }];

test('aborting stops the stream and kills the agent', async () => {
  const pidFile = path.join(os.tmpdir(), `quack-fake-${process.pid}.pid`);
  const bin = fakeAgent(
    `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
     let i = 0; setInterval(() => console.log(JSON.stringify({ t: i++ })), 50);`,
  );
  const controller = new AbortController();
  const events: AdapterEvent[] = [];
  for await (const ev of runJsonLines(bin, [], os.tmpdir(), controller.signal, parse, 'test')) {
    events.push(ev);
    if (events.length === 3) controller.abort();
  }
  assert.ok(events.length >= 3 && events.length < 10, `got ${events.length} events`);
  assert.ok(!events.some((e) => e.type === 'error'));
  await new Promise((r) => setTimeout(r, 200));
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.throws(() => process.kill(pid, 0), 'agent process should be gone');
});

test('a failing agent yields an error with its stderr', async () => {
  const bin = fakeAgent(`console.error('boom: not authenticated'); process.exit(2);`);
  const events: AdapterEvent[] = [];
  for await (const ev of runJsonLines(bin, [], os.tmpdir(), new AbortController().signal, parse, 'test')) events.push(ev);
  assert.deepEqual(events, [{ type: 'error', message: 'boom: not authenticated' }]);
});
