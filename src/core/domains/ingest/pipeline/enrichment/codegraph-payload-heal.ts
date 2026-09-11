/**
 * CodegraphPayloadHealer — the SECOND writer of `codegraph.symbols.{file,chunk}`
 * (bd tea-rags-mcp-a2ddb).
 *
 * `EnrichmentApplier` writes those keys for the files in a run's chunk map. The
 * derived signals under them, though, are properties of the whole graph: a file
 * that nobody edited loses a caller, gains an importer, or drops in PageRank
 * because some OTHER file changed. Nothing in the pipeline could see that — the
 * file is clean, so it is never re-enriched — and the payload kept describing a
 * graph that no longer existed. `find_symbol`, every fan filter and every
 * codegraph rerank preset read those stale numbers with no warning anywhere.
 *
 * This class closes that gap. It takes the symbols and files
 * `GraphDbClient#diffSymbolSignals` says moved, drops the ones this run already
 * rewrote, and re-writes exactly the rest — payload only. No extraction, no
 * embeddings, no chunk-set change.
 *
 * Two invariants it shares with the applier, both load-bearing:
 *
 * - **Writes are scoped by `op.key`, with BARE inner keys.** `set_payload` with
 *   a nested `key` assigns at that path and preserves siblings; a root write
 *   does not. Both levels live on the SAME physical points, so a root write of
 *   `{ codegraph: { symbols: { chunk } } }` erases `codegraph.symbols.file`,
 *   the run still reports success, and the loss only surfaces at query time.
 * - **A level the policy declined is left alone.** `skippedAs` and `enrichedAt`
 *   are mutually exclusive terminal states of one decision, so a point carrying
 *   a decline at a level never takes signals at that level here either.
 *   Excluded files are absent from the graph and so from the diff, which makes
 *   the guard belt-and-braces rather than load-bearing — but a future widening
 *   of what enters the graph would otherwise produce contradictory points with
 *   nothing failing.
 *
 * The signal arithmetic is NOT duplicated: `buildFileSignals` / `buildChunkSignals`
 * are injected closures over the codegraph trajectory's own
 * `buildCodegraphFileSignals` / `buildCodegraphChunkSignals`, composed at the
 * api layer (`api/internal/infra/codegraph-payload-heal-runner.ts`) because
 * `domains/ingest` may not import `domains/trajectory`.
 */

import type { CodegraphSignalDrift } from "../../../../contracts/types/codegraph.js";
import type { BatchPayloadOp } from "./batch-write.js";

/**
 * One file's points per scroll. A file with more chunks than this is a chunker
 * defect, not a heal concern — the cap exists so a pathological payload cannot
 * turn one file into an unbounded pagination loop inside the serial tail.
 */
const HEAL_SCROLL_CAP = 10_000;

/**
 * Files healed concurrently. The heal is per-file (one scroll + one write each)
 * and runs in the completion tail, where cost is wall-clock one-for-one; the
 * first run after migration 023 names EVERY file, so a strictly serial loop
 * would add one round-trip's latency per file of the corpus. Same bounded
 * cursor-over-workers shape as the applier's finalize writes, and bounded for
 * the same reason: this shares a Qdrant with the rest of the tail, and an
 * unbounded fan-out only moves the queue.
 */
const HEAL_FILE_CONCURRENCY = 8;

/** Payload keys the scroll needs: the symbol identity and the existing decline stamps. */
const HEAL_PAYLOAD_INCLUDE = ["symbolId", "codegraph"];

export interface CodegraphPayloadHealerDeps {
  qdrant: {
    scrollFiltered: (
      collectionName: string,
      filter: Record<string, unknown>,
      limit: number,
      pageSize?: number,
      payloadInclude?: string[],
    ) => Promise<{ id: string | number; payload: Record<string, unknown> }[]>;
    batchSetPayload: (collectionName: string, operations: BatchPayloadOp[]) => Promise<void>;
  };
  /**
   * The codegraph provider's own key (`codegraph.symbols`). Injected rather than
   * hardcoded so the heal cannot address a different subtree than the applier:
   * the composition root reads it off the provider instance.
   */
  providerKey: string;
  /** Fresh chunk-level signals for one symbol, or null when the graph has nothing to say. */
  buildChunkSignals: (relPath: string, symbolId: string) => Promise<Record<string, unknown> | null>;
  /** Fresh file-level signals for one file, or null when the graph has nothing to say. */
  buildFileSignals: (relPath: string) => Promise<Record<string, unknown> | null>;
}

export interface CodegraphPayloadHealOutcome {
  /** DISTINCT points that took at least one level's write. */
  pointsRewritten: number;
  /** Files the heal scrolled (the diff's files, minus the ones this run rewrote). */
  filesTouched: number;
}

/**
 * The whole heal for one collection, as the enrichment run sees it: diff the
 * signals, rewrite what moved, then record the new baseline. Implemented at the
 * api layer, where the graph client and Qdrant are both in scope; undefined when
 * codegraph is disabled, in which case the run skips the step entirely.
 */
export interface CodegraphPayloadHealRunner {
  run: (
    collectionName: string,
    skipRelPaths: ReadonlySet<string>,
    enrichedAt?: string,
  ) => Promise<CodegraphPayloadHealOutcome>;
}

export class CodegraphPayloadHealer {
  constructor(private readonly deps: CodegraphPayloadHealerDeps) {}

  async heal(
    collectionName: string,
    changed: CodegraphSignalDrift,
    skipRelPaths: ReadonlySet<string>,
    enrichedAt?: string,
  ): Promise<CodegraphPayloadHealOutcome> {
    const chunkTargets = new Map<string, Set<string>>();
    for (const { relPath, symbolId } of changed.symbols) {
      // This run's chunk map already rewrote these points with the same
      // builders — re-writing them would be a second identical write.
      if (skipRelPaths.has(relPath)) continue;
      let symbols = chunkTargets.get(relPath);
      if (!symbols) {
        symbols = new Set<string>();
        chunkTargets.set(relPath, symbols);
      }
      symbols.add(symbolId);
    }
    const fileTargets = new Set<string>();
    for (const { relPath } of changed.files) {
      if (!skipRelPaths.has(relPath)) fileTargets.add(relPath);
    }

    const relPaths = [...new Set([...chunkTargets.keys(), ...fileTargets])];
    if (relPaths.length === 0) return { pointsRewritten: 0, filesTouched: 0 };

    let pointsRewritten = 0;
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(HEAL_FILE_CONCURRENCY, relPaths.length) }, async () => {
        for (let i = cursor++; i < relPaths.length; i = cursor++) {
          const relPath = relPaths[i];
          const healed = await this.healFile(
            collectionName,
            relPath,
            chunkTargets.get(relPath),
            fileTargets.has(relPath),
            enrichedAt,
          );
          // Accumulate AFTER the await, never as `x += await f()`: that form
          // reads `x` before suspending, so with several workers in flight each
          // one adds to the value it saw on entry and the others' counts vanish.
          pointsRewritten += healed;
        }
      }),
    );

    return { pointsRewritten, filesTouched: relPaths.length };
  }

  /** One file: scroll its points, assemble the level ops, write them. Returns distinct points touched. */
  private async healFile(
    collectionName: string,
    relPath: string,
    changedSymbols: ReadonlySet<string> | undefined,
    healFileLevel: boolean,
    enrichedAt?: string,
  ): Promise<number> {
    const points = await this.deps.qdrant.scrollFiltered(
      collectionName,
      { must: [{ key: "relativePath", match: { value: relPath } }] },
      HEAL_SCROLL_CAP,
      undefined,
      HEAL_PAYLOAD_INCLUDE,
    );
    if (points.length === 0) return 0;

    const touched = new Set<string | number>();
    const operations: BatchPayloadOp[] = [];

    // FILE level: one payload for every point of the file, so one operation —
    // the same coalescing `applyFinalizeFile` does, for the same reason.
    if (healFileLevel) {
      const file = await this.deps.buildFileSignals(relPath);
      if (file) {
        const targets = points.filter((p) => !isDeclined(p.payload, this.deps.providerKey, "file")).map((p) => p.id);
        if (targets.length > 0) {
          operations.push({ payload: stamp(file, enrichedAt), points: targets, key: `${this.deps.providerKey}.file` });
          for (const id of targets) touched.add(id);
        }
      }
    }

    // CHUNK level: grouped by symbol, because a symbol's payload is the same for
    // every chunk it covers (an oversized method split into `#partN` chunks, a
    // class chunk merged from several) but differs between symbols.
    if (changedSymbols && changedSymbols.size > 0) {
      const bySymbol = new Map<string, (string | number)[]>();
      for (const p of points) {
        const symbolId = typeof p.payload.symbolId === "string" ? p.payload.symbolId : null;
        if (!symbolId || !changedSymbols.has(symbolId)) continue;
        if (isDeclined(p.payload, this.deps.providerKey, "chunk")) continue;
        const ids = bySymbol.get(symbolId) ?? [];
        ids.push(p.id);
        bySymbol.set(symbolId, ids);
      }
      for (const [symbolId, ids] of bySymbol) {
        const chunk = await this.deps.buildChunkSignals(relPath, symbolId);
        if (!chunk) continue;
        operations.push({ payload: stamp(chunk, enrichedAt), points: ids, key: `${this.deps.providerKey}.chunk` });
        for (const id of ids) touched.add(id);
      }
    }

    if (operations.length === 0) return 0;
    await this.deps.qdrant.batchSetPayload(collectionName, operations);
    return touched.size;
  }
}

/**
 * The run's `enrichedAt` rides along with the signals, exactly as the applier
 * stamps it: one identical value for every point a run touches. A point healed
 * here already carried an `enrichedAt` from the run that last wrote it — this
 * one says the CURRENT run is what its numbers came from, which is the only
 * reading that stays true.
 */
function stamp(signals: Record<string, unknown>, enrichedAt?: string): Record<string, unknown> {
  return enrichedAt ? { ...signals, enrichedAt } : { ...signals };
}

/**
 * Did the provider's policy already decline this point at this level? The scroll
 * asks for the `codegraph` subtree precisely so this can be answered without a
 * second read.
 */
function isDeclined(payload: Record<string, unknown>, providerKey: string, level: "file" | "chunk"): boolean {
  // `providerKey` is dotted (`codegraph.symbols`) and the payload nests one
  // level per segment, so walk it rather than indexing with the whole string.
  let node: unknown = payload;
  for (const segment of [...providerKey.split("."), level]) {
    if (typeof node !== "object" || node === null) return false;
    node = (node as Record<string, unknown>)[segment];
  }
  return typeof node === "object" && node !== null && (node as Record<string, unknown>).skippedAs !== undefined;
}
