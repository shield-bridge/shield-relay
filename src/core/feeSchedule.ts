/**
 * Quantized linear relay fee schedule (FEE_SCHEDULE.md).
 *
 *   fee(txCount) = quantizeUp(baseMutez + perTxMutez × txCount, quantumMutez)
 *
 * Pure + deterministic so it can be evaluated identically on the client (preview)
 * and the relay (binding quote). All amounts are integer mutez (bigint) — never
 * float tez. Ships DARK: the relay's default params (base=PAYMENT_AMOUNT, perTx=0,
 * quantum=1) make this reproduce the flat fee for every txCount.
 */

export interface FeeParams {
  baseMutez: bigint;
  perTxMutez: bigint;
  quantumMutez: bigint;
}

/** Round UP to the next multiple of `quantum` (privacy quantization). quantum ≤ 1 is a no-op. */
export function quantizeUp(value: bigint, quantum: bigint): bigint {
  if (quantum <= 1n) return value;
  const rem = value % quantum;
  return rem === 0n ? value : value + (quantum - rem);
}

/** Binding fee (mutez) for a job that will submit `txCount` sapling txns. txCount clamps to ≥ 1. */
export function quoteFee(txCount: number, p: FeeParams): bigint {
  const n = BigInt(Math.max(1, Math.trunc(txCount)));
  return quantizeUp(p.baseMutez + p.perTxMutez * n, p.quantumMutez);
}

/**
 * Phase-2 enforcement: does the submitted sapling-tx count fit what the job paid for?
 * A scheduled job is capped at its quoted count; a legacy (flat) job is capped at
 * `legacyFlatMaxTxs` (0 = no cap, the dark default). Submitting FEWER is always fine.
 * The cost of a too-low quote falls on the client — by Phase 2 the fee is already
 * spent and there is no top-up (FEE_SCHEDULE.md §3.3).
 */
export function checkSubmittedTxCount(
  actualTxCount: number,
  job: { legacyQuote: boolean; quotedTxCount: number | null },
  legacyFlatMaxTxs: number,
): { ok: true } | { ok: false; reason: string } {
  const cap = job.legacyQuote
    ? legacyFlatMaxTxs > 0
      ? legacyFlatMaxTxs
      : Number.POSITIVE_INFINITY
    : (job.quotedTxCount ?? Number.POSITIVE_INFINITY);

  if (actualTxCount > cap) {
    return {
      ok: false,
      reason: job.legacyQuote
        ? `This batch has ${actualTxCount} sapling transactions but the flat fee covers ${cap}. Please update your client to the fee-schedule protocol.`
        : `This batch has ${actualTxCount} sapling transactions but the paid fee covers ${job.quotedTxCount}.`,
    };
  }
  return { ok: true };
}
