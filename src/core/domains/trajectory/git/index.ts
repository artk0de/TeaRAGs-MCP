export { TrajectoryGitError, GitBlameFailedError, GitLogTimeoutError, GitNotAvailableError } from "./errors.js";
export { GitEnrichmentProvider, type GitProviderConfig } from "./provider.js";
export { createGitEnrichmentProvider, type GitWorkerConfig } from "./factory.js";
export { gitFilters } from "./filters.js";
export { gitPayloadSignalDescriptors } from "./payload-signals.js";
export type { GitFileSignals, ChunkChurnOverlay } from "./types.js";
