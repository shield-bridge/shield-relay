import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { SqliteStore } from '../src/store/sqlite.js';
import { relayLiveness } from '../src/cli/jobs.js';
import type { JobStatus, WorkKind } from '../src/store/index.js';

function freshStore(): SqliteStore {
  const s = new SqliteStore(':memory:');
  s.init();
  return s;
}

let seq = 0;
/** Seed a job + one work row, drive it to a chosen (work.state, job.status), and
 *  optionally pin a broadcast so we can assert retry PRESERVES the broadcast columns. */
function seedFailed(
  store: SqliteStore,
  kind: WorkKind,
  jobStatus: JobStatus,
  opts: { pinnedCounter?: number; opHash?: string; errorMessage?: string; workState?: 'failed' | 'running' } = {},
): { jobId: string; taskId: string } {
  const jobId = `job-test-${seq++}`;
  const taskId = `task-${seq++}`;
  store.createJob({
    jobId,
    paymentPoolIndex: 0,
    broadcastPoolIndex: kind === 'inject_user_tx' ? 1 : 0,
    memo: `memo-${jobId}`,
    jobSecretHash: 'hash',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  });
  // enqueueWork is conditional on the pre-enqueue status; move the job there first.
  const pre: JobStatus = kind === 'inject_user_tx' ? 'payment_confirmed' : 'info_generated';
  store.setJobStatus(jobId, pre);
  const next: JobStatus = kind === 'inject_user_tx' ? 'injecting_user_tx' : 'queued';
  store.enqueueWork({ taskId, jobId, poolIndex: kind === 'inject_user_tx' ? 1 : 0, kind, payloadJson: JSON.stringify({ txns: ['ab', 'cd'] }) }, pre, next);
  if (opts.pinnedCounter != null) store.setBroadcasting(taskId, opts.pinnedCounter); // sets broadcastState + attempts+1
  if (opts.opHash) store.setBroadcast(taskId, opts.opHash);
  store.setWorkState(taskId, opts.workState ?? 'failed');
  store.setJobStatus(jobId, jobStatus, { errorMessage: opts.errorMessage });
  return { jobId, taskId };
}

describe('dead-letter ops — store layer', () => {
  it('retryWork(inject_user_tx): failed→queued, job→injecting_user_tx, error cleared, broadcast columns PRESERVED', () => {
    const store = freshStore();
    const { jobId, taskId } = seedFailed(store, 'inject_user_tx', 'user_tx_failed', {
      pinnedCounter: 42,
      opHash: 'op-landed',
      errorMessage: 'confirmation timeout',
    });

    const r = store.retryWork(taskId);
    expect(r).toMatchObject({ changed: true, kind: 'inject_user_tx', jobId });

    const w = store.getWork(taskId)!;
    expect(w.state).toBe('queued');
    // The crux: leaving these intact is what arms broadcastAlreadyLanded on the next boot,
    // so an op that already landed is NOT re-broadcast.
    expect(w.pinnedCounter).toBe(42);
    expect(w.opHash).toBe('op-landed');
    expect(w.broadcastState).toBe('broadcast');
    expect(w.attempts).toBe(1); // from setBroadcasting; retry must not reset history

    const job = store.getJob(jobId)!;
    expect(job.status).toBe('injecting_user_tx'); // post-enqueue status blocks a duplicate re-submit
    expect(job.errorMessage).toBeNull();
  });

  it('retryWork(inject_payment): failed→queued, job→queued (not info_generated)', () => {
    const store = freshStore();
    const { jobId, taskId } = seedFailed(store, 'inject_payment', 'payment_failed', { errorMessage: 'rpc blip' });
    const r = store.retryWork(taskId);
    expect(r.changed).toBe(true);
    expect(store.getWork(taskId)!.state).toBe('queued');
    expect(store.getJob(jobId)!.status).toBe('queued');
    expect(store.getJob(jobId)!.errorMessage).toBeNull();
  });

  it('retryWork is idempotent — a non-failed row is a no-op', () => {
    const store = freshStore();
    const { taskId } = seedFailed(store, 'inject_payment', 'payment_failed');
    expect(store.retryWork(taskId).changed).toBe(true);
    const second = store.retryWork(taskId); // now 'queued'
    expect(second.changed).toBe(false);
    expect(store.getWork(taskId)!.state).toBe('queued');
  });

  it('retryWork on a missing task → changed:false, no throw', () => {
    const store = freshStore();
    expect(store.retryWork('nope').changed).toBe(false);
  });

  it('discardWork: forces terminal, stamps discardedAt, never deletes, excluded from rehydrate', () => {
    const store = freshStore();
    // A 'running' inject_user_tx (crash-orphaned) the operator chooses to abandon.
    const { jobId, taskId } = seedFailed(store, 'inject_user_tx', 'injecting_user_tx', { workState: 'running' });
    expect(store.listNonTerminalWork().some((w) => w.taskId === taskId)).toBe(true);

    const r = store.discardWork(taskId);
    expect(r).toMatchObject({ changed: true, kind: 'inject_user_tx' });

    const w = store.getWork(taskId)!;
    expect(w.state).toBe('failed');
    expect(w.discardedAt).toBeTypeOf('number');
    // Terminal ⟹ never rehydrated.
    expect(store.listNonTerminalWork().some((x) => x.taskId === taskId)).toBe(false);

    const job = store.getJob(jobId)!;
    expect(job.status).toBe('user_tx_failed');
    expect(job.errorMessage).toBe('discarded by operator');
    // Row still present (additive, never DELETE).
    expect(store.getWork(taskId)).toBeDefined();
  });

  it('discardWork is idempotent — second discard is a no-op', () => {
    const store = freshStore();
    const { taskId } = seedFailed(store, 'inject_payment', 'payment_failed');
    expect(store.discardWork(taskId).changed).toBe(true);
    expect(store.discardWork(taskId).changed).toBe(false);
  });

  it('discardWork REFUSES a completed (done) row — never corrupts a delivered job', () => {
    const store = freshStore();
    // Build a genuine completed inject_user_tx record via completeWork.
    const jobId = 'job-done-1', taskId = 'task-done-1';
    store.createJob({ jobId, paymentPoolIndex: 0, broadcastPoolIndex: 1, memo: 'm', jobSecretHash: 'h', expiresAt: Math.floor(Date.now() / 1000) + 3600 });
    store.setJobStatus(jobId, 'payment_confirmed');
    store.enqueueWork({ taskId, jobId, poolIndex: 1, kind: 'inject_user_tx', payloadJson: JSON.stringify({ txns: ['aa'] }) }, 'payment_confirmed', 'injecting_user_tx');
    store.setBroadcasting(taskId, 7);
    store.completeWork(taskId, jobId, 'completed', 'op-final'); // state=done, broadcastState=confirmed, userTxHash=op-final

    const r = store.discardWork(taskId);
    expect(r.changed).toBe(false);
    const w = store.getWork(taskId)!;
    expect(w.state).toBe('done'); // untouched
    expect(w.discardedAt).toBeNull();
    const job = store.getJob(jobId)!;
    expect(job.status).toBe('completed'); // NOT flipped to *_failed
    expect(job.userTxHash).toBe('op-final'); // delivery record intact
  });

  it('listWork: failed-only by default excludes done; includeDiscarded controls discarded visibility', () => {
    const store = freshStore();
    const a = seedFailed(store, 'inject_payment', 'payment_failed');
    const b = seedFailed(store, 'inject_user_tx', 'user_tx_failed');
    seedFailed(store, 'inject_payment', 'completed', { workState: 'failed' }); // we'll mark done below
    // mark one row 'done'
    const doneRow = seedFailed(store, 'inject_user_tx', 'completed');
    store.setWorkState(doneRow.taskId, 'done');

    const failed = store.listWork({ states: ['failed'] });
    expect(failed.map((w) => w.taskId).sort()).toContain(a.taskId);
    expect(failed.map((w) => w.taskId)).toContain(b.taskId);
    expect(failed.map((w) => w.taskId)).not.toContain(doneRow.taskId);

    // Discard b, then it should drop from the default (non-discarded) view but show with includeDiscarded.
    store.discardWork(b.taskId);
    expect(store.listWork({ states: ['failed'] }).map((w) => w.taskId)).not.toContain(b.taskId);
    expect(store.listWork({ states: ['failed'], includeDiscarded: true }).map((w) => w.taskId)).toContain(b.taskId);

    // jobId + kind filters
    expect(store.listWork({ jobId: a.jobId }).every((w) => w.jobId === a.jobId)).toBe(true);
    expect(store.listWork({ kind: 'inject_payment' }).every((w) => w.kind === 'inject_payment')).toBe(true);
  });

  it('getInstanceLock: undefined until acquired, then reflects holder', () => {
    const store = freshStore();
    expect(store.getInstanceLock()).toBeUndefined();
    expect(store.tryAcquireInstanceLock('host:1:abcd', 60_000)).toBe(true);
    const lock = store.getInstanceLock()!;
    expect(lock.holder).toBe('host:1:abcd');
    expect(lock.heartbeatAt).toBeTypeOf('number');
  });

  it('countJobsByStatus + countActiveWorkByPool: status aggregates', () => {
    const store = freshStore();
    seedFailed(store, 'inject_payment', 'payment_failed');
    seedFailed(store, 'inject_user_tx', 'user_tx_failed');
    seedFailed(store, 'inject_user_tx', 'injecting_user_tx', { workState: 'running' });
    const queued = seedFailed(store, 'inject_payment', 'queued', { workState: 'failed' });
    store.setWorkState(queued.taskId, 'queued'); // a live-queued row on pool 0

    const byStatus = new Map(store.countJobsByStatus().map((r) => [r.status, r.count]));
    expect(byStatus.get('payment_failed')).toBe(1);
    expect(byStatus.get('user_tx_failed')).toBe(1);
    expect(byStatus.get('injecting_user_tx')).toBe(1);
    expect(byStatus.get('queued')).toBe(1);

    // Active = queued|running only (the two failed rows are terminal, excluded).
    const active = store.countActiveWorkByPool();
    const pool0 = active.find((a) => a.poolIndex === 0);
    const pool1 = active.find((a) => a.poolIndex === 1);
    expect(pool0).toMatchObject({ queued: 1, running: 0 }); // the inject_payment queued row
    expect(pool1).toMatchObject({ queued: 0, running: 1 }); // the running inject_user_tx
  });

  it('relayLiveness: the load-bearing offline-gate predicate (none / fresh / stale boundary)', () => {
    expect(relayLiveness(undefined, 1_000)).toBeUndefined(); // no lock → not live
    // STALE_MS is 60_000: heartbeat at t=0, now=59s → live; now=60s → stale (reclaimable).
    expect(relayLiveness({ holder: 'h', heartbeatAt: 0 }, 59_000)).toMatchObject({ holder: 'h' });
    expect(relayLiveness({ holder: 'h', heartbeatAt: 0 }, 60_000)).toBeUndefined();
    expect(relayLiveness({ holder: 'h', heartbeatAt: 0 }, 61_000)).toBeUndefined();
  });
});

describe('dead-letter ops — migration', () => {
  const path = join(tmpdir(), `relay-mig-${process.pid}.db`);
  afterEach(() => {
    for (const ext of ['', '-wal', '-shm']) {
      try {
        rmSync(path + ext);
      } catch {
        /* ignore */
      }
    }
  });

  it('init() is idempotent — re-opening an existing DB does not double-add discardedAt', () => {
    const a = new SqliteStore(path);
    a.init();
    a.close();
    // Second open must run migrate() against a DB that already has the column — no throw.
    const b = new SqliteStore(path);
    expect(() => b.init()).not.toThrow();
    b.close();
  });
});
