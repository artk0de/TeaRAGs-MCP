/**
 * Narrow config-time read of the registry env replay (bd tea-rags-mcp-k7kmu C5).
 *
 * `bootstrap/config/env-snapshot.ts` is loaded by every cli command through the
 * config barrel. Routing it through the api assembly barrel (`./index.ts`)
 * would load the whole api graph — measured ~625 ms cold against ~110 ms for
 * the config barrel — into config parsing. This file re-exports only the
 * replay members from the registry FACADE (~20 ms), so bootstrap still reaches
 * the domain through `core/api` (`domain-boundaries.md`).
 */
export {
  outerEnvForRegistryStamp,
  replayRegistryEnv,
  type AmbientEnvRole,
} from "../domains/maintenance/registry/index.js";
