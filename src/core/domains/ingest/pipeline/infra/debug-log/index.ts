/**
 * Public surface of the pipeline debug-log submodule.
 *
 * The whole logging cluster — the `pipelineLog` singleton, the file sink, the
 * string formats, the injected config readers and the slow-file tracker —
 * moved here as one unit (6oah1 PI1) because most of pipeline/infra's external
 * importers came for `pipelineLog` alone. It stays an ingest concern rather
 * than a `primitives/diagnostics/` resident: the sink writes the pipeline log
 * file, and `primitives` bans filesystem I/O.
 *
 * Consumers import from this barrel only; the cluster's own files are internal.
 */
export { initDebugLogger } from "./debug-log-dependencies.js";
export { pipelineLog } from "./debug-logger.js";
export type { LogContext } from "./debug-logger.js";
export type { FileIngestRecord } from "./slow-file-tracker.js";
