# syntax=docker/dockerfile:1.7
# =============================================================================
# shield-relay — multi-arch (linux/amd64 + linux/arm64) production image
# =============================================================================
# Strategy
#   * Base: debian bookworm slim (glibc). better-sqlite3 11.10.0 ships GLIBC
#     prebuilt addons for node-v127 (Node 22 ABI) on BOTH linux-x64 and
#     linux-arm64, so no source compile is needed on either arch. Musl/alpine
#     would force a from-source build of better-sqlite3 (musl prebuilds exist
#     but are less battle-tested for this workload) — we choose glibc for
#     reliability + portability per the brief.
#   * The Sapling proving core is @airgap/sapling-wasm (WebAssembly, JS-embedded)
#     — architecture-INDEPENDENT. The ONLY native addon in the tree is
#     better-sqlite3. So a native cross-compile is NOT on the critical path:
#     under `buildx --platform linux/amd64,linux/arm64`, each arch's `npm ci`
#     pulls that arch's prebuilt better-sqlite3 binary. QEMU only has to run
#     `npm`/`tsc` (pure JS) and the prebuild-install download — never gcc.
#   * Multi-stage: (1) builder = full toolchain + dev deps + tsc; (2) prod-deps =
#     `npm ci --omit=dev` keeping the arch-correct compiled better-sqlite3 addon;
#     (3) runtime = slim, non-root, tini PID-1.
#   * Layer-cache ordering: package*.json copied BEFORE src so a code-only edit
#     does not bust the dependency layer.
#
# NO SAPLING PROVING: under the unshield-payment protocol the relay is a pure tz1
#   broadcaster — it simulates + signs ops with octez.js and never generates a ZK
#   proof. So there is NO Sapling SDK, no @airgap/sapling-wasm, no ~49 MB proving
#   params, and no worker_threads in this image. (That machinery was removed when the
#   relay stopped touching sapling accounts.)
#
# Pinned via build args (override at build time, not baked assumptions):
ARG NODE_VERSION=22.21.0
ARG DEBIAN_VARIANT=bookworm-slim

# -----------------------------------------------------------------------------
# Stage 1 — builder: install ALL deps (incl dev) and compile TS -> dist/
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION}-${DEBIAN_VARIANT} AS builder
WORKDIR /app

# Build deps for the fallback path ONLY. With glibc prebuilds present these are
# never exercised on amd64/arm64, but they make the build self-healing if a
# prebuild is ever missing (and keep `npm ci` from hard-failing under QEMU).
# python3 + build-essential are needed for any node-gyp fallback compile.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
      python3 build-essential ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Dependency layer first — cached across source-only changes.
# package-lock.json is the integrity anchor; `npm ci` is fully reproducible.
COPY package.json package-lock.json ./
# Keep node-gyp able to compile if a prebuild is unexpectedly absent; otherwise
# prebuild-install fetches the arch-correct better_sqlite3.node.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --include=dev

# Now the source. tsconfig drives tsc -> dist/.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && test -f dist/cli/index.js

# -----------------------------------------------------------------------------
# Stage 2 — production deps: prune to runtime deps, KEEP compiled better-sqlite3
# -----------------------------------------------------------------------------
# A clean `npm ci --omit=dev` in its own stage. better-sqlite3 is a runtime
# dependency, so `npm ci` re-resolves its prebuilt (or compiled) addon for the
# CURRENT build platform — i.e. the TARGET arch under buildx. No manual copy of
# the .node is needed; npm owns it. The `test -f …better_sqlite3.node` line fails
# the build LOUDLY if a prebuild silently went missing on either arch.
FROM node:${NODE_VERSION}-${DEBIAN_VARIANT} AS prod-deps
WORKDIR /app
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
      python3 build-essential ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
# NB: do NOT `npm cache clean` here — /root/.npm is a BuildKit cache mount (never part
# of the image, so cleaning saves nothing) and is SHARED across the parallel amd64/arm64
# stages, so a wholesale rmdir races a concurrent writer and dies with ENOTEMPTY.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev \
 && test -f node_modules/better-sqlite3/build/Release/better_sqlite3.node

# -----------------------------------------------------------------------------
# Stage 3 — runtime: slim, non-root, tini PID-1, no toolchain
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION}-${DEBIAN_VARIANT} AS runtime

# tini = correct PID-1 signal forwarding so the SIGTERM/SIGINT drain in start.ts
# actually fires (stop intake -> finish in-flight -> release instance lock).
# curl = a tiny http client for container/compose healthchecks (node:slim ships
# NEITHER wget NOR curl by default). ca-certificates = HTTPS RPC trust.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
      tini ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# DATA_DIR: local-FS data dir — keep it on a LOCAL volume at runtime (SQLite WAL +
#   the single-writer instance lock can corrupt on a networked FS).
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080

WORKDIR /app

# Runtime artifacts only — no source, no dev deps, no build tools.
# Ownership set to the unprivileged `node` user (uid/gid 1000, ships in the image).
COPY --chown=node:node --from=prod-deps /app/node_modules ./node_modules
COPY --chown=node:node --from=builder   /app/dist ./dist
COPY --chown=node:node package.json ./

# Data dir owned by the runtime user so the volume mount is writable as non-root.
RUN install -d -o node -g node -m 0700 /data

# Drop privileges. NEVER run the relay as root; it only needs to bind PORT (>1024)
# and write /data.
USER node

EXPOSE 8080

# Liveness probe hits the always-on /healthz (200 whenever the process is up).
# Uses node's built-in fetch so NO external binary is required. Readiness
# (/readyz -> 503 while the pool builds OR during drain) is for a load balancer,
# NOT Docker's restart loop — do not point a restart-on-unhealthy watchdog at it.
# start-period covers deriving each worker's address (fast — no proving params to load).
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Make the stop signal explicit; the relay's drain handler listens for SIGTERM.
STOPSIGNAL SIGTERM

# tini as PID-1 (forwards SIGTERM/SIGINT so start.ts's drain handler fires, and reaps
# zombies) -> the relay directly. No entrypoint wrapper: with no params server to bring
# up, tini exec's `node … <subcommand>` and the relay inherits the forwarded signals.
ENTRYPOINT ["/usr/bin/tini", "--", "node", "dist/cli/index.js"]
# Default to the server. Override (e.g. `init`, `doctor`, `jobs`) at `docker run`.
CMD ["start"]
