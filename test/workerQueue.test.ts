import { describe, it, expect } from 'vitest';
import { WorkerQueue } from '../src/runtime/workerQueue.js';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('WorkerQueue (the sequential-per-worker invariant)', () => {
  it('serializes tasks on the SAME worker — no overlap, FIFO order', async () => {
    const q = new WorkerQueue();
    const events: string[] = [];
    const task = (id: string, ms: number) => async () => {
      events.push(`${id}:start`);
      await delay(ms);
      events.push(`${id}:end`);
    };
    // 'a' is slower than 'b' but enqueued first: it must still fully finish first.
    const pa = q.enqueue(0, task('a', 30));
    const pb = q.enqueue(0, task('b', 5));
    await Promise.all([pa, pb]);
    expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });

  it('runs DIFFERENT workers concurrently', async () => {
    const q = new WorkerQueue();
    const events: string[] = [];
    const task = (id: string, ms: number) => async () => {
      events.push(`${id}:start`);
      await delay(ms);
      events.push(`${id}:end`);
    };
    await Promise.all([q.enqueue(0, task('a', 30)), q.enqueue(1, task('b', 5))]);
    // worker 1's fast task finishes before worker 0's slow one → genuine concurrency
    expect(events.indexOf('b:end')).toBeLessThan(events.indexOf('a:end'));
    expect(events.slice(0, 2).sort()).toEqual(['a:start', 'b:start']);
  });

  it('a failing task does NOT poison the worker chain', async () => {
    const q = new WorkerQueue();
    const ran: string[] = [];
    const pa = q.enqueue(0, async () => {
      throw new Error('boom');
    });
    const pb = q.enqueue(0, async () => {
      ran.push('b');
      return 'ok';
    });
    await expect(pa).rejects.toThrow('boom');
    await expect(pb).resolves.toBe('ok');
    expect(ran).toEqual(['b']);
  });

  it('tracks queue depth per worker', async () => {
    const q = new WorkerQueue();
    const p = q.enqueue(0, () => delay(20));
    q.enqueue(0, () => delay(20));
    expect(q.queueDepth(0)).toBe(2);
    expect(q.queueDepth(1)).toBe(0);
    await p;
  });
});
