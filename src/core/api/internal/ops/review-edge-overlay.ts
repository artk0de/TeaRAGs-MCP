/**
 * Working-tree file edges for one diff-scoped review — slice A of F1
 * (bd tea-rags-mcp-89k7k.1.2): `readReviewFileEdges` walks ONE changed file's
 * text with the same in-memory extraction the index runs
 * (`extractFileInMemory` over the naming-review trio), resolves its imports to
 * project files through the language facade's `resolveFileEdges`, and gates
 * every target on WORKING-TREE existence — the review judges the tree as it
 * stands, so a file the index holds but the tree lost is never a target.
 * `ReviewEdgeOverlay` is the pure per-review view over those reads: the diff's
 * files masked out of the indexed graph, plus this review's own edges.
 *
 * Which languages resolve edges here: TypeScript alone in slice A — its
 * import→file mapper (`ts-path-mapper`, reached through the facade the
 * injected factory returns, bound to the working tree via `ctx.projectRoot`)
 * probes the working tree (tsconfig + project file probe), so it needs nothing
 * the index holds. Every other codegraph language's mapper answers from the
 * indexed `GlobalSymbolTable` (`hasFile` membership) or from run-global pass-2
 * state a review cannot provide without DuckDB, so those report
 * `unsupportedLanguage` — upstream renders them as notJudged, never edge-free.
 * Slice B (parent-supervised) adds the per-review temp-table persistence and
 * the indexed-edge masking reads F2's detectors consume; nothing in this file
 * touches DuckDB or any state outside its arguments.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { ReviewFileEdge } from "../../../contracts/types/codegraph-storage.js";
import type { CallContext, FileExtraction, GlobalSymbolTable, GraphEdges } from "../../../contracts/types/codegraph.js";
import type {
  CollectSymbolsFn,
  LanguageFactoryDescriptor,
  SymbolIdComposer,
} from "../../../contracts/types/language.js";
import { extractFileInMemory, type InMemoryExtractionContext } from "../../../domains/trajectory/codegraph/index.js";
import { collectDependencyManifestSources, readDeclaredDependencies } from "../../../infra/dependency-manifests.js";

/**
 * One working-tree file edge: the changed file imports/knows the target file.
 * Declared in `contracts/types/codegraph-storage` (bd tea-rags-mcp-89k7k.1.2) —
 * the edges' DuckDB persistence is adapter code, and adapters may not import
 * api — and re-exported here so this module's public surface is unchanged.
 */
export type { ReviewFileEdge };

/** Why a changed file yielded no edges (upstream renders it as notJudged, never edge-free). */
export type ReviewEdgeSkipReason = "noCodegraphLanguage" | "unreadable" | "unsupportedLanguage" | "parseFailed";

export interface ReviewFileEdgeRead {
  relPath: string;
  language?: string;
  edges: readonly ReviewFileEdge[];
  skip?: { reason: ReviewEdgeSkipReason; detail?: string };
}

/**
 * The languages whose import→file resolution answers from the WORKING TREE
 * alone. TypeScript today: its path mapper probes disk (tsconfig `paths` +
 * the project file probe) through the resolver the facade binds to
 * `ctx.projectRoot`. The other codegraph languages' mappers are index-backed
 * (`GlobalSymbolTable.hasFile`, or run-global pass-2 state), so a review that
 * cannot hydrate the index must not call them — a half-empty table would read
 * as "the project holds nothing" and silently drop real edges. Slice B lifts
 * a language by hydrating what its mapper reads, then adding it here.
 */
const DISK_RESOLVING_REVIEW_LANGUAGES: ReadonlySet<string> = new Set(["typescript"]);

/**
 * The empty `GlobalSymbolTable` a review's `CallContext` carries. The context
 * type requires a table, but slice A resolves only languages whose
 * `resolveFileEdges` never reads one (TypeScript's ignores the context beyond
 * `projectRoot`); every language whose mapper WOULD consult the table is
 * gated to `unsupportedLanguage` first, so these empty answers can never be
 * mistaken for "the project holds nothing". Same rationale as the daemon's
 * `NoopGlobalSymbolTable`, kept local because that copy lives behind the
 * adapter's daemon seam.
 */
const EMPTY_REVIEW_SYMBOL_TABLE: GlobalSymbolTable = Object.freeze({
  upsertFile: () => undefined,
  removeFile: () => undefined,
  lookup: () => [],
  lookupByShortName: () => [],
  hasFile: () => false,
  hasFilesUnder: () => false,
  size: () => 0,
  hydrate: () => undefined,
  shortNameDefCounts: () => new Map<string, number>(),
});

/** Extracts one working-tree file's import edges. deps = the naming-review-extraction trio. */
export interface ReviewEdgeExtractionDeps {
  languageFactory: LanguageFactoryDescriptor;
  collectSymbols: CollectSymbolsFn;
  composer: SymbolIdComposer;
}

/**
 * Reads one file's import edges from the working tree. Never throws: a file
 * that cannot be read, walked or resolved lands in `skip`, so one bad file
 * never kills the review batch. `context` is the run-level context the index
 * path hands every walk — build it once per review with
 * {@link workingTreeExtractionContext} and pass it to every file.
 */
export async function readReviewFileEdges(
  deps: ReviewEdgeExtractionDeps,
  workTree: string,
  relPath: string,
  context: InMemoryExtractionContext = {},
): Promise<ReviewFileEdgeRead> {
  let text: string;
  try {
    text = readFileSync(join(workTree, relPath), "utf8");
  } catch (error) {
    return { relPath, edges: [], skip: { reason: "unreadable", detail: messageOf(error) } };
  }

  let extraction: FileExtraction | null;
  try {
    extraction = extractFileInMemory(deps, relPath, text, context);
  } catch (error) {
    // A thrown walk (a missing grammar package, an extractor bug): one file's
    // parse failure, carried as detail. Tree-sitter's error tolerance means a
    // merely syntax-broken file does NOT land here — it extracts.
    return { relPath, edges: [], skip: { reason: "parseFailed", detail: messageOf(error) } };
  }
  if (extraction === null) {
    return { relPath, edges: [], skip: { reason: "noCodegraphLanguage" } };
  }
  if (!DISK_RESOLVING_REVIEW_LANGUAGES.has(extraction.language)) {
    return {
      relPath,
      language: extraction.language,
      edges: [],
      skip: {
        reason: "unsupportedLanguage",
        detail: `import→file mapping for ${extraction.language} answers from the indexed symbol table; working-tree resolution arrives with slice B (bd tea-rags-mcp-89k7k.1.2)`,
      },
    };
  }

  const { resolver } = deps.languageFactory.create(extraction.language);
  if (resolver?.resolveFileEdges === undefined) {
    return {
      relPath,
      language: extraction.language,
      edges: [],
      skip: {
        reason: "unsupportedLanguage",
        detail: `the ${extraction.language} facade forwards no resolveFileEdges`,
      },
    };
  }
  const ctx: CallContext = {
    callerFile: relPath,
    callerScope: [],
    imports: extraction.imports,
    symbolTable: EMPTY_REVIEW_SYMBOL_TABLE,
    projectRoot: workTree,
  };
  const fileEdges = resolver.resolveFileEdges(extraction, ctx, []);
  return { relPath, language: extraction.language, edges: reviewEdgesOfFile(relPath, fileEdges, workTree) };
}

/**
 * The run-level context every walk of one review shares — the working tree's
 * `Gemfile` and the dependencies its manifests declare, the same wiring
 * `naming-review-extraction.ts` gives its walks (kept local here because that
 * module's copy is closure-private). Read once per review, then handed to
 * every {@link readReviewFileEdges} call.
 */
export function workingTreeExtractionContext(
  workTree: string,
  languageFactory: LanguageFactoryDescriptor,
): InMemoryExtractionContext {
  let gemfileContent: string | undefined;
  try {
    gemfileContent = readFileSync(join(workTree, "Gemfile"), "utf8");
  } catch {
    gemfileContent = undefined;
  }
  const declaredDependencies = readDeclaredDependencies(workTree, collectDependencyManifestSources(languageFactory));
  return {
    ...(gemfileContent !== undefined ? { gemfileContent } : {}),
    ...(declaredDependencies !== undefined ? { declaredDependencies } : {}),
  };
}

/**
 * `GraphEdges.fileEdges` → deduped `ReviewFileEdge[]` of one file: self-edges
 * dropped (the review judges a file's COUPLING, not its self-reference),
 * targets the working tree no longer holds dropped (the mapper's unverified
 * extension fallback must not name a deleted file), duplicates collapsed —
 * `./b` and `./b.js` from one file are one dependency. Only the RUNTIME
 * `fileEdges` channel is read: F2's detectors judge the same table
 * `cg_symbols_edges_file` persists, so type-only imports stay out.
 */
function reviewEdgesOfFile(
  relPath: string,
  fileEdges: readonly GraphEdges["fileEdges"][number][],
  workTree: string,
): readonly ReviewFileEdge[] {
  const seen = new Set<string>();
  const edges: ReviewFileEdge[] = [];
  for (const edge of fileEdges) {
    if (edge.targetRelPath === relPath) continue;
    if (!existsSync(join(workTree, edge.targetRelPath))) continue;
    if (seen.has(edge.targetRelPath)) continue;
    seen.add(edge.targetRelPath);
    edges.push({ sourceRelPath: relPath, targetRelPath: edge.targetRelPath });
  }
  return Object.freeze(edges);
}

/**
 * Per-review view over file edges: the diff's files MASKED out of the indexed
 * graph, plus this review's own working-tree edges. F2 detectors read indexed
 * edges THROUGH it (slice B wires the DuckDB side of that read — the
 * temp-table persistence and the masked union); nothing here touches global
 * state, and the view is immutable after construction.
 */
export class ReviewEdgeOverlay {
  private readonly edgesBySource: ReadonlyMap<string, readonly ReviewFileEdge[]>;
  private readonly maskedPaths: ReadonlySet<string>;
  private readonly unsupportedReads: readonly {
    relPath: string;
    reason: ReviewEdgeSkipReason;
    detail?: string;
  }[];

  constructor(reads: readonly ReviewFileEdgeRead[]) {
    const edgesBySource = new Map<string, readonly ReviewFileEdge[]>();
    const unsupported: { relPath: string; reason: ReviewEdgeSkipReason; detail?: string }[] = [];
    for (const read of reads) {
      // A diff lists a file once; a repeated relPath keeps the LATER read —
      // the fresher working-tree state.
      edgesBySource.set(read.relPath, Object.freeze([...read.edges]));
      if (read.skip !== undefined) {
        unsupported.push(Object.freeze({ relPath: read.relPath, ...read.skip }));
      }
    }
    this.edgesBySource = edgesBySource;
    this.maskedPaths = new Set(reads.map((read) => read.relPath));
    this.unsupportedReads = Object.freeze(unsupported);
  }

  /** Every read relPath — the files whose indexed edges the review replaces, whatever the read found. */
  get masked(): ReadonlySet<string> {
    return this.maskedPaths;
  }

  /** The working-tree edges of one file: `[]` for a masked file with no edges, and for any file outside the read. */
  edgesFrom(relPath: string): readonly ReviewFileEdge[] {
    return this.edgesBySource.get(relPath) ?? EMPTY_EDGES;
  }

  /** The skipped reads — the notJudged files upstream must report, never treat as edge-free. */
  unsupported(): readonly { relPath: string; reason: ReviewEdgeSkipReason; detail?: string }[] {
    return this.unsupportedReads;
  }
}

const EMPTY_EDGES: readonly ReviewFileEdge[] = Object.freeze([]);

/** An unknown thrown value's message, for a skip detail. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
