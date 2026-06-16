import { describe, it, expect } from 'vitest';
import { ConfigSchema } from '../src/config/schema.js';

describe('ConfigSchema fee guards', () => {
  it('accepts the defaults (effective base = flat amount)', () => {
    const r = ConfigSchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.fee.baseMutez).toBe(1_000_000n);
  });

  it('rejects a zero effective base (would make payment verification vacuous)', () => {
    expect(ConfigSchema.safeParse({ PAYMENT_AMOUNT_MUTEZ: '0' }).success).toBe(false);
    expect(ConfigSchema.safeParse({ FEE_BASE_MUTEZ: '0' }).success).toBe(false);
  });

  it('rejects a negative base/per-tx via the nonnegative guards', () => {
    expect(ConfigSchema.safeParse({ FEE_BASE_MUTEZ: '-100' }).success).toBe(false);
    expect(ConfigSchema.safeParse({ FEE_PER_TX_MUTEZ: '-1' }).success).toBe(false);
    expect(ConfigSchema.safeParse({ PAYMENT_AMOUNT_MUTEZ: '-1' }).success).toBe(false);
  });

  it('FEE_BASE_MUTEZ overrides the payment amount as the base', () => {
    const r = ConfigSchema.safeParse({ FEE_BASE_MUTEZ: '300000', FEE_PER_TX_MUTEZ: '270000', FEE_QUANTUM_MUTEZ: '250000' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.fee.baseMutez).toBe(300_000n);
      expect(r.data.fee.perTxMutez).toBe(270_000n);
    }
  });
});
