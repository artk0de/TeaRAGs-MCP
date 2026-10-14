/**
 * Working-tree file edges for one diff-scoped review — slice A of F1
 * (bd tea-rags-mcp-89k7k.1.2): `readWorkingTreeFileEdges` walks ONE changed
 * file's text with the same in-memory extraction the index runs
 * (`extractFileInMemory` over the naming-review trio), resolves its imports to
 * project files through the language facade's `resolveFileEdges`, and gates
 * every target on WORKING-TREE existence — the review judges the tree as it
 * stands, so a file the index holds but the tree lost is never a target.
 * This module is one PRODUCER of `ReviewEdgeOverlay` reads; the overlay value
 * itself — the diff's files masked out of the indexed graph, plus this
 * review's own edges — is pure domain logic and lives in the codegraph domain
 * (`domains/trajectory/codegraph/symbols/edge-overlay`, bd
 * tea-rags-mcp-89k7k.35.19).
 *
 * Which languages resolve edges here: every language whose facade forwards
 * `resolveFileEdges` (bd tea-rags-mcp-vdhjc). A resolver that answers from
 * the symbol table (import mappers gating on `hasFile`, Ruby's Zeitwerk and
 * ancestor constants) reads the review's table — the index's rows hydrated and
 * the working tree overlaid (`review-symbol-table.ts`), handed in through
 * {@link ReviewEdgeReadContext}. When no table could be hydrated, the context
 * carries a table that THROWS on every read: a resolver that never reads it
 * (TypeScript probes disk) still resolves, one that does lands in
 * `indexedSymbolsUnavailable` with the cause — never read as "the project
 * holds nothing". Likewise a resolver deriving file edges from its resolved
 * calls reads method edges a review does not resolve, and lands in
 * `resolvedCallsUnavailable`. Nothing here decides membership by language
 * name: what the resolver reads decides it.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  collectDependencyManifestSources,
  readDeclaredDependenciesByLanguage,
} from "../../../adapters/filesystem/dependency-manifests.js";
import type { ReviewFileEdge } from "../../../contracts/types/codegraph-storage.js";
import type { CallContext, FileExtraction, GlobalSymbolTable, GraphEdges } from "../../../contracts/types/codegraph.js";
import type {
  CollectSymbolsFn,
  LanguageFactoryDescriptor,
  SymbolIdComposer,
} from "../../../contracts/types/language.js";
import { extractFileInMemory, type InMemoryExtractionContext } from "../../../domains/trajectory/codegraph/index.js";
import {
  runtimeImportExtraction,
  typeOnlyImportExtraction,
  type ReviewFileEdgeRead,
} from "../../../domains/trajectory/codegraph/symbols/index.js";

/**
 * One working-tree file edge: the changed file imports/knows the target file.
 * Declared in `contracts/types/codegraph-storage` (bd tea-rags-mcp-89k7k.1.2) —
 * the edges' DuckDB persistence is adapter code, and adapters may not import
 * api — and re-exported here so this module's public surface is unchanged.
 */
export type { ReviewFileEdge };

/**
 * What a review hands every file read: the extraction context the index's
 * walks get, plus the review's symbol table — hydrated from the index and
 * overlaid with the working tree, or why it could not be. Absent table = not
 * hydrated: the table-reading resolvers skip, never resolve against nothing.
 */
export interface ReviewEdgeReadContext extends InMemoryExtractionContext {
  symbolTable?: ReviewSymbolTableRead;
}

/** The review's hydrated table, or the reason none could be built. */
export type ReviewSymbolTableRead = { readonly table: GlobalSymbolTable } | { readonly unavailable: string };

/** Thrown by {@link unavailableSymbolTable} on a read; caught by the file read and turned into a skip. */
class ReviewSymbolTableUnavailableError extends Error {}

/** Thrown when a resolver reads the resolved method edges a review does not compute. */
class ReviewResolvedCallsUnavailableError extends Error {}

/**
 * A table that answers no question: every read throws, carrying why the index
 * rows are missing. Lets the resolver itself say whether it needs the table —
 * one that never reads it (a disk-probing mapper) resolves as before.
 */
function unavailableSymbolTable(reason: string): GlobalSymbolTable {
  const refuse = (): never => {
    throw new ReviewSymbolTableUnavailableError(reason);
  };
  return Object.freeze({
    upsertFile: refuse,
    removeFile: refuse,
    lookup: refuse,
    lookupByShortName: refuse,
    hasFile: refuse,
    hasFilesUnder: refuse,
    size: refuse,
    hydrate: refuse,
    shortNameDefCounts: refuse,
    listFiles: refuse,
  });
}

/**
 * The resolved method edges a review hands `resolveFileEdges`: none were
 * resolved (a review resolves no call sites), so any read throws rather than
 * answering "this file's calls land nowhere" — a language deriving its file
 * graph from calls would otherwise report the file edge-free and mask its
 * indexed edges as removed.
 */
const UNRESOLVED_METHOD_EDGES: GraphEdges["methodEdges"] = new Proxy([], {
  get: () => {
    throw new ReviewResolvedCallsUnavailableError("a review resolves no call sites");
  },
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
 * path hands every walk plus the review's symbol table — build it once per
 * review and pass it to every file.
 */
export async function readWorkingTreeFileEdges(
  deps: ReviewEdgeExtractionDeps,
  workTree: string,
  relPath: string,
  context: ReviewEdgeReadContext = {},
): Promise<ReviewFileEdgeRead> {
  const extracted = extractWorkingTreeFile(deps, workTree, relPath, context);
  return isWalkedReviewFile(extracted) ? resolveReviewFileEdges(deps, workTree, extracted, context) : extracted;
}

/**
 * One working-tree file walked by the index's in-memory extraction, or the
 * skip read naming why it could not be — the first half of
 * {@link readWorkingTreeFileEdges}, split out so a review can overlay every
 * walked file's definitions on its table before resolving any of them.
 */
export function extractWorkingTreeFile(
  deps: ReviewEdgeExtractionDeps,
  workTree: string,
  relPath: string,
  context: InMemoryExtractionContext = {},
): FileExtraction | ReviewFileEdgeRead {
  let text: string;
  try {
    text = readFileSync(join(workTree, relPath), "utf8");
  } catch (error) {
    return { relPath, edges: [], skip: { reason: "unreadable", detail: messageOf(error) } };
  }
  return extractReviewFile(deps, relPath, text, context);
}

/**
 * {@link readWorkingTreeFileEdges} over text the caller already holds — the same
 * walk and resolution, so a revision's blob (the diff base's, bd
 * tea-rags-mcp-89k7k.1.16) extracts exactly as the working-tree file does.
 * Resolution answers from `workTree`'s filesystem and from the context's
 * table: an import is mapped to the file the TREE holds at that path, which is
 * what "the same edge at the base" needs — a pair compared against the tree's
 * own overlay. Never throws.
 */
export function extractReviewFileEdges(
  deps: ReviewEdgeExtractionDeps,
  workTree: string,
  relPath: string,
  text: string,
  context: ReviewEdgeReadContext = {},
): ReviewFileEdgeRead {
  const extracted = extractReviewFile(deps, relPath, text, context);
  return isWalkedReviewFile(extracted) ? resolveReviewFileEdges(deps, workTree, extracted, context) : extracted;
}

/**
 * The paths the change deleted: every touched path the working tree no longer
 * holds — a deletion, or the old side of a move.
 */
export function deletedReviewPaths(workTree: string, touchedFiles: Iterable<string>): readonly string[] {
  return [...touchedFiles].filter((relPath) => !existsSync(join(workTree, relPath)));
}

/** Whether {@link extractWorkingTreeFile} walked the file (an extraction), not a skip read. */
export function isWalkedReviewFile(read: FileExtraction | ReviewFileEdgeRead): read is FileExtraction {
  return !("edges" in read);
}

/**
 * One text walked, or why not — walk only, nothing resolved, so the text may
 * be a revision's blob named by any path (the diff base's second read hands a
 * touched target's base blob under its tree path, bd tea-rags-mcp-slsia).
 */
export function extractReviewFile(
  deps: ReviewEdgeExtractionDeps,
  relPath: string,
  text: string,
  context: InMemoryExtractionContext,
): FileExtraction | ReviewFileEdgeRead {
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
  return extraction;
}

/**
 * One walked file's edges through its language facade's `resolveFileEdges`,
 * against the context's table. Never throws: a resolver reading what the
 * review could not supply lands in the matching skip.
 */
export function resolveReviewFileEdges(
  deps: ReviewEdgeExtractionDeps,
  workTree: string,
  extraction: FileExtraction,
  context: ReviewEdgeReadContext = {},
): ReviewFileEdgeRead {
  const { relPath, language } = extraction;
  const { resolver } = deps.languageFactory.create(language);
  if (resolver?.resolveFileEdges === undefined) {
    return {
      relPath,
      language,
      edges: [],
      skip: { reason: "unsupportedLanguage", detail: `the ${language} facade forwards no resolveFileEdges` },
    };
  }
  const resolveFileEdges = resolver.resolveFileEdges.bind(resolver);
  const tableRead = context.symbolTable ?? { unavailable: "no indexed symbol table was hydrated for this review" };
  const symbolTable = "table" in tableRead ? tableRead.table : unavailableSymbolTable(tableRead.unavailable);
  const declaredDependencies = context.declaredDependencies?.get(language);
  try {
    // Runtime channel first, type-only second — the order the index merges them
    // in (`CallEdgeResolutionRunner#resolve`), so a target both reach keeps the
    // runtime statement's names first once `reviewEdgesOfFile` collapses it. The
    // type-only channel gets no method edges, as in the index.
    const runtime = runtimeImportExtraction(extraction);
    const typeOnly = typeOnlyImportExtraction(extraction);
    const fileEdges = [
      ...resolveFileEdges(
        runtime,
        reviewFileEdgeContext(runtime, workTree, symbolTable, declaredDependencies),
        UNRESOLVED_METHOD_EDGES,
      ),
      ...(typeOnly === undefined
        ? []
        : resolveFileEdges(typeOnly, reviewFileEdgeContext(typeOnly, workTree, symbolTable, declaredDependencies), [])),
    ];
    return { relPath, language, edges: reviewEdgesOfFile(relPath, fileEdges, workTree) };
  } catch (error) {
    if (error instanceof ReviewSymbolTableUnavailableError) {
      return { relPath, language, edges: [], skip: { reason: "indexedSymbolsUnavailable", detail: error.message } };
    }
    if (error instanceof ReviewResolvedCallsUnavailableError) {
      return {
        relPath,
        language,
        edges: [],
        skip: {
          reason: "resolvedCallsUnavailable",
          detail: `${language} derives file edges from resolved calls; ${error.message}`,
        },
      };
    }
    throw error;
  }
}

/**
 * The `CallContext` one import channel of a review file resolves under — the
 * fields the index's `CallEdgeResolutionRunner#fileEdgeContext` gives it that a
 * review can supply: the file's own imports and top-level scope, its
 * association types, the tree's declared dependencies, the review's table and
 * the working tree's root. The run-global pass-1 maps are not available to a
 * review; file-edge targets do not depend on them.
 */
function reviewFileEdgeContext(
  extraction: FileExtraction,
  workTree: string,
  symbolTable: GlobalSymbolTable,
  declaredDependencies: ReadonlySet<string> | undefined,
): CallContext {
  return {
    callerFile: extraction.relPath,
    callerScope: extraction.fileScope,
    imports: extraction.imports,
    symbolTable,
    ...(extraction.associationTypes !== undefined ? { associationTypes: extraction.associationTypes } : {}),
    ...(declaredDependencies !== undefined ? { declaredDependencies } : {}),
    projectRoot: workTree,
  };
}

/**
 * The run-level context every walk of one review shares — the working tree's
 * `Gemfile` and the dependencies its manifests declare, the same wiring
 * `naming-review-extraction.ts` gives its walks (kept local here because that
 * module's copy is closure-private). Read once per review, then handed to
 * every {@link readWorkingTreeFileEdges} call.
 */
export function workingTreeExtractionContext(
  workTree: string,
  languageFactory: LanguageFactoryDescriptor,
): InMemoryExtractionContext {
  return {
    declaredDependencies: readDeclaredDependenciesByLanguage(
      workTree,
      collectDependencyManifestSources(languageFactory),
    ),
  };
}

/**
 * `GraphEdges.fileEdges` → deduped `ReviewFileEdge[]` of one file: self-edges
 * dropped (the review judges a file's COUPLING, not its self-reference),
 * targets the working tree no longer holds dropped (the mapper's unverified
 * extension fallback must not name a deleted file), duplicates collapsed —
 * `./b` and `./b.js` from one file are one dependency. The export names each
 * statement takes and forwards SURVIVE the collapse (bd
 * tea-rags-mcp-89k7k.1.6): one edge per target carries the UNION of its
 * statements' names in first-seen order, each list absent when no statement
 * recorded one — the facade-contract detector judges the tree's re-export
 * surface against the indexed demand, and "not recorded" must never reach it
 * as "names nothing". `fileEdges` holds BOTH import channels — runtime, then
 * type-only: F2's detectors judge the same graph `cg_symbols_edges_file`
 * persists, and since bd tea-rags-mcp-89k7k.31 a type-only import's resolved
 * edge joins that table (bd tea-rags-mcp-c9a40). A target both channels reach
 * is one edge carrying both statements' names.
 */
function reviewEdgesOfFile(
  relPath: string,
  fileEdges: readonly GraphEdges["fileEdges"][number][],
  workTree: string,
): readonly ReviewFileEdge[] {
  // First-seen target order preserved: Map iteration is insertion order, so
  // the emitted edges keep the order the statements were walked in.
  const namesByTarget = new Map<string, { imported?: string[]; reexported?: string[] }>();
  for (const edge of fileEdges) {
    if (edge.targetRelPath === relPath) continue;
    if (!existsSync(join(workTree, edge.targetRelPath))) continue;
    const names = namesByTarget.get(edge.targetRelPath);
    if (names === undefined) {
      namesByTarget.set(edge.targetRelPath, {
        ...(edge.importedExportNames !== undefined ? { imported: [...edge.importedExportNames] } : {}),
        ...(edge.reexportedExportNames !== undefined ? { reexported: [...edge.reexportedExportNames] } : {}),
      });
      continue;
    }
    names.imported = unionRecordedNames(names.imported, edge.importedExportNames);
    names.reexported = unionRecordedNames(names.reexported, edge.reexportedExportNames);
  }
  const edges: ReviewFileEdge[] = [];
  for (const [targetRelPath, names] of namesByTarget) {
    edges.push({
      sourceRelPath: relPath,
      targetRelPath,
      ...(names.imported !== undefined ? { importedExportNames: names.imported } : {}),
      ...(names.reexported !== undefined ? { reexportedExportNames: names.reexported } : {}),
    });
  }
  return Object.freeze(edges);
}

/**
 * Union of two recorded name lists in first-seen order; `undefined` only when
 * neither side recorded one — a second statement of the same target adds its
 * names, it never erases the first's.
 */
function unionRecordedNames(first: string[] | undefined, second: readonly string[] | undefined): string[] | undefined {
  if (second === undefined) return first;
  if (first === undefined) return [...second];
  const seen = new Set(first);
  for (const name of second) {
    if (seen.has(name)) continue;
    seen.add(name);
    first.push(name);
  }
  return first;
}

/** An unknown thrown value's message, for a skip detail. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
