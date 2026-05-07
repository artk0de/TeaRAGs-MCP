export { EnrichmentCoordinator } from "./coordinator.js";
export { EnrichmentApplier } from "./applier.js";
export { EnrichmentRecovery } from "./recovery.js";
// health-mapper is consumed by IngestFacade at the public DTO boundary
export { mapMarkerToHealth } from "./health-mapper.js";
export type {
  ChunkEnrichmentMarker,
  EnrichmentProviderHealth,
  FileEnrichmentMarker,
  ProviderContext,
} from "./types.js";
