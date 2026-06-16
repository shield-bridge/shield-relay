import { describe, it, expect } from 'vitest';
import { quantizeUp, quoteFee, checkSubmittedTxCount, type FeeParams } from '../src/core/feeSchedule.js';

// The recommended (opt-in) schedule from FEE_SCHEDULE.md §2.
const SCHED: FeeParams = { baseMutez: 300_000n, perTxMutez: 270_000n, quantumMutez: 250_000n };
// The dark default — reproduces the flat 1 XTZ for every txCount.
const DARK: FeeParams = { baseMutez: 1_000_000n, perTxMutez: 0n, quantumMutez: 1n };

describe('quantizeUp', () => {
  it('rounds up to the next multiple; exact multiples unchanged', () => {
    expect(quantizeUp(400_000n, 250_000n)).toBe(500_000n);
    expect(quantizeUp(500_000n, 250_000n)).toBe(500_000n);
    expect(quantizeUp(1n, 250_000n)).toBe(250_000n);
  });
  it('quantum <= 1 is a no-op', () => {
    expect(quantizeUp(1_234_567n, 1n)).toBe(1_234_567n);
    expect(quantizeUp(1_234_567n, 0n)).toBe(1_234_567n);
  });
});

describe('quoteFee', () => {
  it('matches the FEE_SCHEDULE.md tier table for the recommended schedule', () => {
    expect(quoteFee(1, SCHED)).toBe(750_000n); // 0.57 → 0.75
    expect(quoteFee(2, SCHED)).toBe(1_000_000n); // 0.84 → 1.00
    expect(quoteFee(3, SCHED)).toBe(1_250_000n); // 1.11 → 1.25
    expect(quoteFee(5, SCHED)).toBe(1_750_000n); // 1.65 → 1.75
    expect(quoteFee(10, SCHED)).toBe(3_000_000n); // 3.00 → 3.00
    // Every charged fee lands on the 0.25-XTZ quantum grid (a multiple of quantum).
    const fees = Array.from({ length: 10 }, (_, i) => quoteFee(i + 1, SCHED));
    for (const f of fees) expect(f % 250_000n).toBe(0n);
    // perTx (270k) > quantum (250k) ⇒ each step advances a quantum: NO value-collapse.
    expect(new Set(fees).size).toBe(10);
  });

  it('DARK defaults reproduce the flat fee for every txCount', () => {
    for (const n of [1, 2, 5, 10, 50]) expect(quoteFee(n, DARK)).toBe(1_000_000n);
  });

  it('clamps txCount to >= 1', () => {
    expect(quoteFee(0, SCHED)).toBe(quoteFee(1, SCHED));
    expect(quoteFee(-5, SCHED)).toBe(quoteFee(1, SCHED));
  });
});

describe('checkSubmittedTxCount (Phase-2 gate)', () => {
  it('scheduled job: rejects more than quoted, allows equal/fewer', () => {
    const job = { legacyQuote: false, quotedTxCount: 3 };
    expect(checkSubmittedTxCount(4, job, 0).ok).toBe(false);
    expect(checkSubmittedTxCount(3, job, 0).ok).toBe(true);
    expect(checkSubmittedTxCount(1, job, 0).ok).toBe(true);
  });

  it('legacy job: capped by legacyFlatMaxTxs; 0 = no cap (dark)', () => {
    const job = { legacyQuote: true, quotedTxCount: null };
    expect(checkSubmittedTxCount(10, job, 0).ok).toBe(true); // cap off → anything passes
    expect(checkSubmittedTxCount(6, job, 5).ok).toBe(false); // cap 5 → 6 rejected
    expect(checkSubmittedTxCount(5, job, 5).ok).toBe(true);
  });

  it('rejection reasons name the right limit', () => {
    const sched = checkSubmittedTxCount(9, { legacyQuote: false, quotedTxCount: 2 }, 0);
    expect(sched.ok).toBe(false);
    if (!sched.ok) expect(sched.reason).toContain('covers 2');
    const legacy = checkSubmittedTxCount(9, { legacyQuote: true, quotedTxCount: null }, 5);
    expect(legacy.ok).toBe(false);
    if (!legacy.ok) expect(legacy.reason).toContain('update your client');
  });
});
