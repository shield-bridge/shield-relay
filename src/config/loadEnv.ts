/**
 * .env BOOTSTRAP — imported FIRST by the CLI entry, before anything reads config.
 *
 * Populates process.env from a `.env` in the working directory so the relay picks up a
 * developer's local config on `npm start`, `npm run dev`, or the `relay` binary — the
 * programmatic equivalent of node's `--env-file`. This is NOT a config reader (config/load.ts
 * remains the single place that READS process.env); it just fills the environment first, the
 * same way a shell export or Compose's `env_file` does.
 *
 * - No `.env` present (Docker, CI, a contributor without one) → ENOENT, swallowed: the env
 *   comes from the actual environment (Compose injects via `env_file`; shells export directly).
 * - A variable already set in the environment is NOT overridden — the shell/Compose value wins
 *   over the file (Node's loadEnvFile semantics).
 */
try {
  process.loadEnvFile('.env');
} catch {
  // No .env in the working directory — rely on the ambient environment.
}
