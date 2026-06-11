import { describe, it, expect } from 'vitest';
import { sumAppliedTransfersTo, paymentDigest, type SimContent, type SimInternalResult } from '../src/core/payment.js';

const WORKER = 'tz1WorkerOwnPublicKeyHash';
const ATTACKER = 'tz1AttackerControlledAddress';

/** Shape a simulate_operation result with a single Set-contract call whose internal
 *  ops are `internals`. `topStatus` is the top-level (sapling op) result status. */
function sim(internals: SimInternalResult[], topStatus = 'applied'): SimContent[] {
  return [{ metadata: { operation_result: { status: topStatus }, internal_operation_results: internals } }];
}

const transfer = (destination: string, amount: string, status = 'applied'): SimInternalResult => ({
  kind: 'transaction',
  destination,
  amount,
  result: { status },
});

describe('sumAppliedTransfersTo — the payment money-gate', () => {
  it('counts an applied unshield transfer to the worker tz1', () => {
    expect(sumAppliedTransfersTo(sim([transfer(WORKER, '1000000')]), WORKER)).toBe(1_000_000n);
  });

  it('IGNORES a transfer to anyone but the worker (the hijack attempt)', () => {
    // Attacker submits an unshield to THEIR own address → worker is paid 0 → rejected.
    expect(sumAppliedTransfersTo(sim([transfer(ATTACKER, '5000000')]), WORKER)).toBe(0n);
  });

  it('counts ZERO when the top-level sapling op did not apply (bad proof)', () => {
    expect(sumAppliedTransfersTo(sim([transfer(WORKER, '1000000')], 'failed'), WORKER)).toBe(0n);
  });

  it('skips an internal transfer that itself failed even if to the worker', () => {
    expect(sumAppliedTransfersTo(sim([transfer(WORKER, '1000000', 'failed')]), WORKER)).toBe(0n);
  });

  it('sums multiple applied transfers to the worker', () => {
    expect(
      sumAppliedTransfersTo(sim([transfer(WORKER, '600000'), transfer(WORKER, '400000')]), WORKER),
    ).toBe(1_000_000n);
  });

  it('counts only the worker-bound leg when transfers fan out', () => {
    expect(
      sumAppliedTransfersTo(sim([transfer(ATTACKER, '9000000'), transfer(WORKER, '1000000')]), WORKER),
    ).toBe(1_000_000n);
  });

  it('treats a missing internal-results list as 0 (no payout)', () => {
    expect(sumAppliedTransfersTo([{ metadata: { operation_result: { status: 'applied' } } }], WORKER)).toBe(0n);
  });

  it('ignores non-transaction internal ops (events, delegations)', () => {
    expect(
      sumAppliedTransfersTo(sim([{ kind: 'event', destination: WORKER, amount: '1000000', result: { status: 'applied' } }]), WORKER),
    ).toBe(0n);
  });
});

describe('paymentDigest — the replay key', () => {
  it('is stable for the same txns', () => {
    expect(paymentDigest({ txns: ['ab', 'cd'] })).toBe(paymentDigest({ txns: ['ab', 'cd'] }));
  });

  it('differs when the bytes differ', () => {
    expect(paymentDigest({ txns: ['ab'] })).not.toBe(paymentDigest({ txns: ['cd'] }));
  });

  it('is order-sensitive (concatenation, not a set)', () => {
    expect(paymentDigest({ txns: ['ab', 'cd'] })).not.toBe(paymentDigest({ txns: ['cd', 'ab'] }));
  });
});
