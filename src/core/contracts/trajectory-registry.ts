/**
 * TrajectoryRegistry — single registry for enrichment providers.
 *
 * Collects signals, filters, presets, and field docs from registered
 * EnrichmentProvider instances. The query layer (search facade, MCP tools)
 * uses this registry to build Qdrant filters, resolve rerank presets,
 * and generate dynamic tool schemas — all without knowing which
 * specific trajectory providers are active.
 *
 * The ingest layer uses getAll() to obtain providers for enrichment.
 */

import type {
  DerivedSignalDescriptor,
  EnrichmentProvider,
  FilterDescriptor,
  FilterLevel,
  QdrantFilter,
  QdrantFilterCondition,
  ScoringWeights,
  Signal,
} from "./index.js";

export class TrajectoryRegistry {
  private readonly providers: Map<string, EnrichmentProvider> = new Map();

  /**
   * Register an enrichment provider by its key.
   *
   * Later registrations override earlier ones for the same key.
   * Throws if a derived signal name conflicts with another provider.
   */
  register(provider: EnrichmentProvider): void {
    // Check for derived signal name conflicts with existing providers
    const existingNames = new Set<string>();
    for (const [key, existing] of this.providers) {
      if (key === provider.key) continue; // Skip self (override allowed)
      for (const d of existing.derivedSignals) {
        existingNames.add(d.name);
      }
    }
    for (const d of provider.derivedSignals) {
      if (existingNames.has(d.name)) {
        throw new Error(
          `Derived signal name conflict: "${d.name}" is already registered by another provider. ` +
            `Provider "${provider.key}" cannot register a duplicate.`,
        );
      }
    }
    this.providers.set(provider.key, provider);
  }

  /** All registered providers (for ingest layer). */
  getAll(): EnrichmentProvider[] {
    return [...this.providers.values()];
  }

  /** All signals from all registered providers (no deduplication) */
  getAllSignals(): Signal[] {
    const signals: Signal[] = [];
    for (const provider of this.providers.values()) {
      signals.push(...provider.signals);
    }
    return signals;
  }

  /** All filters from all registered providers */
  getAllFilters(): FilterDescriptor[] {
    const filters: FilterDescriptor[] = [];
    for (const provider of this.providers.values()) {
      filters.push(...provider.filters);
    }
    return filters;
  }

  /**
   * Merged presets across all providers.
   *
   * If two providers define a preset with the same name,
   * the later registration wins (Map iteration order = insertion order).
   */
  getAllPresets(): Record<string, ScoringWeights> {
    const merged: Record<string, ScoringWeights> = {};
    for (const provider of this.providers.values()) {
      Object.assign(merged, provider.presets);
    }
    return merged;
  }

  /**
   * All derived signal descriptors from all registered providers.
   * Uniqueness is enforced at registration time (fail-fast on duplicate names).
   */
  getAllDerivedSignals(): DerivedSignalDescriptor[] {
    const signals: DerivedSignalDescriptor[] = [];
    for (const provider of this.providers.values()) {
      signals.push(...provider.derivedSignals);
    }
    return signals;
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
    return [...this.providers.keys()];
  }

  /** Check if a specific provider is registered */
  has(key: string): boolean {
    return this.providers.has(key);
  }
}
