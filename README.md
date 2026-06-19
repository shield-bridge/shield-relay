# shield-relay

> Self-hostable **privacy relay** for [Shield Bridge](https://shieldbridge.xyz). Broadcasts Tezos **Sapling** transactions on a user's behalf for a small fee — anonymously. One container. Run it anywhere: a VPS, a homelab, Fly.io, Railway, Kubernetes, Akash.

**Status:** 🚧 early. The wire protocol (`shield-relay/1`) is frozen; this is a **single portable container** that implements it so anyone can run a relay. See [`docs/SHIELD_RELAY_PROTOCOL.md`](./docs/SHIELD_RELAY_PROTOCOL.md) for the complete wire-protocol specification (endpoints, envelopes, status codes, fee schedule) and [`DESIGN.md`](./DESIGN.md) for the architecture. It builds, runs, and passes its tests — try it on shadownet or low-value flows first.

---

## What it does

A relay lets a Shield Bridge user pay a small fee to have a third party broadcast their private transfer/unshield — so the user's own wallet never touches the chain. For the user's actual operation the relay only ever sees an **opaque Sapling proof**: it cannot see the amount, asset, sender, or recipient, and it cannot redirect funds. (The fee itself is a public unshield to the relay's own worker — its amount is visible, but the *payer* is a shielded account, so it doesn't deanonymize the user.) The worst a malicious relay can do is *refuse* (the user loses at most one fee). That bounded-trust property is what makes a permissionless network of relays safe.

This server speaks the exact protocol the Shield Bridge web app already uses, so pointing the app at your relay's URL "just works."

## Quickstart (Docker Compose — homelab / VPS)

> Requires a funded Tezos wallet per worker for gas. The relay is a lightweight broadcaster — it simulates + signs, it does NOT generate ZK proofs — so it needs only a few hundred MB of RAM regardless of worker count (default container limit 512 MB).

```bash
# 1. mint your worker pool + print the addresses you need to fund
#    (--out writes ./secrets/pool.json on the host — the path compose mounts read-only)
docker run --rm -v "$PWD/secrets:/secrets" ghcr.io/andrewkishino/shield-relay \
  relay init --workers 2 --out /secrets/pool.json

# 2. fund each printed tz1 address with ~5–10 XTZ for gas (one-time; fees self-fund afterward)

# 3. preflight, then run
docker compose up -d
docker compose exec relay relay doctor   # checks RPC, contract, balances, DB
```

Then set `VITE_API_BASE_URL` in the Shield Bridge app to your relay's URL — status is delivered by polling `GET /status`, so there is no WebSocket endpoint to configure. To let *anyone* discover your relay (not just you), [list it in the on-chain registry](#listing-your-relay-on-chain).

## Listing your relay on-chain

A Shield Bridge client finds relays by reading a permissionless [on-chain registry](https://github.com/AndrewKishino/sapling-contracts/blob/main/RELAY_REGISTRY.md) — no central server, no allowlist. Registering is one command:

```bash
export RELAY_PUBLIC_URL=https://relay.example.com   # your public https origin (serves /info + /.well-known/shield-relay.json)
relay registry register                              # or: --url https://relay.example.com
```

It reads your pool, binds the worker tz1s, and locks a **refundable 5 XTZ deposit** signed from **worker 0** (so that key needs the deposit **plus** gas). Other clients discover you on their next registry read. The registry stores only *who/where* you are (operator, worker tz1s, descriptor URL) — never reputation; clients judge reliability themselves from their own experience.

Manage the listing:

```bash
relay registry show          # your current entry (or "not registered")
relay registry update --url https://new.example.com   # change only the URL (worker keys are immutable)
relay registry deregister    # stop being discovered now; starts a 3-day unbond timer
relay registry withdraw      # after the unbond period: refund the deposit + free the entry
```

## Build & run from source

No Docker required — Node 22+ and npm:

```bash
git clone https://github.com/AndrewKishino/shield-relay && cd shield-relay
npm ci
npm run build && npm test          # compile + run the test suite
cp .env.example .env               # then edit .env (at minimum TEZOS_NETWORK)
node dist/cli/index.js init --workers 2 --out ./secrets/pool.json
export POOL_FILE=./secrets/pool.json
node dist/cli/index.js doctor      # preflight: RPC, contract, balances, DB, port
node dist/cli/index.js start       # or: npm start
```

The container image is published to `ghcr.io/andrewkishino/shield-relay` on tagged releases; if a `docker pull` 404s, build it locally with `docker build -t shield-relay .`.

## Why run one?

- **Earn fees** for providing a useful privacy service (fees self-fund the gas).
- **Strengthen the network** — more independent relays = more censorship-resistance and operator diversity.
- **Sovereignty** — no cloud account, no lock-in; runs on hardware you control.

## How it works (two-phase)

1. **Payment** — the user unshields the fee to one of your workers' public tz1. Your relay **simulates the op first and broadcasts it only if it actually pays that worker** (≥ the fee) — so it never broadcasts an operation that doesn't pay it, and never spends gas on a hijack attempt.
2. **Broadcast** — only *after* payment confirms, the user submits their real (still-opaque) operation, which the **same worker** broadcasts. Coupling both phases on one tz1 keeps each job self-funding (the fee it just received covers the gas it spends), so a single container runs unattended with no cross-worker balance drift. Your wallet is hidden either way — the relay broadcasts, not you; what's traded is on-chain unlinkability of the relay's *own* fee-vs-broadcast ops, which doesn't expose the user. (Multiple workers still process distinct jobs in parallel.)

For the byte-level contract — every endpoint, request/response shape, status code, the job state machine, and the fee schedule — see the full [**`shield-relay/1` wire-protocol spec**](./docs/SHIELD_RELAY_PROTOCOL.md).

## License

MIT © Andrew Kishino. Contributions welcome — see [`CONTRIBUTING.md`](./CONTRIBUTING.md). To report a security issue, see [`SECURITY.md`](./SECURITY.md).
