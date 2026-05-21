/**
 * Trajectory domain errors — git, static analysis.
 *
 * Re-exports subdomain errors for convenience.
 */

import { TeaRagsError } from "../../infra/errors.js";

/**
 * Trajectory domain error codes (git + static + codegraph).
 */
export type TrajectoryErrorCode =
  | "TRAJECTORY_GIT_BLAME_FAILED"
  | "TRAJECTORY_GIT_LOG_TIMEOUT"
  | "TRAJECTORY_GIT_NOT_AVAILABLE"
  | "TRAJECTORY_STATIC_PARSE_FAILED"
  | "TRAJECTORY_CODEGRAPH_SPILL_IO_FAILED"
  | "TRAJECTORY_CODEGRAPH_RESOLVE_FAILED"
  | "TRAJECTORY_CODEGRAPH_CHECKPOINT_FAILED"
  | "TRAJECTORY_CODEGRAPH_METRICS_FAILED";

/**
 * Abstract base for all trajectory domain errors.
 * Default httpStatus: 500.
 */
export abstract class TrajectoryError extends TeaRagsError {
  constructor(opts: { code: TrajectoryErrorCode; message: string; hint: string; httpStatus?: number; cause?: Error }) {
    super({ ...opts, httpStatus: opts.httpStatus ?? 500 });
  }
}

/**
 * Abstract base for git trajectory errors.
 * Default httpStatus: 500.
 */
export abstract class TrajectoryGitError extends TrajectoryError {}

/**
 * Abstract base for static trajectory errors.
 * Default httpStatus: 500.
 */
export abstract class TrajectoryStaticError extends TrajectoryError {}

/**
 * Abstract base for codegraph trajectory errors. Slice 2 introduced
 * chunked-flush streaming with a disk-backed spill file and explicit
 * DuckDB checkpoints; each phase has its own typed error so failures
 * surface clearly in `enrichment.<provider>.file.message` instead of
 * being swallowed into a generic prefetch failure.
 *
 * Default httpStatus: 500.
 */
export abstract class TrajectoryCodegraphError extends TrajectoryError {}

/** Git blame failed for a specific file. */
export class GitBlameFailedError extends TrajectoryGitError {
  constructor(file: string, cause?: Error) {
    super({
      code: "TRAJECTORY_GIT_BLAME_FAILED",
      message: `Git blame failed for "${file}"`,
      hint: "Ensure the file is tracked by git and the repository is not corrupted",
      cause,
    });
  }
}

/** Git log timed out after the specified duration. */
export class GitLogTimeoutError extends TrajectoryGitError {
  constructor(timeoutMs: number, cause?: Error) {
    super({
      code: "TRAJECTORY_GIT_LOG_TIMEOUT",
      message: `Git log timed out after ${timeoutMs}ms`,
      hint: "Try reducing the scope of the operation or increasing the timeout",
      httpStatus: 504,
      cause,
    });
  }
}

/** Git CLI is not available on the system. */
export class GitNotAvailableError extends TrajectoryGitError {
  constructor(cause?: Error) {
    super({
      code: "TRAJECTORY_GIT_NOT_AVAILABLE",
      message: "Git is not available",
      hint: "Ensure git is installed and accessible in PATH",
      httpStatus: 503,
      cause,
    });
  }
}

/** Static analysis (tree-sitter) parsing failed for a file. */
export class StaticParseFailedError extends TrajectoryStaticError {
  constructor(file: string, cause?: Error) {
    super({
      code: "TRAJECTORY_STATIC_PARSE_FAILED",
      message: `Failed to parse "${file}"`,
      hint: "The file may contain syntax errors or use an unsupported language",
      cause,
    });
  }
}

/**
 * Codegraph spill-file I/O failed. The slice 2 streaming pass-1 writes
 * each `FileExtraction` to an NDJSON spill file on disk and reads it
 * back in pass-2. Any write/read/unlink error along the spill path
 * surfaces here. The active enrichment cycle marks the codegraph
 * provider as failed; the next ingest pass will rewrite the spill from
 * a clean state.
 */
export class CodegraphSpillIoError extends TrajectoryCodegraphError {
  constructor(spillPath: string, op: "write" | "read" | "open" | "unlink", cause?: Error) {
    super({
      code: "TRAJECTORY_CODEGRAPH_SPILL_IO_FAILED",
      message: `Codegraph spill ${op} failed at ${spillPath}`,
      hint:
        "Verify the codegraph data directory is writable and has free space. " +
        "On the next ingest pass the spill file is recreated from scratch.",
      cause,
    });
  }
}

/**
 * Codegraph pass-2 (resolve + upsert) failed mid-stream. Either the
 * spill file contained malformed JSON, the resolver threw an unexpected
 * exception, or DuckDB rejected the per-file upsert. The graph DB is
 * left in a consistent state up to the last successful checkpoint;
 * unflushed work is lost but cleanly replayable on next reindex.
 */
export class CodegraphResolveError extends TrajectoryCodegraphError {
  constructor(filesProcessed: number, cause?: Error) {
    super({
      code: "TRAJECTORY_CODEGRAPH_RESOLVE_FAILED",
      message: `Codegraph resolve failed after ${filesProcessed} files`,
      hint:
        "The graph DB is consistent up to the last CHECKPOINT (every 500 files). " +
        "Run index_codebase again to retry the unflushed range.",
      cause,
    });
  }
}

/**
 * Explicit DuckDB CHECKPOINT failed. CHECKPOINTs are issued every N
 * files in the slice 2 streaming pass-2 so the WAL doesn't grow
 * unbounded. A failed checkpoint means subsequent writes will keep
 * piling into the WAL until DuckDB's memory_limit triggers — surface
 * the failure loudly rather than silently continuing.
 */
export class CodegraphCheckpointError extends TrajectoryCodegraphError {
  constructor(cause?: Error) {
    super({
      code: "TRAJECTORY_CODEGRAPH_CHECKPOINT_FAILED",
      message: "Codegraph CHECKPOINT failed",
      hint:
        "DuckDB could not flush the WAL. Inspect cause for the driver message; " +
        "common cause is the WAL outgrowing temp_directory free space.",
      cause,
    });
  }
}

/**
 * Tarjan SCC / PageRank recompute failed at the end of an extraction
 * pass. Non-fatal — the graph itself is consistent, only cycle freshness
 * and rerank-time pagerank lookups are stale. Next sink.finish() retries.
 */
export class CodegraphMetricsError extends TrajectoryCodegraphError {
  constructor(stage: "tarjan" | "pagerank" | "adjacency", cause?: Error) {
    super({
      code: "TRAJECTORY_CODEGRAPH_METRICS_FAILED",
      message: `Codegraph metrics recompute failed at ${stage}`,
      hint:
        "Graph data is consistent but cycle/pagerank tables may be stale. " +
        "Re-run index_codebase to refresh the derived metrics.",
      cause,
    });
  }
}
