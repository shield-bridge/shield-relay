# Contributing to shield-relay

Thanks for your interest! This is a self-hostable Tezos privacy relay. Contributions —
bug reports, fixes, docs, deploy recipes, additional store/transport backends — are
welcome.

## Ground rules

- **The wire protocol `shield-relay/1` is frozen.** It is documented in
  [`docs/SHIELD_RELAY_PROTOCOL.md`](./docs/SHIELD_RELAY_PROTOCOL.md) and must stay
  byte-compatible with the production Shield Bridge relay and the web client. Do **not**
  change endpoints, envelopes, status codes, field names, or status values without
  opening an issue to discuss it first — a wire change breaks every deployed client.
- **Security issues go to [`SECURITY.md`](./SECURITY.md), not public issues or PRs.**
- For anything non-trivial, open an issue before sending a large PR so we can agree on
  the approach.

## Development setup

Requires **Node 22+** and npm.

```bash
git clone https://github.com/AndrewKishino/shield-relay && cd shield-relay
npm ci
npm run build       # tsc -> dist/
npm test            # vitest (must pass before you open a PR)
npm run typecheck   # tsc --noEmit (CI runs this too)
```

To run a local relay end-to-end, see **Build & run from source** in the
[README](./README.md). Use `TEZOS_NETWORK=shadownet` for development — never test against
mainnet with funded keys.

## Code style

- TypeScript, ESM, `strict` mode. Match the style, naming, and comment density of the
  surrounding code.
- Keep the domain core (`src/core/*`) framework-free and pure where possible; it is the
  most heavily unit-tested layer and the place money-safety lives.
- All amounts are integer **mutez** (`bigint`) — never float tez.
- Config is read in exactly one place (`src/config/schema.ts` + `load.ts`); nothing else
  should touch `process.env`.
- A formatter/linter config isn't wired up yet (a good first contribution!). Until then,
  keep diffs minimal and consistent with neighboring code.

## Tests

- Add or update tests under `test/` for any behavior change. The money-gates
  (`payment`, `feeSchedule`, `processor`, `jobs`) and crash-safety (`reconcile`,
  `workerQueue`) are the critical paths.
- `npm test` must be green. CI runs typecheck + build + test on every PR.

## Commits & PRs

- Write clear, imperative commit messages explaining the *why*.
- Keep PRs focused; describe the change and how you verified it.
- By contributing, you agree your contributions are licensed under the repository's
  [MIT license](./LICENSE).

This project follows the [Contributor Covenant](./CODE_OF_CONDUCT.md). Be kind.
