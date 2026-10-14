/**
 * ReviewChangesOps (bd tea-rags-mcp-89k7k.1.4, F3 slice 1): the orchestration
 * behind `review_changes` — resolve the addressed collection and the working
 * tree, read the diff ONCE with the F0 reader, acquire ONE codegraph reader
 * for every section that needs the index, then run the REQUESTED section
 * providers in registry order and assemble the keyed map.
 *
 * Selection contract (owner-confirmed 2026-10-01): `sections` is an allowlist,
 * default every registered section; an id with no provider fails loud here
 * too (the MCP enum already rejects it, direct callers must not slip through);
 * a section not requested is OMITTED from the map — absence is not not-built.
 *
 * Reader semantics mirror `GraphFacade#withReadHandle`: a collection with no
 * codegraph database answers with its sections not built (graph reads have no
 * substrate), while a database that exists but cannot be read FAILS the review
 * — a lock or a corrupt file must not pass for a clean one. The one reader is
 * closed after every section has answered.
 *
 * Sections run sequentially — naming is the slow one; fine for v1.
 */

import type { CollectionGraphHandle, GraphDbClientPool } from "../../../adapters/duckdb/pool.js";
import { withSharedWorkTreeListings } from "../../../adapters/filesystem/dependency-manifests.js";
import type { GitFileMaintenanceSignals } from "../../../contracts/types/architecture-report.js";
import type { RelPath } from "../../../contracts/types/codegraph.js";
import type { PhysicalCollectionName } from "../../../contracts/types/collection-identity.js";
import type { RegistryLookup } from "../../../contracts/types/registry.js";
import type { WorkingTree } from "../../../contracts/types/working-tree.js";
import type { WorkingTreeOverlay } from "../../../domains/explore/index.js";
import { resolvePhysicalCollection } from "../../../primitives/ids/index.js";
import type {
  ReviewChangesRequest,
  ReviewChangesResult,
  ReviewSectionId,
  ReviewSectionResult,
} from "../../public/dto/review.js";
import { InvalidParameterError } from "../../public/errors.js";
import { resolveIndexedWorkingTree, type IndexExistenceCheck } from "../collection-resolver.js";
import {
  readProductionArchitectureGraph,
  type DeclaredTestDependencyLookup,
  type IndexedFileImportLookup,
} from "./architecture-facts.js";
import { readOnce } from "./architecture-report-ops.js";
import { DIFF_FILE_CAP, readDiffScope, readTreeLag } from "./diff-scope-reader.js";
import type { ReviewEdgeExtractionDeps } from "./review-edge-overlay.js";
import {
  readReviewChangeEdges,
  REVIEW_SECTION_PROVIDERS,
  reviewSectionIds,
  type ReviewChangeEdges,
  type ReviewGraphDb,
  type ReviewNamingLexicon,
  type ReviewSectionBuildContext,
} from "./review-sections/index.js";
import { IndexedSymbolRowsCache, type IndexedSymbolRowsRead } from "./review-symbol-table.js";

export interface ReviewChangesOpsDeps {
  /**
   * `databaseWriteStamp` keys the indexed symbol rows held across reviews (bd
   * tea-rags-mcp-nehn5); absent (unit wiring) → every review reads them.
   */
  pool: Pick<GraphDbClientPool, "acquireReader" | "hasDatabase"> &
    Partial<Pick<GraphDbClientPool, "databaseWriteStamp">>;
  collectionRegistry: RegistryLookup;
  /**
   * Resolve an addressed collection name to the ACTIVE underlying collection
   * (the codegraph pool opens a DuckDB file by literal name; see
   * `GraphFacadeDeps.resolveActiveCollection`). Absent → the addressed name
   * against no aliases.
   */
  resolveActiveCollection?: (collectionName: string) => Promise<PhysicalCollectionName>;
  /** The naming lexicon the `naming` section forwards to — the SAME instance the endpoint uses. */
  lexiconOps: ReviewNamingLexicon;
  /**
   * The working-tree edge extraction trio the `architecture` section walks
   * changed files with — the same wires `createNamingReviewExtractor` uses,
   * threaded from the composition root (which holds the languageFactory).
   * Absent → the section answers not built.
   */
  reviewEdgeExtraction?: ReviewEdgeExtractionDeps;
  /**
   * The indexed payload's import specifiers for given files (bd
   * tea-rags-mcp-2wsnt) — the SAME `readPayloadImportSpecifiers` read the
   * whole-repo report's second silent-coupling pass uses, over the addressed
   * collection. Bound to the review's collection before a section sees it.
   * Absent (unit wiring) → the section's silent-coupling facts are the
   * single-pass verdict.
   */
  readImportSpecifiers?: (
    collectionName: string,
    relPaths: readonly RelPath[],
  ) => Promise<ReadonlyMap<RelPath, readonly string[]>>;
  /**
   * Every file's git maintenance readings over the addressed collection (bd
   * tea-rags-mcp-r8hme.20) — the SAME `readPayloadFileMaintenanceSignals` read
   * the whole-repo report ranks by. Bound to the review's collection before a
   * section sees it. Absent → the architecture findings stay unranked.
   */
  readFileMaintenanceSignals?: (collectionName: string) => Promise<ReadonlyMap<RelPath, GitFileMaintenanceSignals>>;
  /**
   * Every indexed file's module specifiers (and whether it is a test) over the addressed collection (bd
   * tea-rags-mcp-89k7k.35.3) — the SAME `readPayloadIndexedFileImports`
   * read the whole-repo report derives test support from. Bound to the
   * review's collection before a section sees it. Absent → no test support is
   * excluded from the production graph.
   */
  readIndexedFileImports?: (collectionName: string) => ReturnType<IndexedFileImportLookup>;
  /**
   * The development-only packages the manifests under the reviewed tree
   * declare (bd tea-rags-mcp-89k7k.35.3), bound to the review's work tree
   * before a section sees it. Absent → the manifests add nothing.
   */
  readDeclaredTestDependencies?: (root: string) => ReturnType<DeclaredTestDependencyLookup>;
  /** The temporal walk's history window (the git trajectory's `chunkMaxAgeMonths`). */
  windowMonths: number;
  /**
   * Measures the tree the review reads against its index (bd tea-rags-mcp-xi2r9).
   * Present → every answer carries `workingTree`; absent (unit wiring) → none.
   */
  workingTreeOverlay?: Pick<WorkingTreeOverlay, "view">;
  /**
   * Whether the resolved index exists — a read of one that does not is refused
   * with the typed not-found error (live round-3 D3, `resolveIndexedWorkingTree`).
   * Absent (unit wiring): not checked.
   */
  indexExists?: IndexExistenceCheck;
}

export class ReviewChangesOps {
  /** The index's symbol rows, held across reviews per database write stamp (bd tea-rags-mcp-nehn5). */
  private readonly indexedSymbolRows = new IndexedSymbolRowsCache();

  constructor(private readonly deps: ReviewChangesOpsDeps) {}

  /**
   * The codegraph-off fallback: no reader, no registry reads — every requested
   * section not built, envelope zeroed. Honest empty for "this server has no
   * review substrate", never a fake clean review.
   */
  static empty(request: ReviewChangesRequest): ReviewChangesResult {
    const sections: Partial<Record<ReviewSectionId, ReviewSectionResult>> = {};
    for (const id of request.sections ?? reviewSectionIds) {
      sections[id] = { built: false, reason: "codegraph not wired — no review substrate" };
    }
    return {
      review: {
        workTree: "",
        base: request.changes?.base ?? "HEAD",
        mergeBase: "",
        changedFiles: 0,
        skipped: 0,
        sections,
      },
    };
  }

  async reviewChanges(req: ReviewChangesRequest): Promise<ReviewChangesResult> {
    const providers = this.requestedProviders(req.sections);
    // One addressing rule (bd tea-rags-mcp-xi2r9): index reads address the base index, git
    // reads the tree the caller stands in — `path` alone at a linked worktree reaches both.
    const workingTree = await resolveIndexedWorkingTree(this.deps.collectionRegistry, req, this.deps.indexExists);
    // Every read answer carries the marker (bd tea-rags-mcp-xi2r9, live probe P2-4).
    // `indexLag` inside the review block stays until the marker supersedes it.
    const view = this.deps.workingTreeOverlay?.view(workingTree, req.project);
    // One listing scope per review (bd tea-rags-mcp-uqkn5): the declared-dependency
    // read and the test-dependency read see one work tree and list it once. The
    // scope opens here so every promise the review creates — the early symbol-row
    // and production-graph reads included — is bound to it.
    const result = await withSharedWorkTreeListings(async () => this.reviewWorkingTree(req, providers, workingTree));
    return view ? { ...result, workingTree: (await view).marker } : result;
  }

  private async reviewWorkingTree(
    req: ReviewChangesRequest,
    providers: readonly (typeof REVIEW_SECTION_PROVIDERS)[number][],
    workingTree: WorkingTree,
  ): Promise<ReviewChangesResult> {
    const { collectionName } = workingTree.baseIndex;
    const addressing = { project: req.project, collection: req.collection, path: req.path };
    const workTree = workingTree.root || undefined;
    // The graph reader opens, and the index's symbol rows are read, while the
    // diff is read (bd tea-rags-mcp-nehn5): the rows do not depend on the diff.
    const reader = this.acquireGraphReader(collectionName);
    const symbolRows = providers.some((provider) => provider.consumesReviewChangeEdges)
      ? reader.then(async ({ handle, physicalCollectionName }) =>
          this.indexedSymbolRows.read(
            collectionName,
            () => this.deps.pool.databaseWriteStamp?.(physicalCollectionName),
            handle?.graphDb,
          ),
        )
      : undefined;
    // A reader that fails rejects `symbolRows` too — the review throws the
    // reader's failure below, so this branch must not surface unhandled.
    symbolRows?.catch(() => undefined);
    const [readerOutcome, scopeOutcome] = await Promise.allSettled([
      reader,
      readDiffScope(workTree, { base: req.changes?.base, files: req.files }),
    ]);
    if (scopeOutcome.status === "rejected") {
      if (readerOutcome.status === "fulfilled") {
        await symbolRows?.catch(() => undefined);
        await readerOutcome.value.handle?.graphDb.close().catch(() => undefined);
      }
      throw scopeOutcome.reason;
    }
    if (readerOutcome.status === "rejected") throw readerOutcome.reason;
    const scope = scopeOutcome.value;
    const { handle } = readerOutcome.value;
    const indexLag =
      workTree === undefined ? undefined : readTreeLag(this.deps.collectionRegistry, collectionName, workTree);

    try {
      const graphDb: ReviewGraphDb | undefined = handle?.graphDb;
      let temporalCochange: Awaited<ReturnType<ReviewGraphDb["readTemporalCochangeGraph"]>> | undefined;
      let temporalCochangeError: string | undefined;
      // ONE read per call for every consumer: any section that declares
      // `consumesTemporalCochange` (incompleteChange, architecture) shares
      // this snapshot — the coupling reader never re-reads what a sibling
      // already holds.
      if (graphDb !== undefined && providers.some((provider) => provider.consumesTemporalCochange)) {
        try {
          temporalCochange = await graphDb.readTemporalCochangeGraph();
        } catch (error) {
          temporalCochangeError = error instanceof Error ? error.message : String(error);
        }
      }
      // Bound to THIS review's collection — the section addresses no index of
      // its own (bd tea-rags-mcp-2wsnt).
      const { readImportSpecifiers, readFileMaintenanceSignals, readIndexedFileImports } = this.deps;
      const importSpecifiers =
        readImportSpecifiers === undefined
          ? undefined
          : async (relPaths: readonly RelPath[]) => readImportSpecifiers(collectionName, relPaths);
      const maintenanceSignals =
        readFileMaintenanceSignals === undefined ? undefined : async () => readFileMaintenanceSignals(collectionName);
      const indexedFileImports =
        readIndexedFileImports === undefined ? undefined : async () => readIndexedFileImports(collectionName);
      const { readDeclaredTestDependencies } = this.deps;
      const declaredTestDependencies =
        readDeclaredTestDependencies === undefined || workTree === undefined
          ? undefined
          : () => readDeclaredTestDependencies(workTree);
      // The production graph, read on first use and shared by architecture and
      // norms (bd tea-rags-mcp-pqdw4): the whole-graph and whole-index reads
      // run once per review, not once per section.
      const readProductionGraphOnce =
        graphDb === undefined
          ? undefined
          : readOnce(async () =>
              readProductionArchitectureGraph(graphDb, indexedFileImports, declaredTestDependencies),
            );
      // The change's edges, read on first use and shared (bd tea-rags-mcp-nehn5):
      // every section that walks the diff resolves against one hydrated table
      // (bd tea-rags-mcp-vdhjc) and one walk, and a review asking for none of
      // them reads nothing.
      const { reviewEdgeExtraction } = this.deps;
      let changeEdges: Promise<ReviewChangeEdges> | undefined;
      const readReviewChangeEdgesOnce =
        reviewEdgeExtraction === undefined
          ? undefined
          : async (): Promise<ReviewChangeEdges> =>
              (changeEdges ??= (async () =>
                readReviewChangeEdges(scope, reviewEdgeExtraction, await (symbolRows ?? NO_SYMBOL_ROWS)))());
      const buildContext: ReviewSectionBuildContext = {
        scope,
        graphDb,
        temporalCochange,
        temporalCochangeError,
        lexiconOps: this.deps.lexiconOps,
        reviewEdgeExtraction,
        ...(readReviewChangeEdgesOnce === undefined ? {} : { readReviewChangeEdges: readReviewChangeEdgesOnce }),
        ...(indexLag === undefined ? {} : { indexLag }),
        ...(importSpecifiers === undefined ? {} : { readImportSpecifiers: importSpecifiers }),
        ...(maintenanceSignals === undefined ? {} : { readFileMaintenanceSignals: maintenanceSignals }),
        ...(indexedFileImports === undefined ? {} : { readIndexedFileImports: indexedFileImports }),
        ...(declaredTestDependencies === undefined ? {} : { readDeclaredTestDependencies: declaredTestDependencies }),
        ...(readProductionGraphOnce === undefined ? {} : { readProductionGraph: readProductionGraphOnce }),
      };
      // The sections are independent reads of one snapshot, so they run
      // together; the envelope lists them in the requested order whatever
      // order they finish in. The shared `graphDb` handle takes concurrent
      // calls: the daemon client multiplexes them by request id, an in-process
      // session queues its writes (`DuckDbGraphSession#serialize`) and a
      // section's own reads already overlap (`judgeDrafts`' Promise.all).
      // Every section settles before the handle closes in `finally`; a failed
      // one then fails the review with the first failure in requested order.
      const settled = await Promise.allSettled(
        providers.map(async (provider): Promise<ReviewSectionResult> => {
          const verdict = provider.isBuilt(buildContext);
          if (!verdict.built) {
            return { built: false, ...(verdict.reason !== undefined ? { reason: verdict.reason } : {}) };
          }
          const payload = await provider.run({
            ...buildContext,
            addressing,
            collectionName,
            windowMonths: this.deps.windowMonths,
            diffRequest: { base: req.changes?.base, files: req.files },
          });
          // Spread AFTER `built: true`: a provider that fails at run time may
          // answer its own `{ built: false, reason }`, and that verdict wins.
          return { built: true, ...(payload as object) };
        }),
      );
      const sections: Partial<Record<ReviewSectionId, ReviewSectionResult>> = {};
      providers.forEach((provider, i) => {
        const outcome = settled[i];
        if (outcome.status === "rejected") throw outcome.reason;
        sections[provider.id] = outcome.value;
      });
      return {
        review: {
          workTree: scope.workTree,
          base: scope.base,
          mergeBase: scope.mergeBase,
          changedFiles: scope.changedFiles,
          skipped: scope.skipped,
          ...(scope.skipped > 0 ? { truncated: { cap: DIFF_FILE_CAP, skipped: scope.skipped } } : {}),
          ...(indexLag !== undefined ? { indexLag } : {}),
          ...(scope.notices.length > 0 ? { notices: [...scope.notices] } : {}),
          sections,
        },
      };
    } finally {
      if (handle !== undefined) await handle.graphDb.close().catch(() => undefined);
    }
  }

  /** The requested providers, in registry order; an unregistered id fails loud naming it and the registered set. */
  private requestedProviders(
    sections: ReviewSectionId[] | undefined,
  ): readonly (typeof REVIEW_SECTION_PROVIDERS)[number][] {
    if (sections === undefined) return REVIEW_SECTION_PROVIDERS;
    const byId = new Map(REVIEW_SECTION_PROVIDERS.map((provider) => [provider.id, provider]));
    const unknown = sections.filter((id) => !byId.has(id));
    if (unknown.length > 0) {
      throw new InvalidParameterError(
        "sections",
        `unknown section(s): ${unknown.join(", ")} — registered: ${reviewSectionIds.join(", ")}`,
      );
    }
    return sections.flatMap((id) => {
      const provider = byId.get(id);
      return provider === undefined ? [] : [provider];
    });
  }

  /**
   * One read handle on the addressed collection's graph, or `undefined` when
   * the collection has no codegraph database at all. A database that exists
   * but cannot be read rethrows — see the module docblock.
   */
  private async acquireGraphReader(
    collectionName: string,
  ): Promise<{ handle: CollectionGraphHandle | undefined; physicalCollectionName: PhysicalCollectionName }> {
    const activePhysicalCollectionName = this.deps.resolveActiveCollection
      ? await this.deps
          .resolveActiveCollection(collectionName)
          .catch(() => resolvePhysicalCollection(collectionName, []))
      : resolvePhysicalCollection(collectionName, []);
    try {
      const handle = await this.deps.pool.acquireReader(activePhysicalCollectionName);
      return { handle, physicalCollectionName: activePhysicalCollectionName };
    } catch (error) {
      if (this.deps.pool.hasDatabase(activePhysicalCollectionName)) throw error;
      return { handle: undefined, physicalCollectionName: activePhysicalCollectionName };
    }
  }
}

/** What a review that read no symbol rows resolves against. */
const NO_SYMBOL_ROWS: Promise<IndexedSymbolRowsRead> = Promise.resolve({
  unavailable: "no indexed symbol table was read for this review",
});
