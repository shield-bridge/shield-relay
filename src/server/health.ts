import type { FastifyInstance } from 'fastify';

/**
 * Liveness + readiness for orchestrators. `/healthz` is always 200 while the
 * process is up; `/readyz` returns 503 until the pool is built (and during drain).
 */
export function registerHealth(app: FastifyInstance, isReady: () => boolean): void {
  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/readyz', async (_req, reply) => {
    if (isReady()) return reply.send({ status: 'ready' });
    return reply.code(503).send({ status: 'not_ready' });
  });
}
