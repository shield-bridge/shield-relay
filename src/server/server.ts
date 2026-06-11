import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { WebSocketServer, type WebSocket } from 'ws';
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
  /** Per-IP HTTP request cap per minute (@fastify/rate-limit). */
  rateLimitRpm: number;
  /** Hard ceiling on concurrent WebSocket connections (upgrade rejected past it). */
  maxConnections: number;
  /** WS ping/reaper interval (ms): a socket that misses a round is terminated. */
  wsHeartbeatMs: number;
  /** Trust X-Forwarded-For for req.ip (rate-limit keying) — true ONLY behind a proxy. */
  trustProxy: boolean;
  isReady: () => boolean;
}

/**
 * Build the Fastify HTTP app and bolt a `ws` server onto the same port via the
 * HTTP `upgrade` event (one port = one ingress rule on every host).
 */
export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 5 * 1024 * 1024, trustProxy: deps.trustProxy });

  // Per-IP HTTP rate limit. Loopback is allow-listed so container/compose health
  // probes (polled every ~30s from 127.0.0.1) are never throttled. WS upgrades
  // bypass Fastify routing, so they're bounded by maxConnections (below) instead.
  await app.register(rateLimit, {
    max: deps.rateLimitRpm,
    timeWindow: '1 minute',
    allowList: ['127.0.0.1', '::1'],
  });

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
  // Liveness set: a socket is "alive" from connect and again on every pong. The reaper
  // terminates any socket that missed the last round — half-open/dead connections that
  // would otherwise leak into the hub's subscriber map (and leak memory) forever.
  const alive = new WeakSet<WebSocket>();
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) {
        ws.terminate();
        continue;
      }
      alive.delete(ws);
      ws.ping();
    }
  }, deps.wsHeartbeatMs);
  heartbeat.unref(); // never keep the process alive solely for the reaper

  app.addHook('onClose', async () => {
    clearInterval(heartbeat);
    wss.close();
  });

  await app.ready();

  app.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    // Hard cap concurrent sockets — bounds an unauthenticated upgrade-flood DoS.
    if (wss.clients.size >= deps.maxConnections) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      alive.add(ws);
      ws.on('pong', () => alive.add(ws));
      deps.wsHub.handleConnection(ws);
    });
  });

  return app;
}
