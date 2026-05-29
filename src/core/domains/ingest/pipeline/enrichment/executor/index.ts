/**
 * `EnrichmentExecutor` implementations live here. The interface itself is in
 * `contracts/types/enrichment-executor.ts` so the phases can depend on the
 * type without crossing into the executor subdomain.
 */
export { InlineEnrichmentExecutor } from "./inline.js";
export { WorkerPoolEnrichmentExecutor } from "./worker-pool.js";
