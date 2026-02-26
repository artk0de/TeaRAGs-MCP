/**
 * TrajectoryRegistry — API facade that collects signals, filters,
 * presets, and field docs from registered trajectory providers.
 *
 * The query layer (search facade, MCP tools) uses this registry
 * to build Qdrant filters, resolve rerank presets, and generate
 * dynamic tool schemas — all without knowing which specific
 * trajectory providers are active.
 */

import type {
  FilterDescriptor,
  FilterLevel,
  QdrantFilter,
  QdrantFilterCondition,
  ScoringWeights,
  Signal,
  TrajectoryQueryContract,
} from "./index.js";

export class TrajectoryRegistry {
  private readonly contracts: Map<string, TrajectoryQueryContract> = new Map();

  /**
   * Register a trajectory's query contract by provider key.
   *
   * Later registrations override earlier ones for same-named presets.
   */
  register(key: string, contract: TrajectoryQueryContract): void {
    this.contracts.set(key, contract);
  }

  /** All signals from all registered trajectories (no deduplication) */
  getAllSignals(): Signal[] {
    const signals: Signal[] = [];
    for (const contract of this.contracts.values()) {
      signals.push(...contract.signals);
    }
    return signals;
  }

  /** All filters from all registered trajectories */
  getAllFilters(): FilterDescriptor[] {
    const filters: FilterDescriptor[] = [];
    for (const contract of this.contracts.values()) {
      filters.push(...contract.filters);
    }
    return filters;
  }

  /**
   * Merged presets across all providers.
   *
   * If two trajectories define a preset with the same name,
   * the later registration wins (Map iteration order = insertion order).
   */
  getAllPresets(): Record<string, ScoringWeights> {
    const merged: Record<string, ScoringWeights> = {};
    for (const contract of this.contracts.values()) {
      Object.assign(merged, contract.presets);
    }
    return merged;
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
    const conditions: QdrantFilterCondition[] = [];

    for (const filter of allFilters) {
      const value = params[filter.param];
      if (value === undefined || value === null) continue;
      const produced = filter.toCondition(value, level);
      conditions.push(...produced);
    }

    if (conditions.length === 0) return undefined;
    return { must: conditions };
  }

  /** Get registered provider keys */
  getRegisteredKeys(): string[] {
    return [...this.contracts.keys()];
  }

  /** Check if a specific trajectory is registered */
  has(key: string): boolean {
    return this.contracts.has(key);
  }
}
