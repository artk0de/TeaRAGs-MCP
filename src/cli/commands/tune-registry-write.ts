/**
 * tune → registry env write (tea-rags-mcp-9vpnz follow-through).
 *
 * After a successful `tea-rags tune --project X`, the envs the benchmark
 * MEASURED (the `KEY=VALUE` lines of `tuned_environment_variables.env`) are
 * merged directly into the project's registry snapshot (`entry.env`), so the
 * next indexing run picks them up registry-first — no copy-pasting the env
 * file into the shell or MCP config.
 *
 * Only spellings from REGISTRY_ENV_GROUPS are accepted (the env file also
 * carries comments and non-registry keys). Measured values overwrite the
 * stored snapshot per key; unmeasured keys keep their snapshot values.
 *
 * The benchmark writes DEPRECATED spellings (EMBEDDING_CONCURRENCY,
 * QDRANT_UPSERT_BATCH_SIZE), while the registry's storage contract is the
 * CANONICAL key of each alias family — that is what `buildRegistryEnvSnapshot`
 * emits and what `envWithFallback` reads first. Storing the measured value
 * under an alias next to a stale canonical sibling makes replay a coin-flip on
 * key order, and the stale value can win. So the write NORMALIZES every
 * measured key to its canonical spelling and EVICTS the rest of that key's
 * alias family from the snapshot — one spelling per family, no shadowing
 * (tea-rags-mcp-ifmfi).
 *
 * Known caveat (accepted by design): an MCP-driven index run rebuilds the
 * snapshot from the MCP server's env block afterwards — MCP-set values
 * overwrite tuned ones at the next MCP index.
 */

import {
  canonicalRegistryEnvKeys,
  REGISTRY_ENV_ALLOWLIST,
  registryEnvGroupMembers,
  type CollectionRegistry,
} from "../../core/api/public/index.js";

const RECOGNIZED_KEYS = new Set(REGISTRY_ENV_ALLOWLIST);

/**
 * Parse `KEY=VALUE` lines of a tuned env file into the registry's own
 * vocabulary: recognized spellings only, each keyed by the CANONICAL name of
 * its alias family. A spelling belonging to two families (CODE_BATCH_SIZE) is
 * recorded under both canonicals, mirroring how parse.ts reads it.
 */
export function parseTunedEnvFile(content: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!RECOGNIZED_KEYS.has(key) || value === "") continue;
    for (const canonical of canonicalRegistryEnvKeys(key)) parsed[canonical] = value;
  }
  return parsed;
}

/**
 * Merge the measured env of a tuned run into the project's registry snapshot.
 * Returns the number of keys applied (0 for an unknown project or an env file
 * with no recognized keys — both no-ops).
 */
export function mergeTunedEnvIntoRegistry(
  registry: CollectionRegistry,
  projectName: string,
  envFileContent: string,
): number {
  const measured = parseTunedEnvFile(envFileContent);
  const measuredKeys = Object.keys(measured);
  if (measuredKeys.length === 0) return 0;
  const entry = registry.findByName(projectName);
  if (!entry) return 0;
  const env: Record<string, string> = { ...(entry.env ?? entry.tuning) };
  // Drop the deprecated spellings of every family we measured before writing
  // the canonical value — a leftover alias would otherwise be replayed first
  // (insertion order) and shadow the fresh measurement.
  for (const canonical of measuredKeys) {
    for (const sibling of registryEnvGroupMembers(canonical)) {
      if (sibling !== canonical) delete env[sibling];
    }
  }
  const { name: _name, ...recordable } = entry;
  registry.record({ ...recordable, env: { ...env, ...measured } });
  return measuredKeys.length;
}
