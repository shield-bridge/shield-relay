import Fastify, { type FastifyInstance } from 'fastify';
import { WebSocketServer } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Processor } from '../runtime/processor.js';
import type { WsHub } from './wsHub.js';
import type { Metrics } from '../observability/metrics.js';
import type { RelayInfo } from './info.js';
import { registerRoutes } from './routes.js';
import { registerHealth } from './health.js';

export interface ServerDeps {
  processor: Processor;
  wsHub: WsHub;
  metrics: Metrics;
  /** Public capability + fee descriptor served at GET /info (lets a client preview the fee). */
  info: RelayInfo;
  /** When unset, /metrics is disabled (404). When set, scrapers must send
   *  `Authorization: Bearer <token>`. Keeps per-worker gas/queue metadata private. */
  metricsToken?: string | undefined;
  isReady: () => boolean;
}

/**
 * Build the Fastify HTTP app and bolt a `ws` server onto the same port via the
 * HTTP `upgrade` event (one port = one ingress rule on every host).
 */
export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 5 * 1024 * 1024 });

  // Permissive CORS — the web client deploys to many origins (IPFS gateways,
  // custom domains). The relay exposes no credentialed/cookie surface.
  app.addHook('onRequest', async (req, reply) => {
    reply.headers({
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
    });
    if (req.method === 'OPTIONS') {
      reply.code(204);
      return reply.send();
    }
    return undefined;
  });

  registerHealth(app, deps.isReady);
  registerRoutes(app, deps.processor);
  // Public descriptor: capability + fee schedule, no side effects. Lets a client show
  // the fee BEFORE minting a job (a 404 here = a legacy/flat relay → client uses 1 XTZ).
  app.get('/info', async () => deps.info);
  app.get('/.well-known/shield-relay.json', async () => deps.info); // P4 canonical path
  // /metrics: default-deny. Disabled (404) unless METRICS_TOKEN is set; then a
  // matching bearer token is required. Prevents a public ingress from leaking
  // per-worker gas balance + queue depth (privacy-relevant metadata).
  app.get('/metrics', async (req, reply) => {
    if (!deps.metricsToken) {
      reply.code(404);
      return reply.send();
    }
    if (req.headers.authorization !== `Bearer ${deps.metricsToken}`) {
      reply.code(401);
      return reply.send();
    }
    reply.header('content-type', deps.metrics.contentType);
    return reply.send(await deps.metrics.render());
  });

  // Bolt a `ws` server onto the same http server. The onClose hook MUST be added
  // BEFORE app.ready() — Fastify throws FST_ERR_INSTANCE_ALREADY_LISTENING on any
  // addHook once the instance has started (ready() flips that state, not listen()).
  const wss = new WebSocketServer({ noServer: true });
  app.addHook('onClose', async () => {
    wss.close();
  });

  await app.ready();

  app.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    wss.handleUpgrade(req, socket, head, (ws) => deps.wsHub.handleConnection(ws));
  });

  return app;
}
