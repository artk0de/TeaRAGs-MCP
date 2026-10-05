/**
 * App factory — the composition root's public entrypoint (bd tea-rags-mcp-89k7k.22).
 *
 * `createApp` wires DI-provided handlers into an `App`. It lived in
 * `api/public/app.ts` until the 2026-10-04 rescan measured the stable contract
 * layer (instability 0.05) calling the unstable composition root (0.93) with
 * delta 0.87 — the largest SDP violation in the scan, `cycleWithDependents`,
 * multiplying with every new tool. Assembly is not contract: the factory moved
 * here, next to `composition.ts`, and `api/public` keeps the `App`/`AppDeps`
 * interfaces as a pure contract. Bootstrap (and tests) reach this through the
 * api root barrel, which re-exports `createApp` — the assembly surface.
 *
 * To add a new endpoint:
 * 1. Add DTO to public/dto/<domain>.ts
 * 2. Add method to the App interface in public/app.ts
 * 3. Implement in internal/facades/ or internal/ops/
 * 4. Wire via internal/composition.ts (ops construction) + createApp() below
 * 5. Register MCP tool in src/mcp/tools/
 */

import { formatIndexDriftReport } from "../../domains/maintenance/drift/index.js";
// The handler TYPES arrive through the api barrel (`../index.js`), which
// aggregates composition + facades — a type-only edge the contract layer and
// this factory both keep (bd tea-rags-mcp-0qaht.12). No deep `../public/`
// path beyond the contract itself is imported.
import type { CollectionOps, DocumentOps, ExploreFacade, IngestFacade, ProjectRegistryOps } from "../index.js";
import type { App, AppDeps } from "../public/app.js";
import type { IndexStatus, PresetDetail } from "../public/dto/index.js";
import {
  createPathCollectionResolver as createPathCollectionResolverImpl,
  resolveBaseIndexEntry as resolveBaseIndexEntryImpl,
} from "./collection-resolver.js";
import {
  composeAppOps,
  emptyArchitectureReport,
  emptyCochangeResult,
  emptyOntologyReport,
  emptyReviewChangesResult,
  resolveLanguageCapabilities as resolveDomainLanguageCapabilities,
} from "./composition.js";
import { reviewSectionIds as reviewSectionIdsValue } from "./ops/review-sections/index.js";

/**
 * wireFacades — returns the pre-assembled domain facades from deps.
 *
 * Facades (ExploreFacade, IngestFacade) are constructed upstream by
 * createComposition() in api/internal/composition.ts. createApp() does not
 * instantiate them — it only exposes them through the App interface. This
 * helper exists to make the facade-vs-ops layer split explicit at the
 * composition root: the App contract has two distinct groups of dependencies,
 * and each group has its own wire-up step.
 *
 * File-private — do NOT export.
 */
function wireFacades(deps: AppDeps): { explore: ExploreFacade; ingest: IngestFacade } {
  return { explore: deps.explore, ingest: deps.ingest };
}

/**
 * wireOps — resolves the App-layer ops handlers and forwards the
 * pre-injected ProjectRegistryOps.
 *
 * Ops classes (CollectionOps, DocumentOps) own collection/document CRUD and
 * are constructed by the composition root (`composeAppOps` in
 * internal/composition.ts), arriving here via DI. The fallback composes them
 * from the raw infrastructure handles for callers that hand a bare
 * `AppDeps` (the test path). ProjectRegistryOps is supplied via deps
 * because its construction requires bootstrap-only state (the registry file
 * path).
 *
 * File-private — do NOT export.
 */
function wireOps(deps: AppDeps): {
  collection: CollectionOps;
  document: DocumentOps;
  projectRegistry: ProjectRegistryOps;
} {
  if (deps.collectionOps && deps.documentOps) {
    return {
      collection: deps.collectionOps,
      document: deps.documentOps,
      projectRegistry: deps.projectRegistryOps,
    };
  }
  const composed = composeAppOps(deps);
  return {
    collection: deps.collectionOps ?? composed.collection,
    document: deps.documentOps ?? composed.document,
    projectRegistry: deps.projectRegistryOps,
  };
}

export function createApp(deps: AppDeps): App {
  const facades = wireFacades(deps);
  const ops = wireOps(deps);

  return {
    // -- Search — delegate to ExploreFacade --
    semanticSearch: async (req) => facades.explore.semanticSearch(req),
    hybridSearch: async (req) => facades.explore.hybridSearch(req),
    rankChunks: async (req) => facades.explore.rankChunks(req),
    searchCode: async (req) => facades.explore.searchCode(req),
    findSimilar: async (req) => facades.explore.findSimilar(req),
    findSymbol: async (req) => facades.explore.findSymbol(req),

    // -- Indexing — delegate to IngestFacade. The index run resolves its facade
    // per path so the project's registry env governs it. Status does too: its
    // enrichment health is framed on the slice's provider list, which a
    // project's registry env can narrow (a disabled trajectory has no row), and
    // `get_index_metrics` frames on that same per-path slice
    // (bd tea-rags-mcp-uebug). Clear reads no composition and stays on the
    // process-wide facade.
    indexCodebase: async (path, options, progress, enrichmentProgress) =>
      (deps.ingestForPath?.(path) ?? facades.ingest).indexCodebase(path, options, progress, enrichmentProgress),
    whenEnrichmentComplete: async () => facades.ingest.whenEnrichmentComplete(),
    getIndexStatus: async (path) => readIndexStatus(path, deps, facades.ingest),
    clearIndex: async (path) => facades.ingest.clearIndex(path),

    // -- Collections — delegate to CollectionOps --
    createCollection: async (req) => ops.collection.create(req),
    listCollections: async () => ops.collection.list(),
    getCollectionInfo: async (name) => ops.collection.getInfo(name),
    getCollectionMemory: async (name) => ops.collection.getMemory(name),
    deleteCollection: async (name) => ops.collection.delete(name),

    // -- Documents — delegate to DocumentOps --
    addDocuments: async (req) => ops.document.add(req),
    deleteDocuments: async (req) => ops.document.delete(req),

    // -- Index metrics --
    getIndexMetrics: async (path) => facades.explore.getIndexMetrics(path),

    // -- Schema descriptors --
    getSchemaDescriptors: () => {
      const info = deps.reranker.getDescriptorInfo();
      const tools = ["semantic_search", "hybrid_search", "search_code", "rank_chunks", "find_similar"];
      const presetNames: Record<string, string[]> = {};
      const presetDetails: Record<string, PresetDetail[]> = {};
      for (const tool of tools) {
        presetNames[tool] = deps.reranker.getPresetNames(tool);
        presetDetails[tool] = deps.reranker.getPresetDetails(tool);
      }
      return {
        presetNames,
        presetDetails,
        signalDescriptors: info.map((d) => ({ name: d.name, description: d.description })),
        payloadSignals: deps.reranker.getPayloadSignals(),
      };
    },

    // -- Drift monitoring --
    checkIndexDrift: async ({ path, collection, consume }) => {
      const report = path
        ? consume
          ? await deps.driftReporter.checkAndConsume(path)
          : await deps.driftReporter.checkByPath(path)
        : collection
          ? consume
            ? deps.driftReporter.checkAndConsumeByCollectionName(collection)
            : deps.driftReporter.checkByCollectionName(collection)
          : null;
      return report && formatIndexDriftReport(report);
    },

    // -- Project registry — delegate to ProjectRegistryOps --
    registerProject: async (input) => ops.projectRegistry.register(input),
    listProjects: async () => ops.projectRegistry.list(),
    unregisterProject: async (input) => ops.projectRegistry.unregister(input),

    // -- Codegraph — getCallers/getCallees/findCycles delegate to GraphFacade;
    // tracePath delegates to TracePathOps. When the backing dep is undefined
    // (CODEGRAPH_DISABLED or DuckDB unavailable) surface an empty result
    // rather than crashing the tool.
    getCallers: async (req) => (deps.graphFacade ? deps.graphFacade.getCallers(req) : { callers: [] }),
    getCallees: async (req) => (deps.graphFacade ? deps.graphFacade.getCallees(req) : { callees: [] }),
    findCycles: async (req) => (deps.graphFacade ? deps.graphFacade.findCycles(req) : { cycles: [] }),
    getArchitectureReport: async (req) =>
      deps.graphFacade ? deps.graphFacade.getArchitectureReport(req) : emptyArchitectureReport(req),
    tracePath: async (req) => (deps.tracePathOps ? deps.tracePathOps.tracePath(req) : { paths: [], truncated: false }),
    getNamingLexicon: async (req) =>
      deps.namingLexiconOps ? deps.namingLexiconOps.getNamingLexicon(req) : { scope: "", byType: [], names: [] },
    getOntologyReport: async (req) =>
      deps.ontologyReportOps ? deps.ontologyReportOps.report(req) : emptyOntologyReport(req),
    findCoChanged: async (req) => (deps.graphFacade ? deps.graphFacade.findCoChanged(req) : emptyCochangeResult(req)),
    reviewChanges: async (req) =>
      deps.reviewFacade ? deps.reviewFacade.reviewChanges(req) : emptyReviewChangesResult(req),
    reviewSectionIds: () => reviewSectionIdsValue,

    // -- Domain runtime queries — the capability resolver delegates to the
    // composition-surfaced domain implementation; the lease predicate to
    // ProjectRegistryOps, the registry's collection-claimed oracle, which owns
    // that domain edge (bd tea-rags-mcp-89k7k.9). The two path-resolution
    // queries delegate to the collection resolver, whose free functions remain
    // the implementations — the registry is caller-supplied (bd
    // tea-rags-mcp-nkstp).
    resolveLanguageCapabilities: (languages) => resolveDomainLanguageCapabilities(languages),
    isCollectionBuildInFlight: async (qdrant, collection, options) =>
      ops.projectRegistry.isCollectionBuildInFlight(qdrant, collection, options),
    resolveBaseIndexEntry: (registry, path) => resolveBaseIndexEntryImpl(registry, path),
    createPathCollectionResolver: (registry) => createPathCollectionResolverImpl(registry),

    // -- Provider availability — backs MCP tool-registrar gating. Source
    // of truth is `registeredProviderKeys` populated by composition from
    // `TrajectoryRegistry.getRegisteredKeys()`.
    hasProvider: (key) => (deps.registeredProviderKeys ?? EMPTY_PROVIDER_SET).has(key),
  };
}

/**
 * `getIndexStatus` for the index `path` is read against (live D10): a working
 * tree answers with its base index's status, `indexPath` and the tree's
 * marker; any other path is its own index, read through its project's facade.
 */
async function readIndexStatus(path: string, deps: AppDeps, ingest: IngestFacade): Promise<IndexStatus> {
  const target = await deps.workingTreeIndexOf?.(path);
  const indexPath = target?.indexPath ?? path;
  const status = await (deps.ingestForPath?.(indexPath) ?? ingest).getIndexStatus(indexPath);
  if (!target) return status;
  return { ...status, indexPath, ...(target.workingTree ? { workingTree: target.workingTree } : {}) };
}

/** Shared empty set so the default-fallback branch on every hasProvider call doesn't allocate. */
const EMPTY_PROVIDER_SET: ReadonlySet<string> = new Set();
