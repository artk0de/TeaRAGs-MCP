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

import { isCodegraphUnavailableError, type CodegraphUnavailableError } from "../../../adapters/duckdb/errors.js";
import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import {
  matchesTextIndexed,
  SYMBOL_SEPARATORS,
  symbolIdLastSegment,
  symbolIdTextToken,
} from "../../../adapters/qdrant/filters/symbolid-text-token.js";
import { exactMatchOnTextIndexed } from "../../../adapters/qdrant/filters/text-indexed-exact.js";
import type {
  SymbolChunkLocation,
  SymbolChunkResolver,
  SymbolVisibilityResolver,
} from "../../../contracts/types/codegraph.js";
import type { PayloadSignalDescriptor, TrajectoryFilterBuilder } from "../../../contracts/types/trajectory.js";
import { compilePathPatternMatcher } from "../../../infra/path-pattern.js";
import { isTestExampleChunk } from "../chunk-grouping/code.js";
import type { ScrollChunk } from "../chunk-grouping/types.js";
import { renderWithDeclaredVisibility } from "../outline-visibility.js";
import { applyEssentialSignals } from "../post-process.js";
import type { Reranker, RerankMode } from "../reranker.js";
import { memberOwnerOf, splitFragmentBase } from "../split-fragment.js";
import { resolveSymbols } from "../symbol-resolve.js";
import { examplePackMember } from "../test-pack.js";
import { BaseExploreStrategy } from "./base.js";
import { keepPathPatternMatches } from "./path-pattern-fill.js";
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

  /** find_symbol answers for the working tree: delta rows replace base rows of delta files. */
  protected override readonly hasChunkFloor = true;

  constructor(
    qdrant: QdrantManager,
    reranker: Reranker,
    payloadSignals: PayloadSignalDescriptor[],
    essentialKeys: string[],
    private readonly registry: TrajectoryFilterBuilder,
    private readonly input: SymbolSearchInput,
    private readonly chunkResolver?: SymbolChunkResolver,
    private readonly visibilityResolver?: SymbolVisibilityResolver,
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
    const exact = isFullyQualified(this.input.symbol)
      ? filterByExactSymbolId(allChunks, this.input.symbol)
      : filterByLastSegment(allChunks, this.input.symbol);
    // A tiny test example shares a chunk with its tiny siblings, and a test
    // scope's setup a chunk with its neighbours' setup; either is named only in
    // that chunk's `memberSymbolIds` (bd tea-rags-mcp-5xpq4) — asked only when
    // no chunk answered the id as its own (a scope id is still answered by its
    // examples' parentSymbolId, which outlines them but is not its setup).
    const grouped =
      isFullyQualified(this.input.symbol) && !answersOwnId(exact, this.input.symbol)
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
    const filtered = isFullyQualified(this.input.symbol)
      ? matched.map((chunk) => answerPackMember(chunk, this.input.symbol))
      : matched;

    // Outline member lines carry declared visibility (bd tea-rags-mcp-sqqkz);
    // metaOnly strips the outline text, so there is nothing to decorate.
    const resolved = (await renderWithDeclaredVisibility(
      (visibilityOf) => resolveSymbols(filtered, this.input.symbol, ctx.metaOnly, visibilityOf),
      ctx.metaOnly ? undefined : this.visibilityResolver,
      ctx.collectionName,
    )) as ExploreResult[];
    if (resolved.length > 0) return resolved;

    // 0rskm — Qdrant scroll found no chunk for this symbolId. If codegraph is
    // wired, the symbol may be collapsed into a covering class chunk that has a
    // different symbolId. Two-hop: symbol_id → chunk_id → getPoint → result.
    // The codegraph hop reads the index only: a covering chunk of a file the
    // tree changed would answer with the index's version of it.
    const covering = this.dropWorkingTreeTouched(await this.resolveViaCodegraph(ctx), ctx);
    return pathMatcher ? keepPathPatternMatches(covering, pathMatcher) : covering;
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

  private async resolveViaCodegraph(ctx: ExploreContext): Promise<ExploreResult[]> {
    if (!this.chunkResolver) return [];
    const location = await this.resolveCoveringChunk(this.chunkResolver, ctx.collectionName);
    if (!location) return [];
    const point = await this.qdrant.getPoint(ctx.collectionName, location.chunkId);
    if (!point) return [];
    const payload = point.payload ? { ...point.payload } : {};
    if (ctx.metaOnly) delete (payload as { content?: unknown }).content;
    return [
      {
        id: point.id,
        score: 1,
        payload,
      },
    ];
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
  ): Promise<SymbolChunkLocation | null> {
    try {
      return await resolver.resolveSymbolChunk(collectionName, this.input.symbol);
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
      processed = await this.reranker.rerank(processed, rerank, "semantic_search");
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
    return this.hydrateTestSetup(processed, originalCtx);
  }

  /**
   * The two scrolls' filters ({@link buildSymbolFilter}) as one predicate over a
   * row Qdrant never stored — the working tree's delta rows. Same text token,
   * same language condition; the pathPattern half is the text pre-filter the
   * exact matcher in `executeExplore` re-applies to every row anyway.
   */
  private matchesSymbolScrolls(row: ScrollChunk): boolean {
    const textQuery = symbolIdTextToken(this.input.symbol);
    const { symbolId, parentSymbolId } = row.payload;
    const textMatch = matchesTextIndexed(symbolId, textQuery) || matchesTextIndexed(parentSymbolId, textQuery);
    return textMatch && this.matchesLanguage(row);
  }

  private matchesLanguage(row: ScrollChunk): boolean {
    return !this.input.language || row.payload.language === this.input.language;
  }

  private buildSymbolFilter(key: "symbolId" | "parentSymbolId"): Record<string, unknown> {
    // Reduce the query to a single reliable text token. Full FQNs tokenize
    // to multiple tokens that, under default `word` tokenizer + AND join,
    // miss target rows on some live indices. The last name segment is
    // always present in the indexed tokens of the target row.
    // See class doc-comment for the tokenization rationale.
    const textQuery = symbolIdTextToken(this.input.symbol);
    const must: Record<string, unknown>[] = [{ key, match: { text: textQuery } }];
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
    // depending on language. Accept both forms.
    if (parentSymbolId === fqn || parentSymbolId === containerName) return true;
    // A `#partN` window of an oversized test example names the EXAMPLE as its
    // parent, not the scope; it stands for an example of the queried scope
    // when its base id extends the scope id (bd tea-rags-mcp-msv3l). An example
    // name is free text, so its scope is read by prefix, never by
    // `memberOwnerOf`'s last-separator split.
    if (isTestExampleChunk(c)) return splitFragmentBase(c.payload)?.startsWith(`${fqn}.`) === true;
    // A member split into `#partN` parts names the member as its parent; the
    // container is the member id's owner (bd tea-rags-mcp-y5vx4).
    const owner = splitPartOwner(c.payload);
    return owner !== undefined && (owner === fqn || owner === containerName);
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
