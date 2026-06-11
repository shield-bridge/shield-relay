import { randomUUID } from 'node:crypto';
import type { Store } from '../store/index.js';
import type { Config } from '../config/schema.js';
import type { Logger } from '../observability/logger.js';

export interface Alert {
  kind: string;
  message: string;
  data?: Record<string, unknown>;
}

// attempt index → delay before that attempt: 0s, 30s, 2m, 10m, 1h
const BACKOFF_MS = [0, 30_000, 120_000, 600_000, 3_600_000];
const MAX_ATTEMPTS = BACKOFF_MS.length;

/**
 * Durable, retrying alerter. Critical conditions (e.g. a worker's low gas balance) are
 * persisted to `alert_outbox` and delivered to ALERT_WEBHOOK_URL with backoff, so
 * a transient webhook outage doesn't lose the alert. Always logged regardless.
 */
export class Alerter {
  constructor(
    private readonly store: Store,
    private readonly cfg: Config,
    private readonly logger: Logger,
  ) {}

  raise(alert: Alert): void {
    this.logger.warn({ alert: alert.kind, message: alert.message, data: alert.data }, 'alert raised');
    this.store.enqueueAlert(randomUUID(), JSON.stringify(alert));
  }

  /** Start the delivery loop. Returns a stop() function. */
  startDrainLoop(): () => void {
    const tick = async (): Promise<void> => {
      const url = this.cfg.ALERT_WEBHOOK_URL;
      if (!url) return; // no sink configured — alerts persist in the outbox + logs
      for (const row of this.store.listDueAlerts(Date.now(), 10)) {
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: row.payloadJson,
          });
          if (!res.ok) throw new Error(`webhook responded ${res.status}`);
          this.store.deleteAlert(row.id);
        } catch (e) {
          const attempts = row.attempts + 1;
          if (attempts >= MAX_ATTEMPTS) {
            this.logger.error({ id: row.id }, 'alert dropped after max retries');
            this.store.deleteAlert(row.id);
            continue;
          }
          this.store.bumpAlertAttempt(row.id, Date.now() + (BACKOFF_MS[attempts] ?? 3_600_000));
          this.logger.warn({ id: row.id, attempts, err: String(e) }, 'alert delivery failed; will retry');
        }
      }
    };
    const timer = setInterval(() => void tick(), 15_000);
    timer.unref();
    return () => clearInterval(timer);
  }
}
