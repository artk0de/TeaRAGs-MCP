/**
 * resolveRegistryEnvCodeDefaults — the CURRENT code default of every key the
 * registry env snapshot can hold, keyed and spelled exactly as
 * `buildRegistryEnvSnapshot` writes them.
 *
 * It is the injected half of the one-time registry env-pin migration
 * (`migrateRegistryEnvPins`, bd tea-rags-mcp-h4l6k): the registry lives in
 * `core/domains/maintenance`, which may not import config parsing, so every
 * `CollectionRegistry` a process opens receives this as its
 * `envCodeDefaults` provider.
 *
 * The config is parsed from an env carrying only HOME and PATH, so no tea-rags
 * knob the operator exported can pass itself off as a default — the result is
 * what an unconfigured run on this machine would resolve.
 */

import { buildRegistryEnvSnapshot } from "./env-snapshot.js";
import { parseAppConfigZod } from "./parse.js";
import type { EnvSource } from "./utils.js";

export function resolveRegistryEnvCodeDefaults(env: EnvSource = process.env): Readonly<Record<string, string>> {
  const bare: Record<string, string> = {};
  if (env.HOME !== undefined) bare.HOME = env.HOME;
  if (env.PATH !== undefined) bare.PATH = env.PATH;
  return buildRegistryEnvSnapshot(parseAppConfigZod(bare));
}
