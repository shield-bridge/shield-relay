import Fastify, { type FastifyInstance } from 'fastify';
import { WebSocketServer } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Processor } from '../runtime/processor.js';
import type { WsHub } from './wsHub.js';
import { registerRoutes } from './routes.js';
import { registerHealth } from './health.js';

export interface ServerDeps {
  processor: Processor;
  wsHub: WsHub;
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
  await app.ready();

  const wss = new WebSocketServer({ noServer: true });
  app.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    wss.handleUpgrade(req, socket, head, (ws) => deps.wsHub.handleConnection(ws));
  });
  app.addHook('onClose', async () => {
    wss.close();
  });

  return app;
}
