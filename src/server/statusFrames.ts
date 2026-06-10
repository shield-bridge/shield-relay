import type { WireStatus } from '../core/jobs.js';

/**
 * A WebSocket status frame. NEVER includes paymentTxHash. `operationHash` and
 * `userTxHash` carry the same value on `completed` (different clients read
 * different field names; sending both is the safe superset).
 */
export interface StatusFrame {
  jobId: string;
  status: WireStatus | 'not_found';
  operationHash?: string;
  userTxHash?: string;
  error?: string;
}

export function frame(
  jobId: string,
  status: WireStatus | 'not_found',
  opts?: { opHash?: string; error?: string },
): StatusFrame {
  const f: StatusFrame = { jobId, status };
  if (opts?.opHash) {
    f.operationHash = opts.opHash;
    f.userTxHash = opts.opHash;
  }
  if (opts?.error) f.error = opts.error;
  return f;
}
