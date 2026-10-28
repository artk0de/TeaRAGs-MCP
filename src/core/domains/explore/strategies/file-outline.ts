/**
 * FileOutlineStrategy — outline a file by its relative path.
 *
 * Scrolls all chunks sharing the given relativePath and groups them into
 * a single file-level outline. Code files use CodeChunkGrouper; doc files
 * (markdown etc.) use DocChunkGrouper.
 *
 * Per-request strategy — takes input via constructor, mirroring
 * SimilarSearchStrategy.
 */

import { exactMatchOnTextIndexed } from "../../../adapters/qdrant/filters/text-indexed-exact.js";
import type {
  QdrantCollectionCatalog,
  QdrantPayloadIndexAdmin,
  QdrantPointReader,
  QdrantSearchReader,
} from "../../../adapters/qdrant/ports.js";
import type { SymbolVisibilityResolver } from "../../../contracts/types/codegraph.js";
import type { DirectoryOutline } from "../../../contracts/types/directory-outline.js";
import type { EmptyAnswerExplanation } from "../../../contracts/types/empty-answer.js";
import type { RerankMode } from "../../../contracts/types/reranker.js";
import type { PayloadSignalDescriptor } from "../../../contracts/types/trajectory.js";
import { CodeChunkGrouper, DirectoryChunkGrouper, DocChunkGrouper, type ScrollChunk } from "../chunk-grouping/index.js";
import { historyClockRerankOption } from "../history-clock.js";
import { renderWithDeclaredVisibility } from "../outline-visibility.js";
import type { RerankerPort } from "../reranker-port.js";
import type { UnindexedTreePath } from "../working-tree/overlay.js";
import { recordingTreeGraphReader } from "../working-tree/tree-graph-marker.js";
import { BaseExploreStrategy } from "./base.js";
import type { ExploreContext, ExploreResult } from "./types.js";

/**
 * Chunks read for one file. The filter is exact (one path), so the cap bounds a
 * pathological file instead of paging: a 200-chunk cap silently cut the outline
 * of every larger file (bd tea-rags-mcp-hditp). Same bound as the per-file
 * payload heal (`HEAL_PER_FILE_SCROLL_LIMIT`).
 */
const FILE_SCROLL_LIMIT = 10_000;

/** Chunks read for one directory answer or one nearest-path probe; the cap makes the listing `truncated`. */
const DIRECTORY_SCROLL_LIMIT = 20_000;

/** What a directory answer reads per chunk — never `content`. */
const DIRECTORY_PAYLOAD = [
  "relativePath",
  "symbolId",
  "parentSymbolId",
  "chunkType",
  "language",
  "startLine",
  "isDocumentation",
];

/** Alternatives an unknown path is answered with. */
const NEAREST_PATH_CAP = 5;

/** Files up to this many lines answer with their full text instead of an outline. */
const FULL_TEXT_MAX_LINES = 150;

export interface FileOutlineInput {
  relativePath: string;
  language?: string;
  /**
   * A STRICT full-text cap: a file over it answers its outline even when the
   * outline is longer than the file (find_symbol `symbols` batch, bd
   * tea-rags-mcp-yz10n). Absent → the `relativePath:` rule: up to
   * {@link FULL_TEXT_MAX_LINES} lines, or an outline at least as long as the file.
   */
  fullTextMaxLines?: number;
}

export class FileOutlineStrategy extends BaseExploreStrategy {
  readonly type = "outline" as unknown as "vector" | "hybrid" | "scroll-rank" | "similar";

  /** The outline is the working tree's: delta rows replace the base rows of a delta file. */
  protected override readonly hasChunkFloor = true;

  constructor(
    qdrant: QdrantSearchReader & QdrantPointReader & QdrantPayloadIndexAdmin & QdrantCollectionCatalog,
    reranker: RerankerPort,
    payloadSignals: PayloadSignalDescriptor[],
    essentialKeys: string[],
    private readonly input: FileOutlineInput,
    private readonly visibilityResolver?: SymbolVisibilityResolver,
  ) {
    super(qdrant, reranker, payloadSignals, essentialKeys);
  }

  /** The directory listed when `relativePath` named a directory of indexed files (N2); else undefined. */
  get directory(): DirectoryOutline | undefined {
    return this.directoryOutline;
  }

  /**
   * Why the answer is empty: `relativePath` named neither a file nor a directory
   * (N6 `unknownPath`), named a tree path ingest leaves out (`ignoredPath`), or a file too large for its full text holds no symbol
   * chunk to outline (`noSymbols`).
   */
  get emptyAnswer(): EmptyAnswerExplanation | undefined {
    return this.empty;
  }

  /** True when the `relativePath:` rule would have answered full text but `fullTextMaxLines` kept the outline. */
  get fullTextWithheld(): boolean {
    return this.withheldFullText;
  }

  private directoryOutline?: DirectoryOutline;
  private empty?: EmptyAnswerExplanation;
  private withheldFullText = false;
  /** The tree's text was read and withheld for its size (either full-text rule) — the outline is the whole answer. */
  private treeTextWithheld = false;

  /** No overfetch — a single scroll page is enough for one file's chunks. */
  protected override applyDefaults(ctx: ExploreContext): ExploreContext {
    return ctx;
  }

  protected async executeExplore(ctx: ExploreContext): Promise<ExploreResult[]> {
    // Exact match — NOT `match: { text }` alone (bd tea-rags-mcp-znxg8).
    // Qdrant's full-text predicate matches when the query's tokens are a SUBSET
    // of the field's, and `/`, `.` and `_` are all token boundaries — so
    // "app/services/workflow/tasks/update.rb" matched
    // "app/services/workflow/async_operations/notify/tasks/batch_update.rb".
    // The path mode addresses ONE file, so the `value` condition decides.
    //
    // It cannot be the whole filter either (bd tea-rags-mcp-ivp12): `relativePath`
    // has ONE index and it is `text`, which does not serve `match.value`, so a
    // lone value condition scanned the collection — 677–1002 ms per outline
    // request. Paired, the text half supplies candidates and the value half
    // makes the answer exact, at 1.7–2.0 ms. `globToTextFilter` draws the same
    // line for an unglobbed path (adapters/qdrant/filters/glob.ts).
    const must: Record<string, unknown>[] = [...exactMatchOnTextIndexed("relativePath", this.input.relativePath)];
    if (this.input.language) {
      must.push({ key: "language", match: { value: this.input.language } });
    }

    // Chunk floor (bd tea-rags-mcp-xi2r9.3): a changed file is outlined from the
    // tree, a deleted one comes back empty — never the index's stale version.
    const scrolled = await this.substituteFromWorkingTree(
      await this.qdrant.scrollFiltered(ctx.collectionName, { must }, FILE_SCROLL_LIMIT),
      ctx,
      (row) => this.matchesOutlineScroll(row),
    );

    // Second gate on the same invariant: `CodeChunkGrouper.groupFile` labels the
    // merged outline with the FIRST chunk's path, so a single foreign chunk
    // would silently retitle another file's outline as the requested one. Drop
    // anything that is not the requested path — exact or empty, never a
    // substitute the caller cannot detect.
    const chunks = scrolled.filter((c) => (c.payload.relativePath as string | undefined) === this.input.relativePath);
    if (chunks.length === 0) return this.outlineDirectory(ctx);

    const isDoc = chunks.some((c) => c.payload.isDocumentation);
    if (isDoc) return [DocChunkGrouper.group(chunks)];
    // Member lines carry declared visibility (bd tea-rags-mcp-sqqkz); metaOnly
    // strips the outline text, so there is nothing to decorate.
    const outline = await renderWithDeclaredVisibility(
      (visibilityOf) => CodeChunkGrouper.groupFile(chunks, visibilityOf),
      ctx.metaOnly ? undefined : this.visibilityResolver,
      ctx.collectionName,
      recordingTreeGraphReader(ctx.workingTreeView),
    );
    if (ctx.metaOnly) return [outline];
    const answer = await this.fullTextOrOutline(outline, ctx);
    if (this.treeTextWithheld && chunks.every((c) => c.payload.symbolId === undefined)) {
      // Top-level DSL/config (initializers, route files): the outline would be
      // the bare path line. find_symbol outlines code symbols; it does not read
      // configs (owner direction, bd tea-rags-mcp-hditp) — say so.
      this.empty = {
        reason: "noSymbols",
        message:
          `${this.input.relativePath} has no symbol chunks (top-level DSL/config) — ` +
          "read it with the default code read tool.",
      };
      return [];
    }
    return [answer];
  }

  /**
   * A small file answers with its own text (bd tea-rags-mcp-03yel): at most
   * {@link FULL_TEXT_MAX_LINES} lines, or an outline at least as long as the
   * file, costs the caller a second turn reading the file anyway. The text is
   * the tree's, read whole — chunks overlap and member chunks carry container
   * headers, so no concatenation of them is the file. A file the view serves
   * from the index (`treeState: "modified"`) or cannot read keeps the outline.
   * `fullTextMaxLines` then tightens the rule to a strict line cap.
   */
  private async fullTextOrOutline(outline: ExploreResult, ctx: ExploreContext): Promise<ExploreResult> {
    const view = ctx.workingTreeView;
    const path = this.input.relativePath;
    if (!view?.readTreeFile || view.indexServedPaths?.has(path)) return outline;
    const text = await view.readTreeFile(path);
    if (text === undefined) return outline;
    const lineCount = countLines(text);
    const outlineText = typeof outline.payload?.content === "string" ? outline.payload.content : "";
    if (lineCount > FULL_TEXT_MAX_LINES && outlineText.length < text.length) {
      this.treeTextWithheld = true;
      return outline;
    }
    const cap = this.input.fullTextMaxLines;
    if (cap !== undefined && lineCount > cap) {
      this.withheldFullText = true;
      this.treeTextWithheld = true;
      return outline;
    }
    return {
      ...outline,
      payload: { ...outline.payload, kind: "file", content: text, startLine: 1, endLine: lineCount },
    };
  }

  /**
   * The exact path named no file: one level of the directory it names (N2), or
   * — when no indexed file lies under it either — an empty answer naming the
   * nearest indexed paths. Both read the index through the chunk floor, so an
   * added file is listed, a deleted one never.
   */
  private async outlineDirectory(ctx: ExploreContext): Promise<ExploreResult[]> {
    const dir = this.input.relativePath.replace(/\/+$/, "");
    const under = dir === "" ? { rows: [], capped: false } : await this.scrollUnder(ctx, dir);
    const grouping = DirectoryChunkGrouper.group(dir, under.rows);
    if (grouping) {
      this.directoryOutline = under.capped ? { ...grouping.outline, truncated: true } : grouping.outline;
      return grouping.files;
    }
    const unindexed = await ctx.workingTreeView?.unindexedTreePath?.(dir);
    if (unindexed) {
      this.empty = { reason: "ignoredPath", message: ignoredPathMessage(dir, unindexed) };
      return [];
    }
    this.empty = {
      reason: "unknownPath",
      message: `No indexed file or directory at "${this.input.relativePath}".`,
      suggestions: await this.nearestPaths(ctx, dir),
    };
    return [];
  }

  /** The chunks of every file under `dir` (no content), the tree's rows substituted; `capped` when the scroll hit its cap. */
  private async scrollUnder(ctx: ExploreContext, dir: string): Promise<{ rows: ScrollChunk[]; capped: boolean }> {
    const prefix = `${dir}/`;
    return this.scrollPaths(ctx, dir, (path) => path.startsWith(prefix));
  }

  /**
   * One superset scroll on the `relativePath` text index — every file whose
   * path carries all of `text`'s tokens — narrowed to `keep` and substituted
   * from the working tree.
   */
  private async scrollPaths(
    ctx: ExploreContext,
    text: string,
    keep: (path: string) => boolean,
  ): Promise<{ rows: ScrollChunk[]; capped: boolean }> {
    const must: Record<string, unknown>[] = [{ key: "relativePath", match: { text } }];
    if (this.input.language) must.push({ key: "language", match: { value: this.input.language } });
    const scrolled = await this.qdrant.scrollFiltered(
      ctx.collectionName,
      { must },
      DIRECTORY_SCROLL_LIMIT,
      undefined,
      DIRECTORY_PAYLOAD,
    );
    const matches = (row: ScrollChunk): boolean => {
      const path = row.payload.relativePath;
      return typeof path === "string" && keep(path) && this.matchesLanguage(row);
    };
    const substituted = await this.substituteFromWorkingTree(scrolled.filter(matches), ctx, matches);
    return { rows: substituted.filter(matches), capped: scrolled.length >= DIRECTORY_SCROLL_LIMIT };
  }

  /**
   * The paths whose `relativePath` carries `text`'s tokens and passes `keep`,
   * as the tree has them: the index's paths minus the files the tree deleted,
   * plus the files its rows hold. Only paths reach the answer — no row of the
   * tree does — so no floor is claimed.
   */
  private async treePaths(ctx: ExploreContext, text: string, keep: (path: string) => boolean): Promise<string[]> {
    const must: Record<string, unknown>[] = [{ key: "relativePath", match: { text } }];
    if (this.input.language) must.push({ key: "language", match: { value: this.input.language } });
    const scrolled = await this.qdrant.scrollFiltered(ctx.collectionName, { must }, DIRECTORY_SCROLL_LIMIT, undefined, [
      "relativePath",
      "language",
    ]);
    const view = ctx.workingTreeView;
    const tree = view?.readDeltaChunks && view.touchedPaths.size > 0 ? await view.readDeltaChunks() : [];
    const paths = distinctPaths([...scrolled, ...tree.filter((row) => this.matchesLanguage(row))]);
    return paths.filter((path) => keep(path) && !view?.deletedPaths.has(path));
  }

  private matchesLanguage(row: ScrollChunk): boolean {
    return !this.input.language || row.payload.language === this.input.language;
  }

  /**
   * At most five indexed paths near an unknown one: files with its basename
   * first, closest by shared leading directories, then the files under its
   * nearest ancestor that holds any.
   */
  private async nearestPaths(ctx: ExploreContext, path: string): Promise<string[]> {
    const segments = path.split("/").filter(Boolean);
    const basename = segments.at(-1);
    if (basename === undefined) return [];
    const nearest = new Set<string>();
    const sameName = await this.treePaths(ctx, basename, (p) => p === basename || p.endsWith(`/${basename}`));
    const shared = (p: string): number => {
      const other = p.split("/");
      let n = 0;
      while (n < other.length && n < segments.length && other[n] === segments[n]) n++;
      return n;
    };
    for (const p of sameName.sort((a, b) => shared(b) - shared(a) || a.localeCompare(b))) {
      nearest.add(p);
    }
    for (let depth = segments.length - 1; depth > 0 && nearest.size < NEAREST_PATH_CAP; depth--) {
      const ancestor = `${segments.slice(0, depth).join("/")}/`;
      const under = await this.treePaths(ctx, ancestor, (p) => p.startsWith(ancestor));
      if (under.length === 0) continue;
      for (const p of under.sort()) nearest.add(p);
      break;
    }
    return [...nearest].slice(0, NEAREST_PATH_CAP);
  }

  /** The scroll filter above as a predicate over a row Qdrant never stored: exact path, same language. */
  private matchesOutlineScroll(row: ScrollChunk): boolean {
    if (row.payload.relativePath !== this.input.relativePath) return false;
    return this.matchesLanguage(row);
  }

  /**
   * Custom post-process: metaOnly strips payload.content only (not the
   * BaseExploreStrategy.applyMetaOnly signal-filtered shape, which would
   * erase the outline structure).
   */
  protected override async postProcess(
    results: ExploreResult[],
    originalCtx: ExploreContext,
  ): Promise<ExploreResult[]> {
    // A directory row is a listing, not a chunk, and ranks nothing. The tree's
    // rows of changed files reach here signalled (base `execute`); their
    // trajectory blocks are no part of the listing.
    if (this.directoryOutline) {
      return results.map((r) => ({ ...r, payload: pickListingFields(r.payload) }));
    }

    // metaOnly keeps `content`: a file row's content is its OUTLINE, which is
    // the metadata metaOnly asks for (bd tea-rags-mcp-hditp) — `executeExplore`
    // already declined the full text.
    let processed = results;

    const rerank = originalCtx.rerank as RerankMode<string> | undefined;
    if (rerank) {
      const clock = historyClockRerankOption(originalCtx);
      processed =
        clock.now === undefined
          ? await this.reranker.rerank(processed, rerank, "semantic_search")
          : await this.reranker.rerank(processed, rerank, "semantic_search", clock);
    }

    return processed;
  }
}

/** The `ignoredPath` sentence (bd tea-rags-mcp-d9w4o): what the tree has, why it is unindexed, which tool reads it. */
function ignoredPathMessage(path: string, unindexed: UnindexedTreePath): string {
  const why = unindexed.ignoreRule === undefined ? "" : ` (ignore pattern "${unindexed.ignoreRule}")`;
  return unindexed.isDirectory
    ? `directory "${path}" exists in the working tree but is not indexed${why} — ` +
        "list and read it with the default code search / read tools."
    : `"${path}" exists in the working tree but is not indexed${why} — read it with the default code read tool.`;
}

function pickListingFields(payload: Record<string, unknown> | undefined): Record<string, unknown> {
  const { relativePath, language, symbols } = payload ?? {};
  return { relativePath, language, symbols };
}

/** Lines of `text`; a trailing newline ends the last line rather than opening one. */
function countLines(text: string): number {
  if (text === "") return 0;
  const breaks = text.split("\n").length - 1;
  return text.endsWith("\n") ? breaks : breaks + 1;
}

function distinctPaths(rows: readonly ScrollChunk[]): string[] {
  return [...new Set(rows.map((c) => c.payload.relativePath).filter((p): p is string => typeof p === "string"))];
}
