/**
 * Adaptive DuckDB memory governor for the codegraph daemon (bd tea-rags-mcp-1ruih).
 *
 * The daemon owns the machine's single RW DuckDB connection per collection and
 * knows its activity phases, so it can trade memory for ingest throughput
 * safely: on the FIRST write op of a burst (upsertFile / upsertSymbols / ...)
 * the governor raises `memory_limit` to the configured ceiling
 * (`CODEGRAPH_DB_MEMORY_LIMIT_MAX`, default 4GB) via a live `SET` on the open
 * connection; when the daemon's idle watcher fires, the governor restores the
 * base limit (`CODEGRAPH_DB_MEMORY_LIMIT`, default 2GB) BEFORE the RW lock is
 * released. The base cap stays safe at all times because DuckDB spills
 * sorts/joins to `temp_directory` at the limit (soft degradation) — the
 * ceiling only buys headroom for ingest bursts.
 *
 * DAEMON-ONLY by design. The direct/in-process write path (tests, direct mode
 * without a daemon socket) keeps the base limit applied at `init()` and never
 * raises it: only the daemon has the process-wide view of write activity plus
 * a guaranteed lower-before-release point (the idle watcher). An in-process
 * writer that raised the limit could exit mid-burst with nothing left to
 * restore it, and concurrent direct writers would multiply the ceiling across
 * processes — the exact OOM class the base cap (bd gmuf) guards against.
 *
 * SET statements are best-effort (same policy as the resource SETs in
 * `DuckDbGraphClient.init()`): a rejected SET is swallowed with a DEBUG stderr
 * line — the governor is a protective/throughput layer, not a correctness
 * invariant.
 */

/** Mirrors the `dbMemoryLimit` config default ("2GB") for env-less daemon spawns. */
export const DEFAULT_MEMORY_LIMIT_BASE = "2GB";
/** Mirrors the `dbMemoryLimitMax` config default ("4GB") for env-less daemon spawns. */
export const DEFAULT_MEMORY_LIMIT_MAX = "4GB";

export interface DaemonMemoryGovernorOptions {
  /**
   * Idle/base memory_limit (`CODEGRAPH_DB_MEMORY_LIMIT`). Applied by
   * `DuckDbGraphClient.init()` at open; the governor restores it on idle.
   */
  baseLimit: string;
  /**
   * Burst ceiling (`CODEGRAPH_DB_MEMORY_LIMIT_MAX`) the governor raises to on
   * the first write op of an ingest burst.
   */
  maxLimit: string;
}

/**
 * Minimal structural shape the governor needs from a per-collection handle.
 * The pooled write handle is a `DuckDbGraphClient` whose public `exec` issues
 * raw SQL; the `GraphDbClient` CONTRACT deliberately omits `exec`, so the
 * governor narrows at runtime (`hasExec`) instead of widening the contract
 * for a daemon-internal concern.
 */
interface MemoryLimitTarget {
  exec: (sql: string) => Promise<void>;
}

function hasExec(candidate: unknown): candidate is MemoryLimitTarget {
  return (
    typeof candidate === "object" && candidate !== null && typeof (candidate as { exec?: unknown }).exec === "function"
  );
}

const SIZE_PATTERN = /^\s*(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB|KIB|MIB|GIB|TIB)?\s*$/i;
const DECIMAL_FACTORS: Record<string, number> = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 };
const BINARY_FACTORS: Record<string, number> = { KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3, TIB: 1024 ** 4 };

/**
 * Parse a DuckDB-formatted size string ("2GB", "512MB", "1.5GiB") to bytes.
 * Decimal units are 1000-based, binary (`*iB`) 1024-based — matching DuckDB's
 * own reading. Returns undefined for shapes we can't parse (the max/base
 * comparison is then skipped; DuckDB itself rejects a truly bad value at SET
 * time and the failure is swallowed as best-effort).
 */
function parseMemoryLimitBytes(value: string): number | undefined {
  const match = SIZE_PATTERN.exec(value);
  if (!match) return undefined;
  const quantity = parseFloat(match[1]);
  const unit = (match[2] ?? "B").toUpperCase();
  const factor = DECIMAL_FACTORS[unit] ?? BINARY_FACTORS[unit];
  return factor === undefined ? undefined : quantity * factor;
}

function debugLog(message: string): void {
  if (process.env.DEBUG === "true") {
    process.stderr.write(`[codegraph-daemon] memory governor: ${message}\n`);
  }
}

export class DaemonMemoryGovernor {
  private readonly baseLimit: string;
  private readonly effectiveMax: string;
  /**
   * Collections raised to the ceiling in the current burst, each with the
   * connection handle to lower on idle. Cleared (and re-armed) by `onIdle`.
   */
  private readonly raised = new Map<string, MemoryLimitTarget>();

  constructor(options: DaemonMemoryGovernorOptions) {
    this.baseLimit = options.baseLimit;
    const baseBytes = parseMemoryLimitBytes(options.baseLimit);
    const maxBytes = parseMemoryLimitBytes(options.maxLimit);
    if (baseBytes !== undefined && maxBytes !== undefined && maxBytes < baseBytes) {
      // Config error: a ceiling below the base is meaningless. Clamp to the
      // base (raising becomes a no-op limit-wise) and say so once, loudly —
      // mirrors the init()-time memory_limit OOM guard's console.error policy.
      console.error(
        `[codegraph-daemon] memory governor: CODEGRAPH_DB_MEMORY_LIMIT_MAX '${options.maxLimit}' ` +
          `is below the base CODEGRAPH_DB_MEMORY_LIMIT '${options.baseLimit}' — clamping to the base`,
      );
      this.effectiveMax = options.baseLimit;
    } else {
      this.effectiveMax = options.maxLimit;
    }
  }

  /**
   * Notify the governor of a write op on `collectionName`. The FIRST write of
   * a burst raises the connection's memory_limit to the ceiling; subsequent
   * writes are no-ops until `onIdle` re-arms. Marked raised BEFORE the awaited
   * SET so a concurrent write burst issues exactly one SET; a failed SET stays
   * marked too (no per-write retry hammering — best-effort, not an invariant).
   */
  async onWrite(collectionName: string, graphDb: unknown): Promise<void> {
    if (this.raised.has(collectionName)) return;
    if (!hasExec(graphDb)) {
      debugLog(`handle for ${collectionName} exposes no exec() — skipping raise`);
      return;
    }
    this.raised.set(collectionName, graphDb);
    await this.applyLimit(collectionName, graphDb, this.effectiveMax, "raise");
  }

  /**
   * Restore the base limit on every raised collection. Called by the daemon's
   * idle watcher BEFORE shutdown/lock-release, so the file's effective ceiling
   * never outlives the burst. Re-arms the governor for the next burst.
   */
  async onIdle(): Promise<void> {
    const entries = [...this.raised.entries()];
    this.raised.clear();
    for (const [collectionName, target] of entries) {
      await this.applyLimit(collectionName, target, this.baseLimit, "lower");
    }
  }

  private async applyLimit(
    collectionName: string,
    target: MemoryLimitTarget,
    limit: string,
    phase: "raise" | "lower",
  ): Promise<void> {
    try {
      await target.exec(`SET memory_limit = '${limit.replace(/'/g, "''")}'`);
    } catch (err) {
      debugLog(`${phase} to '${limit}' failed for ${collectionName}: ${(err as Error).message}`);
    }
  }
}
