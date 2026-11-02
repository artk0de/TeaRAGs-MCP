/**
 * SymbolSearchStrategy — find chunks by symbol name.
 *
 * Scrolls twice (symbolId + parentSymbolId), deduplicates by id, resolves
 * into outline/merged results via resolveSymbols. Filter construction
 * lives here; the facade only dispatches.
 *
 * Per-request strategy (takes input via constructor), mirroring
 * SimilarSearchStrategy.
 *
 * ## symbolId tokenization (bd tea-rags-mcp-yx10)
 *
 * The Qdrant `symbolId` payload field is indexed as `text` with the default
 * `word` tokenizer (`TEXT_INDEXED_KEYS` in
 * `adapters/qdrant/filters/text-indexed-exact.ts`, applied by the schema
 * manager). The word tokenizer splits on every non-alphanumeric character, so
 * the stored value `Foo::Bar#baz=` tokenizes to `[foo, bar, baz]` (the `=`,
 * `?`, `!`, `#`, `::`, `.` are token separators and the `=`/`?`/`!`
 * suffixes are stripped at token boundary). The reduction to that one token is
 * `symbolIdTextToken`, which lives beside the index knowledge it depends on
 * (`adapters/qdrant/filters/symbolid-text-token.ts`) because
 * `scrollBySymbolIds` needs the same answer.
 *
 * Passing the full fully-qualified name to `match: { text }` joins those
 * tokens with AND. Under some live index states the join misses target
 * chunks entirely (empty result). To hit the row reliably we (1) reduce
 * the text query to the *last name segment only* — a single token that
 * is always present in the indexed tokens — and (2) post-filter the
 * scroll superset to keep only chunks whose stored `symbolId` exactly
 * matches the FQN. Short bare names (no `#`/`.`/`::` separator) keep
 * their existing behaviour.
 *
 * The post-filter also accepts member chunks: when the FQN query is a
 * class name, the parent-scroll returns the class's members, whose
 * `symbolId` does NOT equal the class FQN but whose `parentSymbolId`
 * matches the class's local name. `resolveSymbols` handles the outline
 * assembly downstream, so we let those members through.
 *
 * ## short-name navigation (bd tea-rags-mcp-xnfv)
 *
 * Without a post-filter, bare short queries (`set`, `bar`, `Foo`) ride
 * the Qdrant tokenized superset directly — every chunk whose symbolId
 * contains the token survives, even when the token sits in the middle
 * of the name (`setValue`, `Baroque`). To honor the developer's mental
 * model — "navigate to the symbol whose LAST segment is `set`" — we
 * post-filter the superset against the query, accepting any chunk
 * whose `symbolId` last segment OR `parentSymbolId` last segment equals
 * the query. Ruby method-name suffixes (`?`, `!`, `=`) are preserved in
 * the comparison so `updated=` and `updated` remain distinct.
 */

import {
  matchesTextIndexed,
  SYMBOL_SEPARATORS,
  symbolIdLastSegment,
  symbolIdTextToken,
  symbolIdTextTokens,
} from "../../../adapters/qdrant/filters/symbolid-text-token.js";
import { exactMatchOnTextIndexed } from "../../../adapters/qdrant/filters/text-indexed-exact.js";
import type {
  QdrantCollectionCatalog,
  QdrantPayloadIndexAdmin,
  QdrantPointReader,
  QdrantSearchReader,
} from "../../../adapters/qdrant/ports.js";
import {
  isCodegraphUnavailableError,
  type CodegraphUnavailableError,
} from "../../../contracts/types/codegraph-unavailable.js";
import type {
  ContainerAncestorResolver,
  PersistedSymbolLineRanges,
  SymbolChunkLocation,
  SymbolChunkResolver,
  SymbolLineRange,
  SymbolVisibilityResolver,
} from "../../../contracts/types/codegraph.js";
import type { EmptyAnswerExplanation } from "../../../contracts/types/empty-answer.js";
import type { RerankMode } from "../../../contracts/types/reranker.js";
import { REFERENCED_DEFINITIONS_CHAR_BUDGET } from "../../../contracts/types/symbol-batch.js";
import type { PayloadSignalDescriptor, TrajectoryFilterBuilder } from "../../../contracts/types/trajectory.js";
import type { WorkingTreeGraphReader } from "../../../contracts/types/working-tree.js";
import { isUnderOwner } from "../../../primitives/ids/index.js";
import { compilePathPatternMatcher } from "../../../primitives/paths/index.js";
import {
  isTestChunk,
  isTestExampleChunk,
  memberOwnerOf,
  splitFragmentBase,
  type ScrollChunk,
} from "../chunk-grouping/index.js";
import { historyClockRerankOption } from "../history-clock.js";
import { lookupContainerAncestors } from "../outline-ancestors.js";
import { renderWithDeclaredVisibility } from "../outline-visibility.js";
import { applyEssentialSignals, keepPathPatternMatches } from "../post-process.js";
import {
  collectReferencedDefinitions,
  REFERENCED_DEFINITIONS_KEY,
  spendReferencedDefinitionsAllowance,
} from "../referenced-definitions.js";
import type { RerankerPort } from "../reranker-port.js";
import { resolveSymbols } from "../symbol-resolve.js";
import { examplePackMember } from "../test-pack.js";
import { relativePathOf } from "../working-tree/substitute.js";
import { claimWorkingTreeFloors, recordingTreeGraphReader } from "../working-tree/tree-graph-marker.js";
import { BaseExploreStrategy } from "./base.js";
import type { ExploreContext, ExploreResult } from "./types.js";

/** Qdrant scroll page size for symbol discovery. */
const SCROLL_LIMIT = 200;

/**
 * Scroll cap for a fully-qualified query (bd tea-rags-mcp-hditp). Its filter
 * holds one text condition per name segment, so the superset is the FQN's own
 * rows plus the few ids sharing every segment (measured on a large Ruby corpus:
 * 47–186 rows, against 862–8174 for the last segment alone) — the cap bounds a
 * pathological class, it does not page through namesakes.
 */
const QUALIFIED_SCROLL_LIMIT = 2000;

/** Suffix-match candidates an ambiguous answer names (EmptyAnswerExplanation: at most five). */
const MAX_SUFFIX_SUGGESTIONS = 5;

/** Default user-requested limit when caller doesn't specify one. */
const DEFAULT_USER_LIMIT = 50;

export interface SymbolSearchInput {
  symbol: string;
  language?: string;
  pathPattern?: string;
}

export class SymbolSearchStrategy extends BaseExploreStrategy {
  readonly type = "symbol" as unknown as "vector" | "hybrid" | "scroll-rank" | "similar";

  /** find_symbol answers for the working tree: delta rows replace base rows of delta files. */
  protected override readonly hasChunkFloor = true;

  constructor(
    qdrant: QdrantSearchReader & QdrantPointReader & QdrantPayloadIndexAdmin & QdrantCollectionCatalog,
    reranker: RerankerPort,
    payloadSignals: PayloadSignalDescriptor[],
    essentialKeys: string[],
    private readonly registry: TrajectoryFilterBuilder,
    private readonly input: SymbolSearchInput,
    private readonly chunkResolver?: SymbolChunkResolver,
    private readonly visibilityResolver?: SymbolVisibilityResolver,
    private readonly containerAncestorResolver?: ContainerAncestorResolver,
  ) {
    super(qdrant, reranker, payloadSignals, essentialKeys);
  }

  /** Why the answer is empty when a partial namespace path names several symbols (`ambiguous`); else undefined. */
  get emptyAnswer(): EmptyAnswerExplanation | undefined {
    return this.empty;
  }

  private empty?: EmptyAnswerExplanation;

  /** No overfetch — executeExplore scrolls a fixed SCROLL_LIMIT page. */
  protected override applyDefaults(ctx: ExploreContext): ExploreContext {
    return ctx;
  }

  protected async executeExplore(ctx: ExploreContext): Promise<ExploreResult[]> {
    const primaryFilter = this.buildSymbolFilter("symbolId");
    const parentFilter = this.buildSymbolFilter("parentSymbolId");

    const scrollLimit = isFullyQualified(this.input.symbol) ? QUALIFIED_SCROLL_LIMIT : SCROLL_LIMIT;
    const [symbolChunks, memberChunks] = await Promise.all([
      this.qdrant.scrollFiltered(ctx.collectionName, primaryFilter, scrollLimit),
      this.qdrant.scrollFiltered(ctx.collectionName, parentFilter, scrollLimit),
    ]);

    const seen = new Set(symbolChunks.map((c) => c.id));
    // Exact pathPattern (bd tea-rags-mcp-xf01b): the scroll filters carry only the
    // text pre-filter, a directory-token SUPERSET of what the glob names.
    const pathMatcher = compilePathPatternMatcher(this.input.pathPattern);
    // Chunk floor (bd tea-rags-mcp-xi2r9.3): the working tree's rows replace
    // the indexed rows of the files it changed, BEFORE the pathPattern and
    // exact-symbol filters — so a tree row is answered as its indexed twin was.
    const scrolled = await this.substituteFromWorkingTree(
      [...symbolChunks, ...memberChunks.filter((c) => !seen.has(c.id))],
      ctx,
      (row) => this.matchesSymbolScrolls(row),
    );
    const allChunks = pathMatcher ? keepPathPatternMatches(scrolled, pathMatcher) : scrolled;

    // Post-filter the scroll superset against the query:
    //   * FQN queries (with `#`, `.`, `::`) → keep chunks whose stored
    //     symbolId exactly matches the FQN, plus members of the FQN.
    //   * Short bare queries → keep chunks whose symbolId OR
    //     parentSymbolId last segment equals the query. Without this,
    //     the Qdrant tokenized superset leaks middle-of-name hits
    //     (`setValue` for `set`, `Baroque` for `bar`).
    // See class doc-comment for the tokenization + short-name rationale.
    const qualified = isFullyQualified(this.input.symbol)
      ? this.resolveQualified(allChunks)
      : { symbol: this.input.symbol, exact: filterByLastSegment(allChunks, this.input.symbol) };
    if (!qualified) return [];
    const { symbol, exact } = qualified;
    // A tiny test example shares a chunk with its tiny siblings, and a test
    // scope's setup a chunk with its neighbours' setup; either is named only in
    // that chunk's `memberSymbolIds` (bd tea-rags-mcp-5xpq4) — asked only when
    // no chunk answered the id as its own (a scope id is still answered by its
    // examples' parentSymbolId, which outlines them but is not its setup).
    const grouped =
      isFullyQualified(symbol) && !answersOwnId(exact, symbol)
        ? await this.substituteFromWorkingTree(await this.scrollPackMembers(ctx.collectionName), ctx, (row) =>
            this.matchesPackMemberScroll(row),
          )
        : [];
    const matched = pathMatcher ? [...exact, ...keepPathPatternMatches(grouped, pathMatcher)] : [...exact, ...grouped];
    // An example pack answers one of its members with that member alone (bd
    // tea-rags-mcp-g5i0a) — its own rows and lines, as if it were unpacked —
    // whether the id is the pack's own (first member) or reached through
    // `memberSymbolIds`. A pack matched as a MEMBER of the queried scope stays
    // whole: it is outlined, not answered.
    const filtered = isFullyQualified(symbol) ? matched.map((chunk) => answerPackMember(chunk, symbol)) : matched;

    // Outline member lines carry declared visibility (bd tea-rags-mcp-sqqkz),
    // container outlines their direct ancestors (bd tea-rags-mcp-82cot);
    // metaOnly strips the outline text, so there is nothing to decorate.
    const treeGraph = recordingTreeGraphReader(ctx.workingTreeView);
    const ancestorsOf = await lookupContainerAncestors(
      (lookup) => resolveSymbols(filtered, symbol, ctx.metaOnly, undefined, lookup),
      ctx.metaOnly ? undefined : this.containerAncestorResolver,
      ctx.collectionName,
      treeGraph,
    );
    const resolved = (await renderWithDeclaredVisibility(
      (visibilityOf) => resolveSymbols(filtered, symbol, ctx.metaOnly, visibilityOf, ancestorsOf),
      ctx.metaOnly ? undefined : this.visibilityResolver,
      ctx.collectionName,
      treeGraph,
    )) as ExploreResult[];
    if (resolved.length > 0) return resolved;

    // 0rskm — Qdrant scroll found no chunk for this symbolId. If codegraph is
    // wired, the symbol may be collapsed into a covering class chunk that has a
    // different symbolId. Two-hop: symbol_id → chunk_id → getPoint → result.
    //
    // On a working tree the tree's OWN definitions answer first (live D1): a
    // symbol the tree defines in a file it changed has no chunk id in any graph
    // (chunk ids are the index's), so the hop's last-segment tier would answer
    // `Cat#speak` with the base `Animal` chunk. It is placed on the tree's rows
    // by line instead. Only when the tree defines no match in a changed file
    // does the stored-chunk hop run — and the chunk it names is a delta row
    // when the tree has one by that id, else the index's chunk retargeted at
    // the tree (live P2-1): never the index's version of a touched file, and
    // nothing when the tree no longer has the symbol.
    const toResult = (row: ScrollChunk): ExploreResult => ({
      id: row.id,
      score: 1,
      payload: ctx.metaOnly ? withoutContent(row.payload) : { ...row.payload },
    });
    const treeDefined = await this.resolveViaTreeDefinitions(ctx, toResult);
    const covering =
      treeDefined.length > 0
        ? treeDefined
        : await this.retargetToWorkingTree(await this.resolveViaCodegraph(ctx, toResult), ctx, toResult);
    return pathMatcher ? keepPathPatternMatches(covering, pathMatcher) : covering;
  }

  /**
   * The rows of the files the tree CHANGED that hold a definition of the
   * queried symbol, as the tree graph places it (live D1): per definition, the
   * narrowest delta row whose lines cover it, else every delta row overlapping
   * it (a definition split across `#partN` rows). A qualified query matches a
   * definition id exactly; a bare one by last name segment — the hop's own
   * match rule. Empty when the request reads no tree with a built graph, the
   * resolver cannot read tree ranges, or the tree defines no match in a
   * changed file.
   */
  private async resolveViaTreeDefinitions(
    ctx: ExploreContext,
    toResult: (row: ScrollChunk) => ExploreResult,
  ): Promise<ExploreResult[]> {
    const view = ctx.workingTreeView;
    const readRanges = this.chunkResolver?.readTreeSymbolLineRanges;
    const readTreeGraph = recordingTreeGraphReader(view);
    if (!view?.readDeltaChunks || !readRanges || !readTreeGraph) return [];
    const changed = [...view.touchedPaths].filter((path) => !view.deletedPaths.has(path));
    if (changed.length === 0) return [];
    const ranges = await this.readTreeRanges(readRanges, ctx.collectionName, changed, readTreeGraph);
    if (!ranges) return [];
    const definitions = [...ranges].flatMap(([relPath, file]) =>
      file.ranges.filter((range) => this.namesQueriedSymbol(range.symbolId)).map((range) => ({ relPath, range })),
    );
    if (definitions.length === 0) return [];
    const deltaRows = (await view.readDeltaChunks()).filter((row) => this.matchesLanguage(row));
    const seen = new Set<string | number>();
    const answered = definitions
      .flatMap(({ relPath, range }) =>
        rowsHoldingDefinition(
          deltaRows.filter((row) => relativePathOf(row.payload) === relPath),
          range,
        ),
      )
      .filter((row) => !seen.has(row.id) && seen.add(row.id))
      .map(toResult);
    claimWorkingTreeFloors(view, ["chunks"], answered.length);
    return answered;
  }

  /** The tree-range read, optional like the chunk hop: codegraph unavailable skips it with the same notice. */
  private async readTreeRanges(
    readRanges: NonNullable<SymbolChunkResolver["readTreeSymbolLineRanges"]>,
    collectionName: string,
    changed: readonly string[],
    readTreeGraph: WorkingTreeGraphReader,
  ): Promise<ReadonlyMap<string, PersistedSymbolLineRanges> | null> {
    try {
      return await readRanges(collectionName, changed, readTreeGraph);
    } catch (err) {
      if (!isCodegraphUnavailableError(err)) throw err;
      this.codegraphSkipNotice = formatCodegraphFallbackSkipped(err);
      return null;
    }
  }

  /** Does a graph definition id answer the query — exactly when qualified, by last segment when bare? */
  private namesQueriedSymbol(symbolId: string): boolean {
    const query = this.input.symbol;
    return isFullyQualified(query) ? symbolId === query : symbolIdLastSegment(symbolId) === symbolIdLastSegment(query);
  }

  /**
   * The packed test chunk that carries the queried id among its
   * `memberSymbolIds` (bd tea-rags-mcp-5xpq4): a tiny example's group, or the
   * setup pack holding a scope's setup. The key is text-indexed like
   * `symbolId`, so the member id is matched as the same text token + value
   * pair — index-served, exact.
   */
  private async scrollPackMembers(
    collectionName: string,
  ): Promise<{ id: string | number; payload: Record<string, unknown> }[]> {
    const fqn = this.input.symbol;
    const must: Record<string, unknown>[] = [
      ...exactMatchOnTextIndexed("memberSymbolIds", fqn, symbolIdTextToken(fqn)),
    ];
    if (this.input.language) must.push({ key: "language", match: { value: this.input.language } });
    return this.qdrant.scrollFiltered(collectionName, { must }, SCROLL_LIMIT);
  }

  /** {@link scrollPackMembers}' filter as a predicate over a row Qdrant never stored. */
  private matchesPackMemberScroll(row: ScrollChunk): boolean {
    const { memberSymbolIds } = row.payload;
    return Array.isArray(memberSymbolIds) && memberSymbolIds.includes(this.input.symbol) && this.matchesLanguage(row);
  }

  /**
   * Set when this request's collapsed-symbol codegraph fallback was skipped
   * because codegraph is unavailable from this process. Read after `execute()`
   * — the strategy is per-request, so the notice belongs to exactly one answer.
   */
  get codegraphWarning(): string | undefined {
    return this.codegraphSkipNotice;
  }

  private codegraphSkipNotice?: string;

  private async resolveViaCodegraph(
    ctx: ExploreContext,
    toResult: (row: ScrollChunk) => ExploreResult,
  ): Promise<ExploreResult[]> {
    if (!this.chunkResolver) return [];
    const location = await this.resolveCoveringChunk(
      this.chunkResolver,
      ctx.collectionName,
      recordingTreeGraphReader(ctx.workingTreeView),
    );
    if (!location) return [];
    // A chunk id the tree's rows carry is answered from them: Qdrant never
    // stored a delta row, so `getPoint` would miss it.
    const deltaRow = await this.deltaRowById(ctx, location.chunkId);
    if (deltaRow) return [toResult(deltaRow)];
    const point = await this.qdrant.getPoint(ctx.collectionName, location.chunkId);
    if (!point) return [];
    const payload = point.payload ? { ...point.payload } : {};
    return [
      {
        id: point.id,
        score: 1,
        payload: ctx.metaOnly ? withoutContent(payload) : payload,
      },
    ];
  }

  /** The view's delta row stored under `chunkId`, claiming the chunk floor; undefined without one. */
  private async deltaRowById(ctx: ExploreContext, chunkId: string): Promise<ScrollChunk | undefined> {
    const view = ctx.workingTreeView;
    if (!view?.readDeltaChunks || view.touchedPaths.size === 0) return undefined;
    const row = (await view.readDeltaChunks()).find((delta) => String(delta.id) === chunkId);
    claimWorkingTreeFloors(view, ["chunks"], row ? 1 : 0);
    return row;
  }

  /**
   * The codegraph hop is OPTIONAL (bd tea-rags-mcp-a43tr): codegraph unavailable
   * from this process skips it with a notice instead of failing find_symbol.
   * The catch sits here, next to the optional hop, and not in
   * `GraphFacade#withReadHandle` — for get_callers / get_callees / find_cycles
   * an empty answer is an assertion about the code, so they must keep throwing.
   * Only the resolver call is guarded: any other failure, and the Qdrant
   * `getPoint` that follows, propagate.
   */
  private async resolveCoveringChunk(
    resolver: SymbolChunkResolver,
    collectionName: string,
    readTreeGraph: WorkingTreeGraphReader | undefined,
  ): Promise<SymbolChunkLocation | null> {
    try {
      // A clean tree's lookup is the index-only call it always was.
      return readTreeGraph
        ? await resolver.resolveSymbolChunk(collectionName, this.input.symbol, readTreeGraph)
        : await resolver.resolveSymbolChunk(collectionName, this.input.symbol);
    } catch (err) {
      if (!isCodegraphUnavailableError(err)) throw err;
      this.codegraphSkipNotice = formatCodegraphFallbackSkipped(err);
      return null;
    }
  }

  /**
   * Custom post-process — resolveSymbols already merges chunks into outline
   * results and strips payload.content on metaOnly. We keep that scaffolding
   * (chunkCount, mergedChunkIds, merged startLine/endLine) intact and only
   * adjust the git layer to match the semantic/hybrid contract:
   *
   *   metaOnly=true  → signal namespaces reduced to their essential keys, raw;
   *                    rankingOverlay (when reranked) stays on the result
   *   metaOnly=false → full payload passes through unchanged
   *
   * Using BaseExploreStrategy.applyMetaOnly would strip synthetic outline
   * fields (not present in payloadSignals), so we apply a targeted namespace
   * filter via applyEssentialSignals instead.
   */
  protected override async postProcess(
    results: ExploreResult[],
    originalCtx: ExploreContext,
  ): Promise<ExploreResult[]> {
    let processed = results;

    const rerank = originalCtx.rerank as RerankMode<string> | undefined;
    if (rerank) {
      // A symbol lookup is per-symbol: chunk-level scoring whatever the preset's
      // own `signalLevel` (the default of the list-ranking tools, 9z8ae).
      processed = await this.reranker.rerank(processed, rerank, "semantic_search", {
        signalLevel: "chunk",
        ...historyClockRerankOption(originalCtx),
      });
    }

    const offset = originalCtx.offset ?? 0;
    if (offset > 0) processed = processed.slice(offset);

    const limit = originalCtx.limit ?? DEFAULT_USER_LIMIT;
    processed = processed.slice(0, limit);

    if (originalCtx.metaOnly) {
      return processed.map((r) => applyEssentialSignals(r, this.essentialKeys) as ExploreResult);
    }

    // An example id answers with the example runnable in the head (msv3l):
    // its scope setup is stored once per scope and put back here (5xpq4).
    return this.hydrateTestSetup(await this.attachReferencedDefinitions(processed, originalCtx), originalCtx);
  }

  /**
   * Method rows gain `referencedDefinitions` (bd tea-rags-mcp-d0z7b.4): the
   * statements defining the class-level constants their body names, found
   * through the owner's header chunks and read from the tree file the view
   * reads — so the caller does not grep for the definition next. Their summed
   * text stays within {@link REFERENCED_DEFINITIONS_CHAR_BUDGET} per answer. No
   * tree file reader, or a file the view serves from the index → rows unchanged.
   */
  private async attachReferencedDefinitions(results: ExploreResult[], ctx: ExploreContext): Promise<ExploreResult[]> {
    const view = ctx.workingTreeView;
    const readTreeFile = view?.readTreeFile;
    if (!readTreeFile) return results;
    // One header scroll per (file, owner) and one tree read per file, however many rows share them.
    const headerChunksByOwner = new Map<string, Promise<ScrollChunk[]>>();
    const treeTexts = new Map<string, Promise<string | undefined>>();
    let allowance = REFERENCED_DEFINITIONS_CHAR_BUDGET;
    const attached: ExploreResult[] = [];
    for (const result of results) {
      const row = methodRowOf(result);
      if (!row || view.indexServedPaths?.has(row.relativePath)) {
        attached.push(result);
        continue;
      }
      const ownerKey = `${row.relativePath}\0${row.owner}`;
      if (!headerChunksByOwner.has(ownerKey)) {
        headerChunksByOwner.set(ownerKey, this.scrollOwnerHeaderChunks(ctx, row.owner, row.relativePath));
      }
      if (!treeTexts.has(row.relativePath)) treeTexts.set(row.relativePath, readTreeFile(row.relativePath));
      const [headerChunks, treeText] = await Promise.all([
        headerChunksByOwner.get(ownerKey),
        treeTexts.get(row.relativePath),
      ]);
      const definitions =
        treeText === undefined || !headerChunks || headerChunks.length === 0
          ? []
          : collectReferencedDefinitions({ body: row.body, ownerSymbolId: row.owner, headerChunks, treeText });
      if (definitions.length === 0) {
        attached.push(result);
        continue;
      }
      const spent = spendReferencedDefinitionsAllowance(
        { ...result, payload: { ...result.payload, [REFERENCED_DEFINITIONS_KEY]: definitions } },
        allowance,
      );
      allowance -= spent?.spent ?? 0;
      attached.push(spent?.result ?? result);
    }
    return attached;
  }

  /** The owner's class-level block chunks in `relativePath` — the tree's rows for a file it changed. */
  private async scrollOwnerHeaderChunks(
    ctx: ExploreContext,
    owner: string,
    relativePath: string,
  ): Promise<ScrollChunk[]> {
    const filter = {
      must: [
        ...exactMatchOnTextIndexed("parentSymbolId", owner, symbolIdTextToken(owner)),
        { key: "chunkType", match: { value: "block" } },
      ],
    };
    const isOwnHeader = (row: ScrollChunk): boolean =>
      row.payload.parentSymbolId === owner &&
      row.payload.chunkType === "block" &&
      relativePathOf(row.payload) === relativePath;
    const scrolled = await this.qdrant.scrollFiltered(ctx.collectionName, filter, SCROLL_LIMIT);
    const substituted = await this.substituteFromWorkingTree(scrolled, ctx, isOwnHeader);
    return substituted.filter(isOwnHeader);
  }

  /**
   * The rows answering a fully-qualified query, and the id they answer it as.
   * The exact id first; when no row carries it, the one id the query is a
   * segment-boundary SUFFIX of (`Ledger::Client` → `Tax::Ledger::Client`, bd
   * tea-rags-mcp-hditp) — a partial namespace path is how a caller names a
   * nested class it did not see whole. Several such ids → undefined, with
   * {@link emptyAnswer} naming them (`ambiguous`).
   */
  private resolveQualified(chunks: readonly ScrollChunk[]): { symbol: string; exact: ScrollChunk[] } | undefined {
    const { symbol } = this.input;
    const exact = filterByExactSymbolId(chunks, symbol);
    if (exact.length > 0) return { symbol, exact };
    const suffixed = idsEndingWith(chunks, symbol);
    if (suffixed.length === 1) return { symbol: suffixed[0], exact: filterByExactSymbolId(chunks, suffixed[0]) };
    if (suffixed.length === 0) return { symbol, exact };
    this.empty = {
      reason: "ambiguous",
      message: `${symbol} is the tail of ${suffixed.length} symbol ids — retry with one of them.`,
      suggestions: suffixed.slice(0, MAX_SUFFIX_SUGGESTIONS),
    };
    return undefined;
  }

  /**
   * The two scrolls' filters ({@link buildSymbolFilter}) as one predicate over a
   * row Qdrant never stored — the working tree's delta rows. Same text token,
   * same language condition; the pathPattern half is the text pre-filter the
   * exact matcher in `executeExplore` re-applies to every row anyway.
   */
  private matchesSymbolScrolls(row: ScrollChunk): boolean {
    const tokens = this.scrollTextTokens();
    const { symbolId, parentSymbolId } = row.payload;
    const carriesAll = (stored: unknown) => tokens.every((token) => matchesTextIndexed(stored, token));
    return (carriesAll(symbolId) || carriesAll(parentSymbolId)) && this.matchesLanguage(row);
  }

  /**
   * The text tokens both scrolls require, one condition each: a bare name's
   * single token, or one per segment of a fully-qualified id
   * (`symbolIdTextTokens`) — selective, so namesakes of the last segment no
   * longer fill the scroll page (bd tea-rags-mcp-hditp).
   */
  private scrollTextTokens(): string[] {
    const { symbol } = this.input;
    return isFullyQualified(symbol) ? symbolIdTextTokens(symbol) : [symbolIdTextToken(symbol)];
  }

  private matchesLanguage(row: ScrollChunk): boolean {
    return !this.input.language || row.payload.language === this.input.language;
  }

  private buildSymbolFilter(key: "symbolId" | "parentSymbolId"): Record<string, unknown> {
    // One text condition per token, never a whole FQN in one condition: full
    // FQNs tokenize to multiple tokens that, under default `word` tokenizer +
    // AND join, miss target rows on some live indices. Each segment alone is
    // always among the target row's indexed tokens (`scrollTextTokens`).
    // See class doc-comment for the tokenization rationale.
    const must: Record<string, unknown>[] = this.scrollTextTokens().map((token) => ({ key, match: { text: token } }));
    if (this.input.language) {
      must.push({ key: "language", match: { value: this.input.language } });
    }

    const filter: Record<string, unknown> = { must };
    if (!this.input.pathPattern) return filter;

    const extra = this.registry.buildMergedFilter({ pathPattern: this.input.pathPattern }, undefined, "chunk");
    if (!extra) return filter;

    const extraMust = extra.must as Record<string, unknown>[] | undefined;
    if (extraMust) (filter.must as Record<string, unknown>[]).push(...extraMust);

    const extraMustNot = extra.must_not as Record<string, unknown>[] | undefined;
    if (extraMustNot) filter.must_not = extraMustNot;

    return filter;
  }
}

/** Does the symbol contain a structural separator (FQN, not a bare name)? */
function isFullyQualified(symbol: string): boolean {
  return SYMBOL_SEPARATORS.test(symbol);
}

/** Namespace separators a partial path may start after: `B::C` is a tail of `A::B::C`, of `A.B::C` too. */
const NAMESPACE_BOUNDARIES = ["::", "."] as const;

/**
 * The distinct ids `query` is a segment-boundary suffix of — read off each
 * row's own id, its parent id and its member owner, so a class answered only
 * through its members is found too. Sorted, for a stable suggestion order.
 */
function idsEndingWith(chunks: readonly ScrollChunk[], query: string): string[] {
  const tails = NAMESPACE_BOUNDARIES.map((boundary) => `${boundary}${query}`);
  const found = new Set<string>();
  for (const chunk of chunks) {
    const symbolId = chunk.payload.symbolId as string | undefined;
    const parentSymbolId = chunk.payload.parentSymbolId as string | undefined;
    const owner = symbolId === undefined ? undefined : memberOwnerOf(symbolId);
    for (const id of [symbolId, parentSymbolId, owner]) {
      if (id !== undefined && tails.some((tail) => id.endsWith(tail))) found.add(id);
    }
  }
  return [...found].sort();
}

/**
 * The notice for a skipped codegraph fallback: what was skipped, why (the
 * error's code + message) and the remedy (the error's own hint — each class
 * of the codegraph-unavailable family owns its repair text).
 */
function formatCodegraphFallbackSkipped(err: CodegraphUnavailableError): string {
  return (
    `find_symbol: codegraph fallback for symbols collapsed into a covering chunk skipped [${err.code}] — ` +
    `${err.message}. Results cover only chunks indexed under their own symbolId. Remedy: ${err.hint}`
  );
}

/**
 * Keep only chunks whose stored `symbolId` exactly matches the FQN query,
 * OR whose `parentSymbolId` matches the last name segment of the query
 * (i.e. the chunk is a member of the requested container). Member chunks
 * are retained so `resolveSymbols` can compose the class outline.
 *
 * The Qdrant scroll returns a SUPERSET when matched by a single text
 * token — this filter narrows that superset before resolveSymbols runs.
 */
/** The chunk itself, or — for an example pack carrying `fqn` — that one member's view of it. */
function answerPackMember<C extends { payload: Record<string, unknown> }>(chunk: C, fqn: string): C {
  const member = examplePackMember(chunk.payload, fqn);
  return member ? { ...chunk, payload: member } : chunk;
}

/**
 * Did a chunk answer `fqn` as ITS OWN id — the chunk itself, or a `#partN`
 * window of it? Members matched through their `parentSymbolId` do not count:
 * they outline the id, they are not its body.
 */
function answersOwnId(chunks: readonly { payload: Record<string, unknown> }[], fqn: string): boolean {
  return chunks.some((c) => {
    const { symbolId } = c.payload;
    return typeof symbolId === "string" && symbolId.replace(/#part\d+$/, "") === fqn;
  });
}

function filterByExactSymbolId(
  chunks: readonly { id: string | number; payload: Record<string, unknown> }[],
  fqn: string,
): { id: string | number; payload: Record<string, unknown> }[] {
  const containerName = fqn.split(SYMBOL_SEPARATORS).pop() ?? fqn;
  return chunks.filter((c) => {
    const symbolId = c.payload.symbolId as string | undefined;
    if (symbolId === fqn) return true;
    const parentSymbolId = c.payload.parentSymbolId as string | undefined;
    // Member-of-container path: parentSymbolId can carry either the full
    // FQN (e.g. `Foo::Bar`) or just the local class name (e.g. `Bar`),
    // depending on language. Accept both forms — the local name only for a
    // member that lies under the queried FQN itself: the local name alone is
    // the FQN's TAIL, which any other owner's namesake carries too (q1g6s.15:
    // `Billing::Invoice.create` answered by JS `create#CallExpression`).
    if (parentSymbolId === fqn) return true;
    if (parentSymbolId === containerName && symbolId !== undefined && isUnderOwner(symbolId, fqn)) return true;
    // A `#partN` window of an oversized test example names the EXAMPLE as its
    // parent, not the scope; it stands for an example of the queried scope
    // when its base id extends the scope id (bd tea-rags-mcp-msv3l). An example
    // name is free text, so its scope is read by prefix, never by
    // `memberOwnerOf`'s last-separator split.
    if (isTestExampleChunk(c)) return splitFragmentBase(c.payload)?.startsWith(`${fqn}.`) === true;
    // A member split into `#partN` parts names the member as its parent; the
    // container is the member id's owner (bd tea-rags-mcp-y5vx4) — the FQN
    // itself; its bare tail would admit another owner's namesake (q1g6s.15).
    return splitPartOwner(c.payload) === fqn;
  });
}

/** The container of a split part's member: `Foo#bar#part2` → `Foo`; undefined for any other chunk. */
function splitPartOwner(payload: Record<string, unknown>): string | undefined {
  const base = splitFragmentBase(payload);
  return base === undefined ? undefined : memberOwnerOf(base);
}

/**
 * Keep only chunks whose last segment equals the query. Accepts both
 * the chunk's own `symbolId` (top-level / member symbol whose tail
 * matches) and its `parentSymbolId` (chunk is a member of a container
 * whose last segment matches — surfaced so `resolveSymbols` can stitch
 * outlines on a class-name query).
 *
 *   query "set"      keeps "set", "app.set", "Foo#set"; drops "setValue", "fooSet"
 *   query "Foo"      keeps "Foo" and chunks with parentSymbolId "Foo"
 *   query "updated=" keeps "updated=" and "Foo#updated="; drops "Foo#updated"
 */
function filterByLastSegment(
  chunks: readonly { id: string | number; payload: Record<string, unknown> }[],
  query: string,
): { id: string | number; payload: Record<string, unknown> }[] {
  const target = symbolIdLastSegment(query);
  return chunks.filter((c) => {
    const symbolId = c.payload.symbolId as string | undefined;
    if (symbolId !== undefined && symbolIdLastSegment(symbolId) === target) return true;
    const parentSymbolId = c.payload.parentSymbolId as string | undefined;
    if (parentSymbolId !== undefined && symbolIdLastSegment(parentSymbolId) === target) return true;
    const owner = splitPartOwner(c.payload);
    return owner !== undefined && symbolIdLastSegment(owner) === target;
  });
}

/**
 * The rows of one file that hold a definition spanning `range`: the narrowest
 * row covering it whole, else every row overlapping it (a definition split
 * across `#partN` rows), else none.
 */
function rowsHoldingDefinition(rows: readonly ScrollChunk[], range: SymbolLineRange): ScrollChunk[] {
  const lines = (row: ScrollChunk): { start: number; end: number } | undefined => {
    const { startLine, endLine } = row.payload;
    return typeof startLine === "number" && typeof endLine === "number"
      ? { start: startLine, end: endLine }
      : undefined;
  };
  const covering = rows
    .filter((row) => {
      const span = lines(row);
      return span !== undefined && span.start <= range.startLine && span.end >= range.endLine;
    })
    .sort((a, b) => spanOf(lines(a)) - spanOf(lines(b)));
  if (covering.length > 0) return [covering[0]];
  return rows.filter((row) => {
    const span = lines(row);
    return span !== undefined && span.start <= range.endLine && span.end >= range.startLine;
  });
}

function spanOf(lines: { start: number; end: number } | undefined): number {
  return lines ? lines.end - lines.start : Number.POSITIVE_INFINITY;
}

/** A payload copy without its `content` — the metaOnly shape of a codegraph-hop answer. */
function withoutContent(payload: Record<string, unknown>): Record<string, unknown> {
  const { content: _content, ...rest } = payload;
  return rest;
}

/**
 * A row whose body may reference its owner's class-level constants: a code
 * member with content and an owner — never an outline, a header block or a test.
 */
function methodRowOf(result: ExploreResult): { body: string; owner: string; relativePath: string } | undefined {
  const { payload } = result;
  if (!payload || payload.kind !== undefined) return undefined;
  const { content, parentSymbolId, relativePath, chunkType } = payload;
  if (typeof content !== "string" || content === "" || typeof parentSymbolId !== "string") return undefined;
  if (typeof relativePath !== "string" || chunkType === "class" || chunkType === "block") return undefined;
  if (isTestChunk({ id: result.id ?? "", payload })) return undefined;
  return { body: content, owner: parentSymbolId, relativePath };
}
