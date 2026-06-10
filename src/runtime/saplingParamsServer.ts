import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from '../observability/logger.js';

const FILES = ['sapling-spend.params', 'sapling-output.params'] as const;

/** Resolve the dir holding the SDK's bundled params (node_modules/shield-bridge-sdk/dist).
 *  The SDK's package.json exports only an "import" condition (no "require"), so
 *  require.resolve fails ("No exports main defined") — use the ESM resolver, which honors it. */
function resolveBundledParamsDir(): string {
  const sdkEntry = fileURLToPath(import.meta.resolve('shield-bridge-sdk')); // → .../dist/index.js
  return dirname(sdkEntry); // .../shield-bridge-sdk/dist
}

export interface ParamsServer {
  url: string; // base URL WITH trailing slash — the SDK appends the filename
  close: () => void;
}

/**
 * Serve the SDK's bundled Sapling proving params over a loopback HTTP server.
 *
 * WHY: the SDK loads params with global fetch(), which on Node can't read file:// URLs;
 * and its on-disk fallback uses __filename, which is undefined under ESM. So in any
 * non-bundler runtime (relay start, dev, bare node) param loading throws unless we point
 * the SDK at an http(s) URL. We re-serve the already-on-disk params over 127.0.0.1 and
 * set SAPLING_PARAMS_URL to it. Self-contained: works in EVERY run mode, no Docker
 * entrypoint sidecar required. Binds an ephemeral loopback port (never the network);
 * serves exactly the two fixed param basenames (no path-traversal surface).
 */
export function startSaplingParamsServer(logger: Logger, dirOverride?: string): Promise<ParamsServer> {
  const dir = dirOverride ?? resolveBundledParamsDir();
  const whitelist = new Map(FILES.map((f) => [`/${f}`, join(dir, f)]));
  for (const p of whitelist.values()) statSync(p); // fail fast if a param file is missing

  const server = createServer((req, res) => {
    const file =
      req.method === 'GET' || req.method === 'HEAD' ? whitelist.get(req.url ?? '') : undefined;
    if (!file) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(statSync(file).size),
      'cache-control': 'public, max-age=31536000, immutable',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(file).pipe(res);
  });

  return new Promise<ParamsServer>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const url = `http://127.0.0.1:${port}/`;
      logger.info({ url, dir }, 'serving sapling params over loopback');
      resolve({ url, close: () => server.close() });
    });
  });
}
