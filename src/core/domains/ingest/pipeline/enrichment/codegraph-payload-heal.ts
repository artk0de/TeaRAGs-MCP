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
 * **How it FINDS those points is a cost decision, taken per heal** (bd
 * tea-rags-mcp-ivp12). Two shapes, both measured on the live self-index:
 *
 * - one unfiltered streaming pass over the whole collection, ~0.018 ms per
 *   point (407 ms for 22,415), independent of how many files moved;
 * - one exact scroll per target file, ~2 ms each, independent of collection
 *   size — but only since exact matching started riding the text index. A bare
 *   `match.value` on `relativePath` was 677–1002 ms, because that key's only
 *   index is `text` and a text index does not serve `match.value`; every file
 *   was a full scan of its own and the first live heal took 19 m 16 s for 1,032
 *   files.
 *
 * So the pass wins on a big diff and the scrolls win on a small one, and
 * {@link CodegraphPayloadHealer.usesPerFileScrolls} says where they cross. The
 * two shapes differ ONLY in how points arrive: grouping, flushing, the
 * touched-id set and the throw are shared, with a per-file scroll's result fed
 * through as one "page".
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

import { exactMatchOnTextIndexed } from "../../../../adapters/qdrant/filters/text-indexed-exact.js";
import type { CodegraphSignalDrift } from "../../../../contracts/types/codegraph.js";
import { pipelineLog } from "../infra/debug-logger.js";
import { batchSetPayloadWithRetry, type BatchPayloadOp } from "./batch-write.js";

/**
 * Payload keys the pass reads, and nothing else: the file identity it filters
 * on, the symbol identity, and the two decline stamps. `content` above all must
 * stay out — materializing it for every point of the collection is hundreds of
 * MB for a read that wants four scalars.
 *
 * The stamps are addressed as NESTED paths rather than by pulling the whole
 * `codegraph` subtree: `with_payload.include` takes dotted key paths, and the
 * subtree also carries the file and chunk signal blocks, which this pass
 * OVERWRITES without ever reading. Built from the injected `providerKey`, so
 * the keys the pass reads can never name a different subtree than the keys it
 * writes.
 */
function healPayloadInclude(providerKey: string): string[] {
  return ["relativePath", "symbolId", `${providerKey}.file.skippedAs`, `${providerKey}.chunk.skippedAs`];
}

/**
 * Pages between progress lines. The pass is one long traversal with no
 * per-file boundary to log at, and the first live heal printed NOTHING for 19
 * minutes — indistinguishable from a hang. Ten pages is ~10k points, often
 * enough to see movement on a small index and rare enough to stay quiet on a
 * large one.
 */
const HEAL_PROGRESS_EVERY_PAGES = 10;

/**
 * Milliseconds the full streaming pass costs per point of the COLLECTION,
 * whatever the diff names: 407 ms over 22,415 points on the live self-index.
 */
const FULL_PASS_MS_PER_POINT = 0.018;

/**
 * Milliseconds one exact per-file scroll costs, whatever the collection holds:
 * 1.7–2.0 ms measured for the text+value pair on a text-indexed `relativePath`
 * (`exactMatchOnTextIndexed`). Rounded UP, so the comparison errs towards the
 * shape whose cost is already known to be bounded.
 */
const PER_FILE_SCROLL_MS = 2;

/**
 * Hard cap on the points one per-file scroll returns, since `scrollFiltered`
 * needs one. Far above any real file's chunk count — a 10,000-chunk file does
 * not exist — so it never truncates in practice; it is here so a pathological
 * payload cannot page forever.
 */
const HEAL_PER_FILE_SCROLL_LIMIT = 10_000;

/**
 * Points per page inside one per-file scroll.
 *
 * `scrollFiltered` defaults to `min(limit, 200)`, which would turn a
 * 1,000-chunk file into five round trips and blow the ~2 ms-per-file cost model
 * the mode decision is built on. One file's points are wanted whole and thrown
 * away immediately after, so there is nothing to stream: page at the cap and
 * take one round trip.
 */
const HEAL_PER_FILE_PAGE_SIZE = HEAL_PER_FILE_SCROLL_LIMIT;

export interface CodegraphPayloadHealerDeps {
  qdrant: {
    scrollPayloadPages: (
      collectionName: string,
      payloadInclude: string[],
      pageSize?: number,
    ) => AsyncGenerator<{ id: string | number; payload: Record<string, unknown> }[]>;
    /** One file's points, for the per-file shape. Same projection as the pass. */
    scrollFiltered: (
      collectionName: string,
      filter: Record<string, unknown>,
      limit: number,
      pageSize?: number,
      payloadInclude?: string[],
    ) => Promise<{ id: string | number; payload: Record<string, unknown> }[]>;
    /** The collection's size, read ONCE per heal to choose the read shape. */
    countPoints: (collectionName: string, filter?: Record<string, unknown>) => Promise<number>;
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
  /** The pass's payload projection, built once off `providerKey`. */
  private readonly payloadInclude: string[];

  constructor(private readonly deps: CodegraphPayloadHealerDeps) {
    this.payloadInclude = healPayloadInclude(deps.providerKey);
  }

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

    const targetFiles = new Set([...chunkTargets.keys(), ...fileTargets]);
    const filesTouched = targetFiles.size;
    // The read is the expensive part of the heal, and on a large collection the
    // only expensive part. Nothing to write means nothing to read — and nothing
    // to decide, so not even the count is paid for.
    if (filesTouched === 0) return { pointsRewritten: 0, filesTouched: 0 };

    const touched = new Set<string | number>();
    const collectionPoints = await this.deps.qdrant.countPoints(collectionName);

    if (CodegraphPayloadHealer.usesPerFileScrolls(filesTouched, collectionPoints)) {
      await this.healByFile(collectionName, targetFiles, chunkTargets, fileTargets, touched, enrichedAt);
    } else {
      await this.healByFullPass(collectionName, chunkTargets, fileTargets, touched, enrichedAt);
    }

    return { pointsRewritten: touched.size, filesTouched };
  }

  /**
   * Which read shape is cheaper for this heal: `targetFiles × PER_FILE_SCROLL_MS`
   * against `collectionPoints × FULL_PASS_MS_PER_POINT`. Works out to roughly
   * one file per 111 points — the self-index's 22,415 points put the crossover
   * near 200 files, so the first sweep (1,032 files) takes the pass and a
   * steady-state diff of a handful takes the scrolls.
   *
   * Static and named so the decision can be read without reading the loop.
   */
  private static usesPerFileScrolls(targetFiles: number, collectionPoints: number): boolean {
    return targetFiles * PER_FILE_SCROLL_MS < collectionPoints * FULL_PASS_MS_PER_POINT;
  }

  /** One exact scroll per target file; each file's points are one "page". */
  private async healByFile(
    collectionName: string,
    targetFiles: ReadonlySet<string>,
    chunkTargets: ReadonlyMap<string, Set<string>>,
    fileTargets: ReadonlySet<string>,
    touched: Set<string | number>,
    enrichedAt?: string,
  ): Promise<void> {
    let filesScanned = 0;
    for (const relPath of targetFiles) {
      filesScanned++;
      const points = await this.deps.qdrant.scrollFiltered(
        collectionName,
        { must: exactMatchOnTextIndexed("relativePath", relPath) },
        HEAL_PER_FILE_SCROLL_LIMIT,
        HEAL_PER_FILE_PAGE_SIZE,
        this.payloadInclude,
      );
      // Same grouping and the same flush: a file the filter already narrowed to
      // still goes through `groupPage`, because that is where the decline guard
      // and the symbol-level split live.
      await this.flush(
        collectionName,
        this.groupPage(points, chunkTargets, fileTargets),
        touched,
        filesScanned,
        enrichedAt,
      );
    }
  }

  /** One streaming pass over the whole collection, filtering in memory. */
  private async healByFullPass(
    collectionName: string,
    chunkTargets: ReadonlyMap<string, Set<string>>,
    fileTargets: ReadonlySet<string>,
    touched: Set<string | number>,
    enrichedAt?: string,
  ): Promise<void> {
    let pagesScanned = 0;
    let pointsScanned = 0;
    let pointsMatched = 0;

    for await (const page of this.deps.qdrant.scrollPayloadPages(collectionName, this.payloadInclude)) {
      pagesScanned++;
      pointsScanned += page.length;

      const groups = this.groupPage(page, chunkTargets, fileTargets);
      pointsMatched += countGrouped(groups);
      // Per page, not per pass: the groups are dropped once written, so what
      // survives the loop is the id set alone — memory scales with the TARGET
      // set, never with the collection.
      await this.flush(collectionName, groups, touched, pagesScanned, enrichedAt);

      if (pagesScanned % HEAL_PROGRESS_EVERY_PAGES === 0) {
        // Only this shape needs it: the pass has no per-file boundary and runs
        // for minutes on a large index, where per-file mode is by construction
        // the small case.
        pipelineLog.enrichmentPhase("CODEGRAPH_PAYLOAD_HEAL_PROGRESS", {
          collection: collectionName,
          pagesScanned,
          pointsScanned,
          pointsMatched,
          pointsWritten: touched.size,
        });
      }
    }
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
        appendTo(groups.file, relPath, id);
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
      appendTo(bySymbol, symbolId, id);
    }

    return groups;
  }

  /** Turn one page's groups into level-scoped operations and write them. */
  private async flush(
    collectionName: string,
    groups: HealPageGroups,
    touched: Set<string | number>,
    pagesScanned: number,
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
        `codegraph payload heal: the payload write for page ${pagesScanned} failed after every retry, ` +
          `covering ${describeGroups(groups)}. Writes from earlier pages DID land — they are idempotent ` +
          "and re-running them costs nothing — but the baseline is not advanced, so the whole diff " +
          "stands for the next run.",
      );
    }
  }
}

/** Append `value` to the list at `key`, creating it on first use. */
function appendTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

/** Files named in a failed page's error before the list is elided. */
const FILES_NAMED_IN_ERROR = 5;

/**
 * The files a failed page was writing. Bounded on purpose: one page can group
 * hundreds of files, and an exception message is not the place to print them
 * all — the point is to give the reader somewhere to start looking.
 */
function describeGroups(groups: HealPageGroups): string {
  const paths = [...new Set([...groups.file.keys(), ...groups.chunk.keys()])];
  if (paths.length === 0) return "no files";
  const shown = paths.slice(0, FILES_NAMED_IN_ERROR);
  const rest = paths.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
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
 * projects exactly the two `<providerKey>.{file,chunk}.skippedAs` leaves so this
 * can be answered without a second read.
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
