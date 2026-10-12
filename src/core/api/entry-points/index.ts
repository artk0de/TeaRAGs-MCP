/**
 * Config-time entry points of the api layer (bd tea-rags-mcp-89k7k.35.36).
 *
 * `bootstrap/config/**` parses config on every cli command, so it must not
 * load the api assembly graph (`../index.ts`). The narrow re-export files
 * here keep that edge pointed at a STABLE sub-component: this directory is
 * its own SDP component, so the stability delta of
 * `bootstrap/config → core/api/entry-points` stays low, unlike an edge into
 * the whole assembly, which churns with every wiring change (H-D3b).
 */
export { defaultBlamePoolSize, defaultChunkerPoolSize, defaultEnrichmentFilesPerThread } from "./pool-sizing.js";
export { outerEnvForRegistryStamp, replayRegistryEnv, type AmbientEnvRole } from "./registry-env-replay.js";
