import { describe, it, expect } from 'vitest';
import { Processor } from '../src/runtime/processor.js';
import type { JobRow } from '../src/store/index.js';

/** A Processor wired with just enough stubs to exercise the submit-path money gates.
 *  The rejection paths throw BEFORE enqueue/dispatch, so queue/workers/wsHub are inert. */
function makeProcessor(job: Partial<JobRow>, legacyFlatMaxTxs = 0): Processor {
  const full: JobRow = {
    jobId: 'job-1', status: 'payment_confirmed', paymentPoolIndex: 0, broadcastPoolIndex: 1,
    memo: 'm', jobSecretHash: 'h', paymentTxHash: null, userTxHash: null, errorMessage: null,
    createdAt: 0, expiresAt: 0, quotedFeeMutez: 1_000_000, quotedTxCount: null, legacyQuote: 1,
    ...job,
  };
  const deps = {
    config: { REQUIRE_JOB_SECRET: false, legacyFlatMaxTxs },
    store: { getJob: () => full, enqueueWork: () => 1 },
    queue: { enqueue: () => Promise.resolve() },
    workers: [{ index: 0, tezosAddress: 'tz1' }],
    wsHub: { publish: () => undefined },
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    metrics: {},
  } as unknown as ConstructorParameters<typeof Processor>[0];
  return new Processor(deps);
}

const items = (n: number): { txns: string[] }[] => Array.from({ length: n }, () => ({ txns: ['ab'] }));

describe('Processor money gates', () => {
  it('submitPayment rejects a payment carrying >1 sapling tx', () => {
    const p = makeProcessor({ status: 'info_generated' });
    expect(() => p.submitPayment('job-1', undefined, { txns: ['ab', 'cd'] })).toThrow(/Too many sapling txns/);
  });

  it('submitPayment accepts exactly one sapling tx', () => {
    const p = makeProcessor({ status: 'info_generated' });
    expect(() => p.submitPayment('job-1', undefined, { txns: ['ab'] })).not.toThrow();
  });

  it('submitUserTransaction rejects beyond the hard MAX_INJECT_TXS backstop (even with no fee cap)', () => {
    const p = makeProcessor({ legacyQuote: 1, quotedTxCount: null }, 0); // legacy, cap off
    expect(() => p.submitUserTransaction('job-1', undefined, items(40))).toThrow(/hard limit/);
  });

  it('scheduled job: 402 when submitted count exceeds the quote', () => {
    const p = makeProcessor({ legacyQuote: 0, quotedTxCount: 1 });
    expect(() => p.submitUserTransaction('job-1', undefined, items(2))).toThrow(/paid fee covers/);
  });

  it('scheduled job: accepts at-or-under the quote', () => {
    const p = makeProcessor({ legacyQuote: 0, quotedTxCount: 3 });
    expect(() => p.submitUserTransaction('job-1', undefined, items(3))).not.toThrow();
  });

  it('legacy job: 402 when batch exceeds LEGACY_FLAT_MAX_TXS', () => {
    const p = makeProcessor({ legacyQuote: 1, quotedTxCount: null }, 5);
    expect(() => p.submitUserTransaction('job-1', undefined, items(6))).toThrow(/update your client/);
  });
});
