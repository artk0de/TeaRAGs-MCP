/**
 * The code defaults the domains apply to raw config values, gathered in one
 * place for the callers that must state them (bd tea-rags-mcp-umixb).
 *
 * Bootstrap config passes these knobs through raw and each owning domain fills
 * its own default where it consumes the value. The registry env snapshot still
 * has to record the EFFECTIVE value of every key, and `bootstrap/config` is too
 * stable a component to read a domain for it — so this composition root builds
 * the defaults and the callers inject them.
 */

import type { DomainEnvCodeDefaults } from "../../contracts/index.js";
import { defaultChunkerPoolSize, defaultEnrichmentFilesPerThread } from "../../domains/ingest/pipeline/index.js";
import { defaultBlamePoolSize } from "../../domains/trajectory/git/index.js";

export function resolveDomainEnvCodeDefaults(): DomainEnvCodeDefaults {
  return {
    chunkerPoolSize: defaultChunkerPoolSize(),
    enrichmentFilesPerThread: defaultEnrichmentFilesPerThread(),
    blamePoolSize: defaultBlamePoolSize(),
  };
}
