import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { buildServer } from '../src/server/server.js';
import type { Processor } from '../src/runtime/processor.js';
import type { WsHub } from '../src/server/wsHub.js';
import type { Metrics } from '../src/observability/metrics.js';

// Minimal stubs — buildServer only REGISTERS routes/hooks; it never calls into
// these during build/listen, so empty objects are sufficient.
const stubProcessor = {} as unknown as Processor;
const stubWsHub = {} as unknown as WsHub;
const stubMetrics = { contentType: 'text/plain', render: async () => '' } as unknown as Metrics;

describe('buildServer (boot + hook ordering)', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it('builds and LISTENS without FST_ERR_INSTANCE_ALREADY_LISTENING (onClose hook before ready)', async () => {
    let ready = false;
    // If the onClose addHook is moved back after app.ready(), buildServer throws
    // "Fastify instance is already listening. Cannot call addHook!" — this is the
    // regression guard for that ordering.
    const app = await buildServer({
      processor: stubProcessor,
      wsHub: stubWsHub,
      metrics: stubMetrics,
      rateLimitRpm: 120,
      maxConnections: 2000,
      wsHeartbeatMs: 30_000,
      trustProxy: false,
      isReady: () => ready,
    });
    close = () => app.close();

    await expect(app.listen({ port: 0, host: '127.0.0.1' })).resolves.toBeTypeOf('string');
    const port = (app.server.address() as AddressInfo).port;
    expect(port).toBeGreaterThan(0);

    // /readyz reflects the live readiness flag (503 until ready), /healthz is always 200.
    const healthz = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(healthz.status).toBe(200);
    const readyzBefore = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect(readyzBefore.status).toBe(503);
    ready = true;
    const readyzAfter = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect(readyzAfter.status).toBe(200);

    // /metrics is default-DENY (no token configured in this build) → 404, never
    // leaking per-worker gas/queue metadata on an unauthenticated ingress.
    const metrics = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(metrics.status).toBe(404);
  });

  it('/metrics is token-gated when METRICS_TOKEN is set (404 off → 401 bad → 200 bearer)', async () => {
    const app = await buildServer({
      processor: stubProcessor,
      wsHub: stubWsHub,
      metrics: stubMetrics,
      metricsToken: 's3cret',
      rateLimitRpm: 120,
      maxConnections: 2000,
      wsHeartbeatMs: 30_000,
      trustProxy: false,
      isReady: () => true,
    });
    close = () => app.close();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;

    const noAuth = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(noAuth.status).toBe(401);
    const badAuth = await fetch(`http://127.0.0.1:${port}/metrics`, { headers: { authorization: 'Bearer nope' } });
    expect(badAuth.status).toBe(401);
    const ok = await fetch(`http://127.0.0.1:${port}/metrics`, { headers: { authorization: 'Bearer s3cret' } });
    expect(ok.status).toBe(200);
  });
});
