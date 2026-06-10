import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Store } from '../store/index.js';
import type { Logger } from '../observability/logger.js';

const STALE_MS = 60_000; // a holder whose heartbeat is older than this is presumed dead
const HEARTBEAT_MS = 20_000;

export interface InstanceLockHandle {
  holder: string;
  release: () => void;
}

/**
 * Single-instance guard. Two relay processes sharing the same SQLite file would
 * corrupt state and double-broadcast (the per-worker queue only serializes
 * WITHIN a process). Acquire an exclusive lock (heartbeated) or refuse to start.
 */
export function acquireInstanceLock(store: Store, logger: Logger): InstanceLockHandle {
  const holder = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  if (!store.tryAcquireInstanceLock(holder, STALE_MS)) {
    throw new Error(
      'Another relay instance is already running on this data dir. Refusing to start — two processes on one pool would corrupt state and double-broadcast.',
    );
  }
  const timer = setInterval(() => store.heartbeatInstanceLock(holder), HEARTBEAT_MS);
  timer.unref();
  logger.info({ holder }, 'instance lock acquired');
  return {
    holder,
    release: () => {
      clearInterval(timer);
      store.releaseInstanceLock(holder);
    },
  };
}
