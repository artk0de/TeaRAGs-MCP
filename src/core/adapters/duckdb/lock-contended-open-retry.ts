/**
 * Retry policy for a collection open that lost the DuckDB file lock (bd
 * tea-rags-mcp-42hno, zgg62), with the foreign-build holder settlement and its
 * remembered verdicts (bd tea-rags-mcp-hw27k, 89k7k.35.27). Split out of
 * `GraphDbClientPool` (0qaht.38), which hands it ONE open attempt to repeat.
 */

import type { PhysicalCollectionName } from "../../contracts/types/collection-identity.js";
import { isDebug } from "../../primitives/diagnostics/index.js";
import type { ForeignBuildDaemonLockArbiter, ForeignBuildLockSettlement } from "./daemon/foreign-build-lock-arbiter.js";
import { CodegraphDatabaseHeldByForeignDaemonError, DuckDbOpenFailedError } from "./errors.js";

/** Delay between `openRetry` attempts when the option leaves it unset. */
const DEFAULT_OPEN_RETRY_INTERVAL_MS = 1_000;

/** Bounded open-retry window — `GraphDbClientPoolOptions.openRetry` documents when it applies. */
export interface LockContendedOpenRetryWindow {
  /** Give up (rethrowing the last `DuckDbOpenFailedError`) after this long. */
  maxMs: number;
  /** Delay between open attempts (default 1s). */
  intervalMs?: number;
}

export interface LockContendedOpenRetryOptions {
  /** Absent: a held lock fails the open at once. */
  openRetry?: LockContendedOpenRetryWindow;
  /** Absent: every holder gets the plain retry. */
  foreignBuildLockArbiter?: ForeignBuildDaemonLockArbiter;
  /** The collection's database path, for the debug line. */
  pathFor: (physicalCollectionName: PhysicalCollectionName) => string;
}

export class LockContendedOpenRetry {
  /**
   * Collections whose open already waited out a whole `openRetry` window
   * against a foreign-build daemon, with that holder's verdict — the holder as
   * named in the error, and why it stays up (bd tea-rags-mcp-hw27k). A verdict
   * no connect can change (`unreachable`, `exitTimeout`) fails later opens at
   * once (bd tea-rags-mcp-89k7k.35.27). Re-checked against the lock's pid on
   * every open and dropped when that pid exited or changed; cleared by the
   * collection's next successful open.
   */
  private readonly foreignHeldCollections = new Map<
    PhysicalCollectionName,
    Extract<ForeignBuildLockSettlement, { kind: "held" }>
  >();

  constructor(private readonly options: LockContendedOpenRetryOptions) {}

  /** Run `openOnce` until it succeeds, or the lock contention it hit is settled as a failure. */
  async open<T>(physicalCollectionName: PhysicalCollectionName, openOnce: () => Promise<T>): Promise<T> {
    // Bounded open retry (bd tea-rags-mcp-42hno): two build-keyed daemons
    // serve the same on-disk collections, so a loser's first open loses the
    // DuckDB RW lock to the winner's still-cached client. The wait is bounded
    // BY DESIGN — nlls evicts the idle holder — so retrying until then turns
    // a shared-collection collision from a failed op into a delay. A holder
    // that is another build's daemon is settled by `foreignBuildLockArbiter`
    // instead of merely waited for (bd tea-rags-mcp-hw27k).
    const retry = this.options.openRetry;
    const deadline = retry ? Date.now() + retry.maxMs : 0;
    for (;;) {
      try {
        const entry = await openOnce();
        this.foreignHeldCollections.delete(physicalCollectionName);
        return entry;
      } catch (err) {
        const intervalMs = retry?.intervalMs ?? DEFAULT_OPEN_RETRY_INTERVAL_MS;
        // Only a held lock clears by waiting (bd tea-rags-mcp-zgg62): a file
        // that is not a database fails identically on every attempt, and
        // waiting the whole window turned it into a ~75 s stall per read.
        if (!(err instanceof DuckDbOpenFailedError) || !err.lockContention) throw err;
        const windowSpent = !retry || Date.now() + intervalMs > deadline;
        const arbiter = this.options.foreignBuildLockArbiter;
        let verdict = this.foreignHeldCollections.get(physicalCollectionName);
        // A verdict belongs to one holder: the lock now held by another pid, or
        // by none alive, is settled afresh (bd tea-rags-mcp-89k7k.35.27).
        if (verdict && !arbiter?.isStillHeldBy(err, verdict.holder)) {
          this.foreignHeldCollections.delete(physicalCollectionName);
          verdict = undefined;
        }
        // Nothing a connect could change: settling again would only retry a
        // socket that did not accept, or a drain that did not end in an exit.
        if (verdict && (verdict.reason === "unreachable" || verdict.reason === "exitTimeout")) {
          throw new CodegraphDatabaseHeldByForeignDaemonError(err.dbPath, verdict.holder, err);
        }
        const settlement = await arbiter?.settle(err, physicalCollectionName);
        // Retried at once, within the window only: a foreign session respawning
        // its daemon and re-taking the file each time must not spin this loop.
        if (settlement?.kind === "drained" && !windowSpent) continue;
        if (arbiter && settlement?.kind === "held") {
          // One window per holder, not one per op (bd tea-rags-mcp-hw27k): the
          // op that already waited it out recorded the holder's verdict, whose
          // fingerprint spares a second describe connect.
          if (windowSpent || verdict) {
            const holder = verdict
              ? {
                  ...settlement.holder,
                  buildFingerprint: settlement.holder.buildFingerprint ?? verdict.holder.buildFingerprint,
                }
              : await arbiter.describe(settlement.holder, physicalCollectionName);
            this.foreignHeldCollections.set(physicalCollectionName, { ...settlement, holder });
            throw new CodegraphDatabaseHeldByForeignDaemonError(err.dbPath, holder, err);
          }
        } else if (windowSpent) {
          throw err;
        }
        if (isDebug()) {
          process.stderr.write(
            `[tea-rags] codegraph pool: open of ${this.options.pathFor(physicalCollectionName)} failed (lock held) — ` +
              `retrying until ${new Date(deadline).toISOString()} (bd tea-rags-mcp-42hno)\n`,
          );
        }
        await new Promise<void>((r) => setTimeout(r, intervalMs));
      }
    }
  }
}
