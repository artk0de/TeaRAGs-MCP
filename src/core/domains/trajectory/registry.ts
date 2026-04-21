/**
 * TrajectoryRegistry — aggregates Trajectory implementations.
 *
 * Works with the Trajectory interface directly (not EnrichmentProvider).
 * Collects payloadSignals, derivedSignals, filters, presets, and enrichment
 * providers from registered Trajectory instances.
 *
 * The query layer (search facade, MCP tools) uses this registry to build
 * Qdrant filters, resolve rerank presets, and generate dynamic tool schemas.
 * The ingest layer uses getAllEnrichmentProviders() to obtain providers.
 */

import { ConfigValueInvalidError } from "../../../bootstrap/errors.js";
import { mergeQdrantFilters } from "../../adapters/qdrant/filters/utils.js";
import type { QdrantFilter, QdrantFilterCondition } from "../../adapters/qdrant/types.js";
import type { EnrichmentProvider, FilterDescriptor, FilterLevel } from "../../contracts/types/provider.js";
import type { DerivedSignalDescriptor, RerankPreset } from "../../contracts/types/reranker.js";
import type { StatsAccumulatorDescriptor } from "../../contracts/types/stats-accumulator.js";
import type { PayloadSignalDescriptor, Trajectory } from "../../contracts/types/trajectory.js";

export class TrajectoryRegistry {
  private readonly trajectories: Map<string, Trajectory> = new Map();

  /**
   * Register a trajectory by its key.
   *
   * Later registrations override earlier ones for the same key.
   * Throws if a derived signal name conflicts with another trajectory.
   */
  register(trajectory: Trajectory): void {
    // Check for derived signal name conflicts with existing trajectories
    const existingNames = new Set<string>();
    for (const [key, existing] of this.trajectories) {
      if (key === trajectory.key) continue; // Skip self (override allowed)
      for (const d of existing.derivedSignals) {
        existingNames.add(d.name);
      }
    }
    for (const d of trajectory.derivedSignals) {
      if (existingNames.has(d.name)) {
        throw new ConfigValueInvalidError(
          "derivedSignal.name",
          d.name,
          `unique signal names (conflict: "${d.name}" already registered by another trajectory, "${trajectory.key}" cannot register a duplicate)`,
        );
      }
    }
    this.trajectories.set(trajectory.key, trajectory);
  }

  /** Check if a specific trajectory is registered. */
  has(key: string): boolean {
    return this.trajectories.has(key);
  }

  /** Get registered trajectory keys. */
  getRegisteredKeys(): string[] {
    return [...this.trajectories.keys()];
  }

  /** All payload signal descriptors from all registered trajectories. */
  getAllPayloadSignalDescriptors(): PayloadSignalDescriptor[] {
    const signals: PayloadSignalDescriptor[] = [];
    for (const trajectory of this.trajectories.values()) {
      signals.push(...trajectory.payloadSignals);
    }
    return signals;
  }

  /** Payload signal keys marked as essential (always shown in metaOnly). */
  getEssentialPayloadKeys(): string[] {
    return this.getAllPayloadSignalDescriptors()
      .filter((s) => s.essential)
      .map((s) => s.key);
  }

  /** All derived signal descriptors from all registered trajectories. */
  getAllDerivedSignals(): DerivedSignalDescriptor[] {
    const signals: DerivedSignalDescriptor[] = [];
    for (const trajectory of this.trajectories.values()) {
      signals.push(...trajectory.derivedSignals);
    }
    return signals;
  }

  /** All filters from all registered trajectories. */
  getAllFilters(): FilterDescriptor[] {
    const filters: FilterDescriptor[] = [];
    for (const trajectory of this.trajectories.values()) {
      filters.push(...trajectory.filters);
    }
    return filters;
  }

  /** All presets from all registered trajectories. */
  getAllPresets(): RerankPreset[] {
    const all: RerankPreset[] = [];
    for (const trajectory of this.trajectories.values()) {
      all.push(...trajectory.presets);
    }
    return all;
  }

  /** All collection-stats accumulator descriptors from all registered trajectories. */
  getAllStatsAccumulators(): StatsAccumulatorDescriptor[] {
    const accumulators: StatsAccumulatorDescriptor[] = [];
    for (const trajectory of this.trajectories.values()) {
      if (trajectory.statsAccumulators) {
        accumulators.push(...trajectory.statsAccumulators);
      }
    }
    return accumulators;
  }

  /** All enrichment providers from all registered trajectories (for ingest layer). */
  getAllEnrichmentProviders(): EnrichmentProvider[] {
    return [...this.trajectories.values()]
      .filter((t): t is Trajectory & { enrichment: EnrichmentProvider } => t.enrichment !== undefined)
      .map((t) => t.enrichment);
  }

  /**
   * Build a Qdrant filter from typed params using registered FilterDescriptors.
   *
   * Iterates all registered filters. For each filter whose `param`
   * exists in `params` with a defined, non-null value, calls
   * `filter.toCondition(value, level)` and collects conditions into `must`.
   *
   * @param level - Payload level for level-aware filters (default: "chunk")
   * @returns `{ must: [...conditions] }` or `undefined` if no conditions generated
   */
  buildFilter(params: Record<string, unknown>, level: FilterLevel = "chunk"): QdrantFilter | undefined {
    const allFilters = this.getAllFilters();
    const mustConditions: QdrantFilterCondition[] = [];
    const mustNotConditions: QdrantFilterCondition[] = [];

    for (const filter of allFilters) {
      const value = params[filter.param];
      if (value === undefined || value === null) continue;
      const result = filter.toCondition(value, level);
      if (result.must) mustConditions.push(...result.must);
      if (result.must_not) mustNotConditions.push(...result.must_not);
    }

    if (mustConditions.length === 0 && mustNotConditions.length === 0) return undefined;

    const filter: QdrantFilter = {};
    if (mustConditions.length > 0) filter.must = mustConditions;
    if (mustNotConditions.length > 0) filter.must_not = mustNotConditions;
    return filter;
  }

  /**
   * Build typed filter from params and merge with raw Qdrant filter.
   *
   * Combines registry's typed filter output with a user-provided raw filter.
   * Used by ExploreFacade to avoid owning merge logic.
   */
  buildMergedFilter(
    typedParams: Record<string, unknown>,
    rawFilter?: Record<string, unknown>,
    level: FilterLevel = "chunk",
  ): Record<string, unknown> | undefined {
    const typed = this.buildFilter(typedParams, level);
    return mergeQdrantFilters(typed, rawFilter as QdrantFilter | undefined) as Record<string, unknown> | undefined;
  }
}
