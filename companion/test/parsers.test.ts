import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createClaudeParser } from '../src/adapters/claude.ts';
import { createCursorParser, parseModelList } from '../src/adapters/cursor.ts';
import type { AdapterEvent, LineParser } from '../src/adapters/types.ts';

function replay(file: string, parser: LineParser): AdapterEvent[] {
  const lines = fs.readFileSync(path.join(import.meta.dirname, 'fixtures', file), 'utf8').split('\n').filter(Boolean);
  return lines.flatMap((l) => parser(JSON.parse(l)));
}

const text = (events: AdapterEvent[]) =>
  events
    .filter((e) => e.type === 'text')
    .map((e) => (e as { delta: string }).delta)
    .join('');
const tools = (events: AdapterEvent[]) => events.filter((e) => e.type === 'tool').map((e) => (e as { summary: string }).summary);

test('cursor: streams text once, summarizes tools, reports the session', () => {
  const events = replay('cursor-documented.jsonl', createCursorParser('/wt'));
  assert.equal(text(events), 'Let me search the repo.Yes: `src/utils/date.ts:112`.');
  assert.deepEqual(tools(events), ['Searched repo for parseDate', 'Read src/utils/date.ts']);
  assert.deepEqual(events[0], { type: 'session', sessionId: 'c0ffee-1' });
  assert.ok(events.some((e) => e.type === 'model' && e.model === 'GPT-5'));
  assert.ok(!events.some((e) => e.type === 'error'));
});

test('cursor: error results become errors', () => {
  const events = createCursorParser('/wt')({ type: 'result', is_error: true, result: 'Rate limited' });
  assert.deepEqual(events, [{ type: 'error', message: 'Rate limited' }]);
});

test('cursor: model list parsing', () => {
  const out = 'Available models\n\n- auto - Auto\n- gpt-5 (current)\n  sonnet-4.5\n\x1b[2mTip: use --model\x1b[0m\n';
  assert.deepEqual(parseModelList(out), ['auto', 'gpt-5', 'sonnet-4.5']);
});

test('claude: uses partial deltas, skips duplicate full text, shows ExitPlanMode plan', () => {
  const events = replay('claude-documented.jsonl', createClaudeParser('/wt'));
  assert.equal(text(events), 'Searching first. Yes: `src/utils/date.ts:112`.');
  assert.deepEqual(tools(events), ['Searched repo for parseDate', 'Read src/utils/date.ts']);
  assert.deepEqual(events[0], { type: 'session', sessionId: 's_8d1' });
});

test('claude: without partial messages, full assistant text is used', () => {
  const parse = createClaudeParser('/wt');
  const events = parse({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } });
  assert.equal(text(events), 'Hello');
});
