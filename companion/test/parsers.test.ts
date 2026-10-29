import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { acpModels, createUpdateMapper, matchModel } from '../src/adapters/acp.ts';
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

test('cursor acp: text chunks and one summary per tool call once its input is known', () => {
  const map = createUpdateMapper('/wt');
  const events = [
    { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } },
    { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'grep', kind: 'search', status: 'pending', rawInput: {} },
    { sessionUpdate: 'tool_call_update', toolCallId: 't1', title: 'grep "parseDate"', rawInput: { pattern: 'parseDate', path: '/wt' } },
    { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' },
    { sessionUpdate: 'tool_call', toolCallId: 't2', title: 'Read src/utils/date.ts', kind: 'read', status: 'pending', rawInput: { path: '/wt/src/utils/date.ts' } },
    { sessionUpdate: 'tool_call_update', toolCallId: 't2', status: 'in_progress' },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Yes: ' } },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '`src/utils/date.ts:112`.' } },
  ].flatMap(map);
  assert.equal(text(events), 'Yes: `src/utils/date.ts:112`.');
  assert.deepEqual(tools(events), ['Searched repo for parseDate', 'Read src/utils/date.ts']);
});

test('cursor acp: models show without parameters and CLI variant names map to their base', () => {
  const models = acpModels({
    models: { availableModels: [{ modelId: 'default[]' }, { modelId: 'gpt-5.6-luna[reasoning=medium]' }, { modelId: 'gpt-5.6[effort=high]' }] },
  });
  assert.deepEqual(models.map((m) => m.id), ['gpt-5.6-luna', 'gpt-5.6']);
  assert.equal(matchModel(models, 'gpt-5.6-luna-high')?.value, 'gpt-5.6-luna[reasoning=medium]');
  assert.equal(matchModel(models, 'gpt-5.6')?.value, 'gpt-5.6[effort=high]');
  assert.equal(matchModel(models, 'sonnet-4'), undefined);
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
