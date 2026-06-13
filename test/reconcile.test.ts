import { describe, it, expect } from 'vitest';
import { classifyTaskError } from '../src/runtime/reconcile.js';

describe('classifyTaskError (post-broadcast fund-safety)', () => {
  const MAX = 8;

  it('fails terminally only when nothing was broadcast', () => {
    expect(classifyTaskError('none', 0, MAX)).toBe('fail');
    expect(classifyTaskError('none', 99, MAX)).toBe('fail');
  });

  it('reconciles (never fails) once a broadcast is in flight, within the retry budget', () => {
    // 'broadcasting' = counter pinned + sent, hash not yet recorded (crash window).
    expect(classifyTaskError('broadcasting', 0, MAX)).toBe('reconcile');
    // 'broadcast' = op hash recorded, awaiting/handling confirmation.
    expect(classifyTaskError('broadcast', 0, MAX)).toBe('reconcile');
    expect(classifyTaskError('broadcast', MAX - 1, MAX)).toBe('reconcile');
  });

  it('parks (leaves recoverable, never *_failed) once the reconcile budget is exhausted', () => {
    expect(classifyTaskError('broadcast', MAX, MAX)).toBe('park');
    expect(classifyTaskError('broadcasting', MAX + 5, MAX)).toBe('park');
  });

  it('never returns "fail" for any in-flight broadcast state — the core invariant', () => {
    for (const state of ['broadcasting', 'broadcast', 'confirmed'] as const) {
      for (let tries = 0; tries <= MAX + 2; tries++) {
        expect(classifyTaskError(state, tries, MAX)).not.toBe('fail');
      }
    }
  });
});
