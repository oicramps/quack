import type { BackendId } from '@quack/shared';
import { claudeAdapter } from './claude.ts';
import { cursorAdapter } from './cursor.ts';
import type { Adapter } from './types.ts';

export const adapters: Record<BackendId, Adapter> = {
  cursor: cursorAdapter,
  'claude-code': claudeAdapter,
};
