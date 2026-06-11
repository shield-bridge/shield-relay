# shield-relay

> Self-hostable **privacy relay** for [Shield Bridge](https://shieldbridge.xyz). Broadcasts Tezos **Sapling** transactions on a user's behalf for a small fee — anonymously. One container. Run it anywhere: a VPS, a homelab, Fly.io, Railway, Kubernetes, Akash.

**Status:** 🚧 early scaffold. The wire protocol (`shield-relay/1`) is frozen and live in production on Shield Bridge's AWS backend; this repo re-implements it as a **single portable container** so anyone can run a relay. See [`DESIGN.md`](./DESIGN.md) for the full architecture + build plan.

---

## What it does

A relay lets a Shield Bridge user pay a small fee to have a third party broadcast their private transfer/unshield — so the user's own wallet never touches the chain. For the user's actual operation the relay only ever sees an **opaque Sapling proof**: it cannot see the amount, asset, sender, or recipient, and it cannot redirect funds. (The fee itself is a public unshield to the relay's own worker — its amount is visible, but the *payer* is a shielded account, so it doesn't deanonymize the user.) The worst a malicious relay can do is *refuse* (the user loses at most one fee). That bounded-trust property is what makes a permissionless network of relays safe.

This server speaks the exact protocol the Shield Bridge web app already uses, so pointing the app at your relay's URL "just works."

## Quickstart (Docker Compose — homelab / VPS)

> Requires a funded Tezos wallet per worker for gas. The relay is a lightweight broadcaster — it simulates + signs, it does NOT generate ZK proofs — so it needs only a few hundred MB of RAM regardless of worker count (default container limit 512 MB).

```bash
# 1. mint your worker pool + print the addresses you need to fund
docker run --rm -v "$PWD/secrets:/secrets" ghcr.io/andrewkishino/shield-relay \
  relay init --workers 2 --network mainnet

# 2. fund each printed tz1 address with ~5–10 XTZ for gas (one-time; fees self-fund afterward)

# 3. preflight, then run
docker compose up -d
docker compose exec relay relay doctor   # checks RPC, contract, balances, DB
```

Then set `VITE_API_BASE_URL` / `VITE_WS_BASE_URL` in the Shield Bridge app to your relay's URL (or, later, register it so others can discover it).

## Why run one?

- **Earn fees** for providing a useful privacy service (fees self-fund the gas).
- **Strengthen the network** — more independent relays = more censorship-resistance and operator diversity.
- **Sovereignty** — no AWS account, no cloud lock-in; runs on hardware you control.

## How it works (two-phase)

1. **Payment** — the user unshields the fee to one of your workers' public tz1. Your relay **simulates the op first and broadcasts it only if it actually pays that worker** (≥ the fee) — so it never broadcasts an operation that doesn't pay it, and never spends gas on a hijack attempt.
2. **Broadcast** — only *after* payment confirms, the user submits their real (still-opaque) operation, which a **different** worker broadcasts. The two on-chain ops come from different addresses, so they can't be trivially paired.

## License

MIT © Andrew Kishino. Contributions welcome once the core lands.
