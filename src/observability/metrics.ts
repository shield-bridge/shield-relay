import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from 'prom-client';

/**
 * Prometheus metrics — operator-facing health series. They map to the operator's
 * real questions: is a worker stalled (queue depth), are we earning + solvent
 * (gas balance), how slow is broadcasting (broadcast duration), and is anyone
 * replaying (payment rejections).
 */
export class Metrics {
  readonly registry = new Registry();
  readonly jobs: Counter<'status'>;
  readonly paymentReplayRejected: Counter<string>;
  readonly broadcast: Histogram<'kind'>;
  readonly queueDepth: Gauge<'worker'>;
  readonly gasBalance: Gauge<'worker'>;

  constructor() {
    collectDefaultMetrics({ register: this.registry });
    this.jobs = new Counter({
      name: 'relay_job_transitions_total',
      help: 'Count of job status transitions',
      labelNames: ['status'] as const,
      registers: [this.registry],
    });
    this.paymentReplayRejected = new Counter({
      name: 'relay_payment_replay_rejected_total',
      help: 'Payments rejected as already-consumed (replay/double-pay firewall)',
      registers: [this.registry],
    });
    this.broadcast = new Histogram({
      name: 'relay_broadcast_seconds',
      help: 'Broadcast + confirmation duration by phase',
      labelNames: ['kind'] as const,
      buckets: [1, 5, 15, 30, 60, 120, 300],
      registers: [this.registry],
    });
    this.queueDepth = new Gauge({
      name: 'relay_queue_depth',
      help: 'Per-worker serial-queue depth (queued + running)',
      labelNames: ['worker'] as const,
      registers: [this.registry],
    });
    this.gasBalance = new Gauge({
      name: 'relay_worker_gas_xtz',
      help: 'Per-worker tz1 gas balance (XTZ)',
      labelNames: ['worker'] as const,
      registers: [this.registry],
    });
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }
}
