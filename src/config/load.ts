import { ConfigSchema, type Config } from './schema.js';

let cached: Config | undefined;

/**
 * Parse + validate the environment ONCE, fail-fast with a readable error that
 * lists every bad/missing var. The only place in the codebase that reads
 * process.env.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (cached) return cached;
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test helper — clears the memoized config. */
export function resetConfigCache(): void {
  cached = undefined;
}
