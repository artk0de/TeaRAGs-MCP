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
 * **It reads the WHOLE collection once and filters in memory, rather than
 * scrolling per file.** A per-file `match.value` on `relativePath` measured
 * 677–1002 ms EACH against the live self-index, because the payload index on
 * that key is `text` and a text index does not serve `match.value` — so every
 * file was a full collection scan, and the first heal took 19 m 16 s for 1,032
 * files. One unfiltered pass over the same 22,415 points costs ~400 ms total.
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
import { pipelineLog } from "../infra/debug-logger.js";
import { batchSetPayloadWithRetry, type BatchPayloadOp } from "./batch-write.js";

/**
 * Payload keys the pass needs: the file identity it filters on, the symbol
 * identity, and the existing decline stamps. Anything else — `content` above
 * all — would turn a cheap traversal into hundreds of MB of transfer.
 */
const HEAL_PAYLOAD_INCLUDE = ["relativePath", "symbolId", "codegraph"];

/**
 * Pages between progress lines. The pass is one long traversal with no
 * per-file boundary to log at, and the first live heal printed NOTHING for 19
 * minutes — indistinguishable from a hang. Ten pages is ~10k points, often
 * enough to see movement on a small index and rare enough to stay quiet on a
 * large one.
 */
const HEAL_PROGRESS_EVERY_PAGES = 10;

export interface CodegraphPayloadHealerDeps {
  qdrant: {
    scrollPayloadPages: (
      collectionName: string,
      payloadInclude: string[],
      pageSize?: number,
    ) => AsyncGenerator<{ id: string | number; payload: Record<string, unknown> }[]>;
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
  /** Files the heal targeted (the diff's files, minus the ones this run rewrote). */
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

/** Points of one page grouped by what they are about to be written with. */
interface HealPageGroups {
  /** relPath -> ids taking the file level. */
  file: Map<string, (string | number)[]>;
  /** relPath -> symbolId -> ids taking the chunk level. */
  chunk: Map<string, Map<string, (string | number)[]>>;
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

    const filesTouched = new Set([...chunkTargets.keys(), ...fileTargets]).size;
    // The pass is the expensive part of the heal, and on a large collection the
    // only expensive part. Nothing to write means nothing to read.
    if (filesTouched === 0) return { pointsRewritten: 0, filesTouched: 0 };

    const touched = new Set<string | number>();
    let pagesScanned = 0;
    let pointsScanned = 0;
    let pointsMatched = 0;

    for await (const page of this.deps.qdrant.scrollPayloadPages(collectionName, HEAL_PAYLOAD_INCLUDE)) {
      pagesScanned++;
      pointsScanned += page.length;

      const groups = this.groupPage(page, chunkTargets, fileTargets);
      pointsMatched += countGrouped(groups);
      // Per page, not per pass: the groups are dropped once written, so what
      // survives the loop is the id set alone — memory scales with the TARGET
      // set, never with the collection.
      await this.flush(collectionName, groups, touched, enrichedAt);

      if (pagesScanned % HEAL_PROGRESS_EVERY_PAGES === 0) {
        pipelineLog.enrichmentPhase("CODEGRAPH_PAYLOAD_HEAL_PROGRESS", {
          collection: collectionName,
          pagesScanned,
          pointsScanned,
          pointsMatched,
          pointsWritten: touched.size,
        });
      }
    }

    return { pointsRewritten: touched.size, filesTouched };
  }

  /** One page: keep the points the target set names, grouped by the payload they will take. */
  private groupPage(
    page: { id: string | number; payload: Record<string, unknown> }[],
    chunkTargets: ReadonlyMap<string, Set<string>>,
    fileTargets: ReadonlySet<string>,
  ): HealPageGroups {
    const groups: HealPageGroups = { file: new Map(), chunk: new Map() };

    for (const { id, payload } of page) {
      const relPath = typeof payload.relativePath === "string" ? payload.relativePath : null;
      if (relPath === null) continue;
      const changedSymbols = chunkTargets.get(relPath);
      const wantsFile = fileTargets.has(relPath);
      // The overwhelming majority of a full pass: points of files nothing in
      // the graph moved. Rejected before either decline walk.
      if (!wantsFile && changedSymbols === undefined) continue;

      // FILE level: one payload for every point of the file, so one operation
      // per page — the same coalescing `applyFinalizeFile` does, for the same
      // reason. A file whose points span pages simply yields one op per page.
      if (wantsFile && !isDeclined(payload, this.deps.providerKey, "file")) {
        push(groups.file, relPath, id);
      }

      // CHUNK level: grouped by symbol, because a symbol's payload is the same
      // for every chunk it covers (an oversized method split into `#partN`
      // chunks, a class chunk merged from several) but differs between symbols.
      if (changedSymbols === undefined) continue;
      const symbolId = typeof payload.symbolId === "string" ? payload.symbolId : null;
      if (symbolId === null || !changedSymbols.has(symbolId)) continue;
      if (isDeclined(payload, this.deps.providerKey, "chunk")) continue;
      let bySymbol = groups.chunk.get(relPath);
      if (!bySymbol) {
        bySymbol = new Map<string, (string | number)[]>();
        groups.chunk.set(relPath, bySymbol);
      }
      push(bySymbol, symbolId, id);
    }

    return groups;
  }

  /** Turn one page's groups into level-scoped operations and write them. */
  private async flush(
    collectionName: string,
    groups: HealPageGroups,
    touched: Set<string | number>,
    enrichedAt?: string,
  ): Promise<void> {
    const operations: BatchPayloadOp[] = [];

    for (const [relPath, ids] of groups.file) {
      // Both builders are memoised bulk reads, so a file seen on several pages
      // costs a map lookup per page, not a graph round-trip.
      const file = await this.deps.buildFileSignals(relPath);
      if (!file) continue;
      operations.push({ payload: stamp(file, enrichedAt), points: ids, key: `${this.deps.providerKey}.file` });
      for (const id of ids) touched.add(id);
    }

    for (const [relPath, bySymbol] of groups.chunk) {
      for (const [symbolId, ids] of bySymbol) {
        const chunk = await this.deps.buildChunkSignals(relPath, symbolId);
        if (!chunk) continue;
        operations.push({ payload: stamp(chunk, enrichedAt), points: ids, key: `${this.deps.providerKey}.chunk` });
        for (const id of ids) touched.add(id);
      }
    }

    if (operations.length === 0) return;
    // Retried, for the reason `batch-write.ts` was written: a single transient
    // Qdrant blip mid-run used to drop a whole batch of signals silently. A
    // budget that is genuinely exhausted is a different thing and must NOT be
    // swallowed — the baseline advances only if `heal` resolves, so returning
    // quietly here would record "healed" over points that were never written.
    // Throwing abandons the PASS, not just the page, for the same reason.
    const ok = await batchSetPayloadWithRetry(this.deps.qdrant, collectionName, operations);
    if (!ok) {
      throw new Error(
        "codegraph payload heal: a payload write failed after every retry. " +
          "Nothing is recorded as healed; the diff stands for the next run.",
      );
    }
  }
}

/** Append `value` to the list at `key`, creating it on first use. */
function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

/** Points a page contributed at either level, counted once per level's group. */
function countGrouped(groups: HealPageGroups): number {
  const ids = new Set<string | number>();
  for (const list of groups.file.values()) for (const id of list) ids.add(id);
  for (const bySymbol of groups.chunk.values()) {
    for (const list of bySymbol.values()) for (const id of list) ids.add(id);
  }
  return ids.size;
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
 * Did the provider's policy already decline this point at this level? The pass
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
