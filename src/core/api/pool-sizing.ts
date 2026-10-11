/**
 * Narrow config-time read of the pool-size defaults (bd tea-rags-mcp-h4a H2a,
 * decision H-D3b).
 *
 * `bootstrap/config/schemas.ts` evaluates these defaults while parsing config,
 * which every cli command does through the config barrel. The api assembly
 * barrel (`./index.ts`) would pull the whole api graph into config parsing, so
 * this file re-exports only the three pool-default functions, each from its
 * domain FACADE — bootstrap still reaches the domains through `core/api`
 * (`domain-boundaries.md`).
 */
export { defaultChunkerPoolSize, defaultEnrichmentFilesPerThread } from "../domains/ingest/pipeline/index.js";
export { defaultBlamePoolSize } from "../domains/trajectory/git/index.js";
