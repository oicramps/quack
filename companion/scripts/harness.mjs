// Talks to the built companion over the same stdio framing Chrome uses.
//
//   node scripts/harness.mjs status
//   node scripts/harness.mjs ask --pr ProjetoParcas/mynah#14 --agent cursor \
//     --question "Do we already have something that does this?" \
//     [--path src/x.ts --start 10 --end 20] [--model gpt-5] [--session <id>] [--cancel-after 5000]

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXTENSION_ID = 'ikkjkdmcnmifldjmajjjgabanjomhikf';
const here = path.dirname(fileURLToPath(import.meta.url));
const bundle = path.join(here, '..', 'dist', 'quack-companion.cjs');

const [command, ...rest] = process.argv.slice(2);
const opts = {};
for (let i = 0; i < rest.length; i += 2) opts[rest[i].replace(/^--/, '')] = rest[i + 1];

// QUACK_LAUNCHER=~/.quack/bin/quack-companion runs the installed launcher with
// launchd's minimal environment, the way Chrome starts it.
const origin = `chrome-extension://${EXTENSION_ID}/`;
const child = process.env.QUACK_LAUNCHER
  ? spawn(process.env.QUACK_LAUNCHER, [origin], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { HOME: process.env.HOME, USER: process.env.USER, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK },
    })
  : spawn(process.execPath, [bundle, origin], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env, QUACK_ALLOW_DEV: '1' },
    });
const started = Date.now();
const t = () => `+${String(Date.now() - started).padStart(6)}ms`;

function send(msg) {
  const body = Buffer.from(JSON.stringify(msg));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  child.stdin.write(Buffer.concat([header, body]));
}

let buf = Buffer.alloc(0);
child.stdout.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) break;
    const msg = JSON.parse(buf.subarray(4, 4 + len).toString());
    buf = buf.subarray(4 + len);
    onMessage(msg);
  }
});

function finish(code = 0) {
  child.stdin.end();
  setTimeout(() => process.exit(code), 300);
}

let answer = '';
function onMessage(msg) {
  if (msg.type === 'status') {
    if (msg.pending?.length) return;
    console.log(JSON.stringify(msg, null, 2));
    return finish();
  }
  if (msg.type === 'progress') return console.log(t(), 'progress', msg.step, msg.detail ?? '');
  const ev = msg.event;
  if (ev.type === 'text') {
    answer += ev.delta;
    process.stdout.write(ev.delta);
  } else if (ev.type === 'tool') {
    console.log(`\n${t()} · ${ev.summary}`);
  } else if (ev.type === 'done') {
    console.log(`\n\n${t()} done`, JSON.stringify(ev));
    finish();
  } else if (ev.type === 'error') {
    console.log(`\n${t()} error`, JSON.stringify(ev, null, 2));
    finish(1);
  }
}

if (command === 'status') {
  send({ type: 'status', requestId: 'h-status' });
} else if (command === 'ask') {
  const m = (opts.pr ?? '').match(/^([^/]+)\/([^#]+)#(\d+)$/);
  if (!m) throw new Error('--pr owner/repo#number is required');
  const selections = opts.path
    ? [{ path: opts.path, startLine: opts.start ? Number(opts.start) : undefined, endLine: opts.end ? Number(opts.end) : undefined }]
    : [];
  send({
    type: 'ask',
    requestId: 'h-ask',
    agent: opts.agent ?? 'cursor',
    model: opts.model ?? '',
    pr: { owner: m[1], repo: m[2], number: Number(m[3]) },
    selections,
    question: opts.question ?? 'Summarize this PR in two sentences.',
    sessionId: opts.session ?? null,
  });
  if (opts['cancel-after']) {
    setTimeout(() => {
      console.log(`\n${t()} sending cancel`);
      send({ type: 'cancel', requestId: 'h-ask' });
    }, Number(opts['cancel-after']));
  }
} else {
  console.log('usage: harness.mjs status | ask --pr owner/repo#n [...]');
  process.exit(1);
}
