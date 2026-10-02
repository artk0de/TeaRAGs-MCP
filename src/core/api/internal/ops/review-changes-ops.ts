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
import type { PhysicalCollectionName } from "../../../contracts/types/collection-identity.js";
import type { CollectionRegistry } from "../../../domains/maintenance/registry/index.js";
import { resolvePhysicalCollection } from "../../../infra/collection-name.js";
import { InvalidParameterError } from "../../errors.js";
import type {
  ReviewChangesRequest,
  ReviewChangesResult,
  ReviewSectionId,
  ReviewSectionResult,
} from "../../public/dto/review.js";
import { resolveWorkingTree } from "../collection-resolver.js";
import { DIFF_FILE_CAP, readDiffScope, readTreeLag } from "./diff-scope-reader.js";
import type { ReviewEdgeExtractionDeps } from "./review-edge-overlay.js";
import {
  REVIEW_SECTION_PROVIDERS,
  reviewSectionIds,
  type ReviewGraphDb,
  type ReviewNamingLexicon,
  type ReviewSectionBuildContext,
} from "./review-sections/index.js";

export interface ReviewChangesOpsDeps {
  pool: Pick<GraphDbClientPool, "acquireReader" | "hasDatabase">;
  collectionRegistry: CollectionRegistry;
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
  /** The temporal walk's history window (the git trajectory's `chunkMaxAgeMonths`). */
  windowMonths: number;
}

export class ReviewChangesOps {
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
    const workingTree = resolveWorkingTree(this.deps.collectionRegistry, req);
    const { collectionName } = workingTree.baseIndex;
    const addressing = { project: req.project, collection: req.collection, path: req.path };
    const workTree = workingTree.root || undefined;
    const scope = await readDiffScope(workTree, { base: req.changes?.base, files: req.files });
    const indexLag =
      workTree === undefined ? undefined : readTreeLag(this.deps.collectionRegistry, collectionName, workTree);

    const handle = await this.acquireGraphReader(collectionName);
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
      const buildContext: ReviewSectionBuildContext = {
        scope,
        graphDb,
        temporalCochange,
        temporalCochangeError,
        lexiconOps: this.deps.lexiconOps,
        reviewEdgeExtraction: this.deps.reviewEdgeExtraction,
      };
      const sections: Partial<Record<ReviewSectionId, ReviewSectionResult>> = {};
      for (const provider of providers) {
        const verdict = provider.isBuilt(buildContext);
        if (!verdict.built) {
          sections[provider.id] = { built: false, ...(verdict.reason !== undefined ? { reason: verdict.reason } : {}) };
          continue;
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
        sections[provider.id] = { built: true, ...(payload as object) };
      }
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
  private async acquireGraphReader(collectionName: string): Promise<CollectionGraphHandle | undefined> {
    const activePhysicalCollectionName = this.deps.resolveActiveCollection
      ? await this.deps
          .resolveActiveCollection(collectionName)
          .catch(() => resolvePhysicalCollection(collectionName, []))
      : resolvePhysicalCollection(collectionName, []);
    try {
      return await this.deps.pool.acquireReader(activePhysicalCollectionName);
    } catch (error) {
      if (this.deps.pool.hasDatabase(activePhysicalCollectionName)) throw error;
      return undefined;
    }
  }
}
