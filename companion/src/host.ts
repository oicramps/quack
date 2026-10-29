import type { BackendId, BackendStatus, CompanionMessage, ExtensionMessage } from '@quack/shared';
import { EXTENSION_ID, QUACK_VERSION } from '@quack/shared';
import { adapters } from './adapters/index.ts';
import { loadConfig } from './config.ts';
import { MessageDecoder, encodeMessage } from './framing.ts';
import { log } from './log.ts';
import { handleAsk } from './session.ts';
import { ValidationError, validateMessage } from './validate.ts';
import { clearStaleLocks } from './worktree.ts';

const STATUS_TTL_MS = 60_000;
// Chrome caps host-to-browser messages at 1 MB; keep text events far below it.
const MAX_TEXT_DELTA = 64 * 1024;

export function isAllowedOrigin(origin: string | undefined): boolean {
  return origin === `chrome-extension://${EXTENSION_ID}/`;
}

export function startHost(origin: string | undefined): void {
  if (!isAllowedOrigin(origin)) {
    log('rejected caller origin', String(origin));
    process.exit(1);
  }
  log('host started', QUACK_VERSION);
  clearStaleLocks(loadConfig());

  const send = (message: CompanionMessage) => {
    if (message.type === 'event' && message.event.type === 'text' && message.event.delta.length > MAX_TEXT_DELTA) {
      const { delta } = message.event;
      for (let i = 0; i < delta.length; i += MAX_TEXT_DELTA) {
        process.stdout.write(encodeMessage({ ...message, event: { type: 'text', delta: delta.slice(i, i + MAX_TEXT_DELTA) } }));
      }
      return;
    }
    process.stdout.write(encodeMessage(message));
  };

  const statusCache = new Map<BackendId, { at: number; status: BackendStatus }>();
  const refreshStatus = async (id: BackendId): Promise<BackendStatus> => {
    const status = await adapters[id].isAvailable();
    statusCache.set(id, { at: Date.now(), status });
    return status;
  };
  const cachedStatus = async (id: BackendId): Promise<BackendStatus> => {
    const hit = statusCache.get(id);
    return hit && Date.now() - hit.at < STATUS_TTL_MS && hit.status.state === 'ready' ? hit.status : refreshStatus(id);
  };

  const running = new Map<string, AbortController>();

  const handle = (message: ExtensionMessage) => {
    switch (message.type) {
      case 'status':
        Promise.all((Object.keys(adapters) as BackendId[]).map(refreshStatus)).then((backends) =>
          send({ type: 'status', requestId: message.requestId, version: QUACK_VERSION, backends }),
        );
        break;
      case 'cancel':
        running.get(message.requestId)?.abort();
        break;
      case 'ask': {
        const controller = new AbortController();
        running.set(message.requestId, controller);
        handleAsk(message, send, controller.signal, cachedStatus).finally(() => running.delete(message.requestId));
        break;
      }
    }
  };

  const decoder = new MessageDecoder();
  process.stdin.on('data', (chunk: Buffer) => {
    let messages: unknown[];
    try {
      messages = decoder.push(chunk);
    } catch (err) {
      log('framing error, exiting:', String(err));
      process.exit(1);
    }
    for (const raw of messages) {
      try {
        handle(validateMessage(raw));
      } catch (err) {
        const requestId = (raw as { requestId?: unknown })?.requestId;
        log('rejected message:', err instanceof ValidationError ? err.message : String(err));
        if (typeof requestId === 'string' && requestId.length <= 100) {
          send({ type: 'event', requestId, event: { type: 'error', code: 'bad_request', message: (err as Error).message } });
        }
      }
    }
  });

  // The browser closed the port: stop every agent so none outlives the panel.
  process.stdin.on('end', () => {
    log('port closed, stopping', running.size, 'request(s)');
    for (const c of running.values()) c.abort();
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
