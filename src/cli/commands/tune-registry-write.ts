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
 * Known caveat (accepted by design): an MCP-driven index run rebuilds the
 * snapshot from the MCP server's env block afterwards — MCP-set values
 * overwrite tuned ones at the next MCP index.
 */

import { REGISTRY_ENV_ALLOWLIST, type CollectionRegistry } from "../../core/api/public/index.js";

const RECOGNIZED_KEYS = new Set(REGISTRY_ENV_ALLOWLIST);

/** Parse `KEY=VALUE` lines of a tuned env file, keeping only registry env spellings. */
export function parseTunedEnvFile(content: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (RECOGNIZED_KEYS.has(key) && value !== "") parsed[key] = value;
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
  const { name: _name, ...recordable } = entry;
  registry.record({
    ...recordable,
    env: { ...(entry.env ?? entry.tuning), ...measured },
  });
  return measuredKeys.length;
}
