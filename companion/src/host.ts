import type { AgentId, AgentStatus, CompanionMessage, ExtensionMessage } from '@quack/shared';
import { ALLOWED_EXTENSION_IDS, PROTOCOL_VERSION, QUACK_VERSION } from '@quack/shared';
import { adapters } from './adapters/index.ts';
import { listFailingChecks } from './checks.ts';
import { MessageDecoder, encodeMessage } from './framing.ts';
import { log } from './log.ts';
import { handleAsk } from './session.ts';
import { ValidationError, validateMessage } from './validate.ts';

const STATUS_TTL_MS = 60_000;
// Chrome limits host-to-extension native messages to 1 MB; chunk large text deltas to 64 KB.
const MAX_TEXT_DELTA = 64 * 1024;

/** Checks whether the caller's `chrome-extension://<id>/` origin is allowlisted. */
export function isAllowedOrigin(origin: string | undefined): boolean {
  return ALLOWED_EXTENSION_IDS.some((id) => origin === `chrome-extension://${id}/`);
}

/** Runs the Chrome Native Messaging stdio event loop for an allowlisted extension origin. */
export function startHost(origin: string | undefined): void {
  if (!isAllowedOrigin(origin)) {
    log('rejected caller origin', String(origin));
    process.exit(1);
  }
  log('host started', QUACK_VERSION);

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

  const statusCache = new Map<AgentId, { at: number; status: AgentStatus }>();
  const refreshStatus = async (id: AgentId): Promise<AgentStatus> => {
    const status = await adapters[id].isAvailable();
    statusCache.set(id, { at: Date.now(), status });
    return status;
  };
  // Stale-while-revalidate: return cached 'ready' status immediately and refresh
  // in the background after STATUS_TTL_MS. Non-ready states always re-check.
  const cachedStatus = async (id: AgentId): Promise<AgentStatus> => {
    const hit = statusCache.get(id);
    if (hit?.status.state !== 'ready') return refreshStatus(id);
    if (Date.now() - hit.at >= STATUS_TTL_MS) {
      hit.at = Date.now();
      refreshStatus(id).catch(() => {});
    }
    return hit.status;
  };

  const running = new Map<string, AbortController>();

  const handle = (message: ExtensionMessage) => {
    switch (message.type) {
      case 'status': {
        // Emit an immediate status response so the extension detects the host,
        // then emit incremental updates as each agent probe completes.
        const ids = Object.keys(adapters) as AgentId[];
        const done = new Map<AgentId, AgentStatus>();
        const report = () =>
          send({
            type: 'status',
            requestId: message.requestId,
            version: QUACK_VERSION,
            protocol: PROTOCOL_VERSION,
            agents: ids.flatMap((id) => done.get(id) ?? []),
            pending: ids.filter((id) => !done.has(id)),
          });
        report();
        for (const id of ids) {
          refreshStatus(id).then((status) => {
            done.set(id, status);
            report();
          });
        }
        break;
      }
      case 'cancel':
        running.get(message.requestId)?.abort();
        break;
      case 'close_session':
        adapters[message.agent].closeSession?.(message.sessionId);
        break;
      case 'checks':
        listFailingChecks(message.pr)
          .then((result) => send({ type: 'checks', requestId: message.requestId, ...result }))
          .catch((err) => {
            log('checks failed', String(err));
            send({ type: 'checks', requestId: message.requestId, failing: [], available: false });
          });
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

  // When the browser closes the native port, abort in-flight requests and terminate agent processes.
  process.stdin.on('end', () => {
    log('port closed, stopping', running.size, 'request(s)');
    for (const c of running.values()) c.abort();
    for (const adapter of Object.values(adapters)) adapter.shutdown?.();
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
