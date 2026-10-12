/**
 * The port the Reranker's consumers are typed against (6oah1 E1, decision
 * N-1 = a: `<Class>Port`, class name unchanged).
 *
 * The explore root is the stable sink of the read path — strategies,
 * post-process, rank-module inside the domain, ops/facades/schema-builder/
 * app-factory in api/internal — and the Stable Dependencies Principle wants a
 * component that others depend on to be abstract. This interface is the
 * consumed surface: every member is a `Reranker` method some holder actually
 * calls (census over the holder files on main, 2026-10-11); nothing
 * speculative is declared. The concrete `Reranker` implements it, type-only
 * holders type against the port, and the one constructor site
 * (api/internal/composition.ts) keeps the concrete class.
 *
 * The port lives here rather than in contracts because placing it inside the
 * stable component is what moves main-sequence distance: its consumer set —
 * explore itself and api/internal — shares the explore root's stability band
 * (same placement reasoning as I1's CollectionIndexingLockPort, plan note
 * g-13). C8b's StatsRecomputeServicePort sits in contracts instead because
 * explore, a different domain, consumes it from ingest; no such cross-domain
 * consumer exists for the reranker surface.
 *
 * This file is a LEAF over its own declarations: it type-imports only from
 * `contracts/`, never from `reranker.js` — the arrow runs one way, concrete
 * class → port. `RerankOptions` is declared here (not in `reranker.ts`) for
 * that reason; `reranker.ts` re-exports it so existing import paths stand.
 */
import type { ScoringWeights } from "../../contracts/types/provider.js";
import type {
  DerivedSignalDescriptor,
  RankingOverlay,
  RerankableResult,
  RerankMode,
  RerankPreset,
  SignalLevel,
} from "../../contracts/types/reranker.js";
import type { StatsRecomputeServicePort } from "../../contracts/types/stats-recompute.js";
import type { CollectionSignalStats, PayloadSignalDescriptor } from "../../contracts/types/trajectory.js";

/** Options for RerankerPort.rerank() — consolidates optional parameters. */
export interface RerankOptions {
  signalLevel?: SignalLevel;
  query?: string;
  /**
   * When false, overlays are still computed and attached but the final
   * score-descending sort is skipped — the returned array preserves input
   * order. Default true (sort as before). Used by trace_path to annotate a
   * path with danger overlays without disturbing execution order.
   * Note: a preset with `groupBy` still runs its group-dedup pass under
   * reorder:false, so the per-group representative is the first input-order
   * entry, not the highest-scored.
   */
  reorder?: boolean;
  /**
   * Query-time reference clock, unix SECONDS (the lastModifiedAt unit).
   * Injected once per rerank into `ExtractContext.now`, the age-source
   * adaptive bounds and the overlay ageDays resolution, so age derives from
   * lastModifiedAt at read time (bd tea-rags-mcp-9ot33). Defaults to the
   * current time; tests pin it for determinism.
   */
  now?: number;
}

/**
 * The reranker as its consumers see it: rerank a batch under a mode
 * (`rerank`), ask which modes exist (the preset accessors), and manage the
 * collection stats that label resolution and adaptive bounds read.
 */
export interface RerankerPort {
  /**
   * Rerank results with ranking overlay. Lazy-at-rerank: before scoring,
   * backfills any confidence-referenced percentile missing from the loaded
   * collection stats (one scroll per support signal, only when needed).
   */
  rerank: <T extends RerankableResult>(
    results: T[],
    mode: RerankMode<string>,
    presetSet: "semantic_search" | "search_code" | "rank_chunks" | "trace_path",
    options?: RerankOptions,
  ) => Promise<(T & { rankingOverlay?: RankingOverlay })[]>;
  /** Preset weights for a preset name and tool; `undefined` when the (name, tool) pair matches nothing. */
  getPreset: (
    name: string,
    tool: "semantic_search" | "search_code" | "rank_chunks" | "trace_path",
  ) => ScoringWeights | undefined;
  /** Full preset object (weights, mask, groupBy, signalLevel) for a name and tool. */
  getFullPreset: (
    name: string,
    tool: "semantic_search" | "search_code" | "rank_chunks" | "trace_path",
  ) => RerankPreset | undefined;
  /** All derived signal descriptors (for RankModule). */
  getDescriptors: () => DerivedSignalDescriptor[];
  /** Descriptor info for MCP schema generation. */
  getDescriptorInfo: () => { name: string; description: string }[];
  /** Preset names a tool accepts. */
  getPresetNames: (tool: string) => string[];
  /** Full preset details for resource documentation. */
  getPresetDetails: (tool: string) => { name: string; description: string; weights: string[]; tools: string[] }[];
  /** Payload signal descriptors (for dynamic resource generation). */
  getPayloadSignals: () => PayloadSignalDescriptor[];
  /**
   * Wire the registered filter-preset names (composition time, from
   * TrajectoryRegistry) so the schema layer can surface them through its
   * single reranker dependency.
   */
  setFilterPresetNames: (names: readonly string[]) => void;
  /** Registered filter-preset names (for the MCP `filter` param `{ presets }` arm). */
  filterPresetNames: () => string[];
  /** Wire the typed filter param names the trajectory registry applies (composition time). */
  setFilterParamNames: (names: readonly string[]) => void;
  /** Typed filter param names the registered trajectories apply. */
  filterParamNames: () => string[];
  /**
   * Whether the stats currently held are the ones this collection wants, at
   * the revision the caller has observed on disk — the question a loader must
   * ask (bd tea-rags-mcp-yntsd), not the bare "is anything loaded".
   */
  hasCollectionStatsFor: (collectionName: string, revision?: number) => boolean;
  /** The loaded collection stats, or `undefined` when none are loaded. */
  getCollectionStats: () => CollectionSignalStats | undefined;
  /** Set collection-wide signal stats (computed after indexing). */
  setCollectionStats: (
    stats: CollectionSignalStats,
    opts?: { collectionName?: string; payloadFieldKeys?: string[]; revision?: number },
  ) => void;
  /** Wire the lazy stats-recompute service for the rerank-time percentile backfill. */
  setRecomputeService: (service: StatsRecomputeServicePort) => void;
  /** Drop the loaded stats (called when a reindex starts). */
  invalidateStats: () => void;
}
