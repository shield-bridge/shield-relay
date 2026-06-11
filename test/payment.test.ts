import { describe, it, expect } from 'vitest';
import {
  sumAppliedTransfersTo,
  paymentDigest,
  verifyPaymentLanded,
  verifyPaymentLandedByScan,
  type SimContent,
  type SimInternalResult,
} from '../src/core/payment.js';
import type { TezosToolkit } from '@tezos-x/octez.js';

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

/** A client whose rpc.getBlock returns `block` (the manager-ops pass we care about). */
function clientWithBlock(block: unknown): TezosToolkit {
  return { rpc: { getBlock: async () => block } } as unknown as TezosToolkit;
}
/** Shape a block whose manager pass (index 3) holds one op `hash` with `contents`. */
const blockWith = (hash: string, contents: SimContent[]) => ({ operations: [[], [], [], [{ hash, contents }]] });

describe('verifyPaymentLanded — the post-confirmation malleability backstop', () => {
  const HASH = 'opABC';
  const applied = (dest: string, amount: string, status = 'applied'): SimContent[] => [
    { metadata: { operation_result: { status: 'applied' }, internal_operation_results: [{ kind: 'transaction', destination: dest, amount, result: { status } }] } },
  ];

  it('accepts an APPLIED op that paid the worker >= fee', async () => {
    const c = clientWithBlock(blockWith(HASH, applied(WORKER, '1000000')));
    expect(await verifyPaymentLanded(c, HASH, 42, WORKER, 1_000_000n)).toEqual({ ok: true, receivedMutez: 1_000_000n });
  });

  it('REJECTS a same-note loser whose top-level op landed as failed', async () => {
    // The malleability race: this op was included but failed (nullifier double-spend).
    const failed: SimContent[] = [{ metadata: { operation_result: { status: 'failed' }, internal_operation_results: [] } }];
    expect((await verifyPaymentLanded(c0(failed), HASH, 42, WORKER, 1_000_000n)).ok).toBe(false);
  });

  it('REJECTS when the op is not found at the level (reorg)', async () => {
    const c = clientWithBlock({ operations: [[], [], [], [{ hash: 'someOtherOp', contents: applied(WORKER, '1000000') }]] });
    expect((await verifyPaymentLanded(c, HASH, 42, WORKER, 1_000_000n)).ok).toBe(false);
  });

  it('REJECTS an applied op that underpaid the worker', async () => {
    const c = clientWithBlock(blockWith(HASH, applied(WORKER, '999999')));
    expect((await verifyPaymentLanded(c, HASH, 42, WORKER, 1_000_000n)).ok).toBe(false);
  });
});

function c0(contents: SimContent[]): TezosToolkit {
  return clientWithBlock({ operations: [[], [], [], [{ hash: 'opABC', contents }]] });
}

describe('verifyPaymentLandedByScan — resume-path recovery (no persisted level)', () => {
  const HASH = 'opRESUME';
  const tx = (dest: string, amount: string, status = 'applied'): SimContent[] => [
    { metadata: { operation_result: { status: 'applied' }, internal_operation_results: [{ kind: 'transaction', destination: dest, amount, result: { status } }] } },
  ];
  /** client whose head is at `headLevel` and whose block at `opLevel` holds `contents`. */
  function scanClient(headLevel: number, opLevel: number, contents: SimContent[]): TezosToolkit {
    return {
      rpc: {
        getBlockHeader: async () => ({ level: headLevel }),
        getBlock: async ({ block }: { block: string }) =>
          Number(block) === opLevel
            ? { operations: [[], [], [], [{ hash: HASH, contents }]] }
            : { operations: [[], [], [], []] },
      },
    } as unknown as TezosToolkit;
  }

  it('finds an applied op a few blocks back and accepts (checked + ok)', async () => {
    const c = scanClient(100, 98, tx(WORKER, '1000000'));
    expect(await verifyPaymentLandedByScan(c, HASH, WORKER, 1_000_000n, 60)).toEqual({ checked: true, ok: true, receivedMutez: 1_000_000n });
  });

  it('finds a FAILED loser in the window and rejects (checked + !ok)', async () => {
    const failed: SimContent[] = [{ metadata: { operation_result: { status: 'failed' }, internal_operation_results: [] } }];
    const c = scanClient(100, 97, failed);
    const r = await verifyPaymentLandedByScan(c, HASH, WORKER, 1_000_000n, 60);
    expect(r.checked).toBe(true);
    expect(r.ok).toBe(false);
  });

  it('returns checked:false when the op is older than the scan window (long downtime)', async () => {
    const c = scanClient(100, 20, tx(WORKER, '1000000')); // 80 blocks back, depth 60
    expect((await verifyPaymentLandedByScan(c, HASH, WORKER, 1_000_000n, 60)).checked).toBe(false);
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
