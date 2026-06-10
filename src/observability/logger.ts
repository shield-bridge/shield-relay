import { pino } from 'pino';
import type { Config } from '../config/schema.js';

/**
 * Structured JSON logger with a hard redaction allowlist — secret material must
 * never reach the logs. paymentTxHash is redacted too (it is never client-facing).
 */
export function createLogger(cfg: Config) {
  return pino({
    level: cfg.LOG_LEVEL,
    redact: {
      paths: [
        'saplingMnemonic',
        'tezosSecretKey',
        'jobSecret',
        '*.jobSecret',
        'paymentTxHash',
        '*.paymentTxHash',
        'pool',
        '*.pool',
      ],
      censor: '[redacted]',
    },
  });
}

export type Logger = ReturnType<typeof createLogger>;
