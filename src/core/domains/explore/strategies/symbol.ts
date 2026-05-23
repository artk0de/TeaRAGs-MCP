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
 * `word` tokenizer (see `src/core/adapters/qdrant/schema-manager.ts:104`).
 * The word tokenizer splits on every non-alphanumeric character, so the
 * stored value `Foo::Bar#baz=` tokenizes to `[foo, bar, baz]` (the `=`,
 * `?`, `!`, `#`, `::`, `.` are token separators and the `=`/`?`/`!`
 * suffixes are stripped at token boundary).
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

import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import type { PayloadSignalDescriptor } from "../../../contracts/types/trajectory.js";
import type { TrajectoryRegistry } from "../../../domains/trajectory/index.js";
import { applyEssentialSignalsToOverlay } from "../post-process.js";
import type { Reranker, RerankMode } from "../reranker.js";
import { resolveSymbols } from "../symbol-resolve.js";
import { BaseExploreStrategy } from "./base.js";
import type { ExploreContext, ExploreResult } from "./types.js";

/** Qdrant scroll page size for symbol discovery. */
const SCROLL_LIMIT = 200;

/** Default user-requested limit when caller doesn't specify one. */
const DEFAULT_USER_LIMIT = 50;

export interface SymbolSearchInput {
  symbol: string;
  language?: string;
  pathPattern?: string;
}

export class SymbolSearchStrategy extends BaseExploreStrategy {
  readonly type = "symbol" as unknown as "vector" | "hybrid" | "scroll-rank" | "similar";

  constructor(
    qdrant: QdrantManager,
    reranker: Reranker,
    payloadSignals: PayloadSignalDescriptor[],
    essentialKeys: string[],
    private readonly registry: TrajectoryRegistry,
    private readonly input: SymbolSearchInput,
  ) {
    super(qdrant, reranker, payloadSignals, essentialKeys);
  }

  /** No overfetch — executeExplore scrolls a fixed SCROLL_LIMIT page. */
  protected override applyDefaults(ctx: ExploreContext): ExploreContext {
    return ctx;
  }

  protected async executeExplore(ctx: ExploreContext): Promise<ExploreResult[]> {
    const primaryFilter = this.buildSymbolFilter("symbolId");
    const parentFilter = this.buildSymbolFilter("parentSymbolId");

    const [symbolChunks, memberChunks] = await Promise.all([
      this.qdrant.scrollFiltered(ctx.collectionName, primaryFilter, SCROLL_LIMIT),
      this.qdrant.scrollFiltered(ctx.collectionName, parentFilter, SCROLL_LIMIT),
    ]);

    const seen = new Set(symbolChunks.map((c) => c.id));
    const allChunks = [...symbolChunks, ...memberChunks.filter((c) => !seen.has(c.id))];

    // Post-filter the scroll superset against the query:
    //   * FQN queries (with `#`, `.`, `::`) → keep chunks whose stored
    //     symbolId exactly matches the FQN, plus members of the FQN.
    //   * Short bare queries → keep chunks whose symbolId OR
    //     parentSymbolId last segment equals the query. Without this,
    //     the Qdrant tokenized superset leaks middle-of-name hits
    //     (`setValue` for `set`, `Baroque` for `bar`).
    // See class doc-comment for the tokenization + short-name rationale.
    const filtered = isFullyQualified(this.input.symbol)
      ? filterByExactSymbolId(allChunks, this.input.symbol)
      : filterByLastSegment(allChunks, this.input.symbol);

    return resolveSymbols(filtered, this.input.symbol, ctx.metaOnly) as ExploreResult[];
  }

  /**
   * Custom post-process — resolveSymbols already merges chunks into outline
   * results and strips payload.content on metaOnly. We keep that scaffolding
   * (chunkCount, mergedChunkIds, merged startLine/endLine) intact and only
   * adjust the git layer to match the semantic/hybrid contract:
   *
   *   metaOnly=true  → essential git keys + overlay signals (when reranked)
   *   metaOnly=false → full payload passes through unchanged
   *
   * Using BaseExploreStrategy.applyMetaOnly would strip synthetic outline
   * fields (not present in payloadSignals), so we apply a targeted git
   * filter via applyEssentialGitToResult instead.
   */
  protected override async postProcess(
    results: ExploreResult[],
    originalCtx: ExploreContext,
  ): Promise<ExploreResult[]> {
    let processed = results;

    const rerank = originalCtx.rerank as RerankMode<string> | undefined;
    if (rerank) {
      processed = await this.reranker.rerank(processed, rerank, "semantic_search");
    }

    const offset = originalCtx.offset ?? 0;
    if (offset > 0) processed = processed.slice(offset);

    const limit = originalCtx.limit ?? DEFAULT_USER_LIMIT;
    processed = processed.slice(0, limit);

    if (originalCtx.metaOnly) {
      processed = processed.map((r) => applyEssentialSignalsToOverlay(r, this.essentialKeys) as ExploreResult);
    }

    return processed;
  }

  private buildSymbolFilter(key: "symbolId" | "parentSymbolId"): Record<string, unknown> {
    // Reduce the query to a single reliable text token. Full FQNs tokenize
    // to multiple tokens that, under default `word` tokenizer + AND join,
    // miss target rows on some live indices. The last name segment is
    // always present in the indexed tokens of the target row.
    // See class doc-comment for the tokenization rationale.
    const textQuery = symbolTextToken(this.input.symbol);
    const must: Record<string, unknown>[] = [{ key, match: { text: textQuery } }];
    if (this.input.language) {
      must.push({ key: "language", match: { value: this.input.language } });
    }

    const filter: Record<string, unknown> = { must };
    if (!this.input.pathPattern) return filter;

    const extra = this.registry.buildMergedFilter(
      { pathPattern: this.input.pathPattern } as Record<string, unknown>,
      undefined,
      "chunk",
    );
    if (!extra) return filter;

    const extraMust = extra.must as Record<string, unknown>[] | undefined;
    if (extraMust) (filter.must as Record<string, unknown>[]).push(...extraMust);

    const extraMustNot = extra.must_not as Record<string, unknown>[] | undefined;
    if (extraMustNot) filter.must_not = extraMustNot;

    return filter;
  }
}

/**
 * Structural separators between class and member name in a symbolId.
 * `#` = instance method, `.` = static method, `::` = namespace.
 * See `.claude/rules/symbolid-convention.md`.
 */
const SYMBOL_SEPARATORS = /[#.]|::/;

/**
 * Suffix characters that mark Ruby setter / predicate / bang methods and
 * are always token separators under Qdrant's `word` tokenizer.
 */
const METHOD_NAME_SUFFIX = /[=?!]+$/;

/** Does the symbol contain a structural separator (FQN, not a bare name)? */
function isFullyQualified(symbol: string): boolean {
  return SYMBOL_SEPARATORS.test(symbol);
}

/**
 * Reduce a symbolId query to the single text token most likely to be
 * present in the Qdrant `symbolId` text-index for the target row.
 *
 *   `Foo::Bar#baz`       → `baz`
 *   `Foo.bar`            → `bar`
 *   `Foo#updated=`       → `updated`  (the `=` is stripped at token boundary)
 *   `Foo#valid?`         → `valid`
 *   `Foo#save!`          → `save`
 *   `createNote` (bare)  → `createNote`
 *
 * Bare names — no separator and no method-name suffix — are returned
 * unchanged so the existing short-name behaviour stays intact.
 */
function symbolTextToken(symbol: string): string {
  // Last name segment after any structural separator.
  const tail = symbol.split(SYMBOL_SEPARATORS).pop() ?? symbol;
  // Strip Ruby method-name suffixes (`=`, `?`, `!`) — token separators in
  // Qdrant's word tokenizer.
  return tail.replace(METHOD_NAME_SUFFIX, "");
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
    // depending on language. Accept both forms.
    if (parentSymbolId === fqn || parentSymbolId === containerName) return true;
    return false;
  });
}

/**
 * Last segment of a symbolId, preserving Ruby method-name suffixes
 * (`?`, `!`, `=`) that distinguish predicate / bang / setter methods.
 *
 *   `Foo::Bar#baz`   → `baz`
 *   `Foo#updated=`   → `updated=`
 *   `Foo#valid?`     → `valid?`
 *   `app.set`        → `set`
 *   `set` (bare)     → `set`
 *
 * Used by the short-name post-filter — the query and the stored
 * symbolId's tail must agree character-for-character (including
 * suffixes) for the chunk to survive.
 */
function lastSegment(symbol: string): string {
  return symbol.split(SYMBOL_SEPARATORS).pop() ?? symbol;
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
  const target = lastSegment(query);
  return chunks.filter((c) => {
    const symbolId = c.payload.symbolId as string | undefined;
    if (symbolId !== undefined && lastSegment(symbolId) === target) return true;
    const parentSymbolId = c.payload.parentSymbolId as string | undefined;
    if (parentSymbolId !== undefined && lastSegment(parentSymbolId) === target) return true;
    return false;
  });
}
