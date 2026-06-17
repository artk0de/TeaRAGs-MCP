/**
 * Composition root — assembles the full application graph from trajectories.
 *
 * Uses TrajectoryRegistry to aggregate payloadSignals, derivedSignals,
 * filters, and presets from all registered trajectories. The only place
 * that knows which trajectories exist.
 */

import type { FilterPresetDef } from "../../contracts/types/filter-preset.js";
import type { LanguageFactoryDescriptor } from "../../contracts/types/language.js";
import type { WorkerEnrichmentDescriptor } from "../../contracts/types/provider.js";
import type { DerivedSignalDescriptor, RerankPreset } from "../../contracts/types/reranker.js";
import type { StatsAccumulatorDescriptor } from "../../contracts/types/stats-accumulator.js";
import type { PayloadSignalDescriptor } from "../../contracts/types/trajectory.js";
import { resolvePresets } from "../../domains/explore/rerank/presets/index.js";
import { Reranker } from "../../domains/explore/reranker.js";
import { validateSignalDependencies } from "../../domains/ingest/infra/collection-stats.js";
import { LanguageFactory } from "../../domains/language/index.js";
import { createCodegraphTrajectories, type CodegraphDeps } from "../../domains/trajectory/codegraph/index.js";
import { CODEGRAPH_FILTER_PRESETS } from "../../domains/trajectory/codegraph/symbols/filter-presets/index.js";
import { buildCompositeFilterPresets } from "../../domains/trajectory/composite/filter-presets/index.js";
import { buildCompositePresets } from "../../domains/trajectory/composite/presets/index.js";
import { GitTrajectory } from "../../domains/trajectory/git.js";
import { GIT_FILTER_PRESETS } from "../../domains/trajectory/git/filter-presets/index.js";
import type { SquashOptions } from "../../domains/trajectory/git/infra/metrics.js";
import type { GitProviderConfig } from "../../domains/trajectory/git/provider.js";
import { TrajectoryRegistry } from "../../domains/trajectory/index.js";
import { STATIC_FILTER_PRESETS } from "../../domains/trajectory/static/filter-presets/index.js";
import { StaticTrajectory } from "../../domains/trajectory/static/index.js";

export interface CompositionResult {
  registry: TrajectoryRegistry;
  reranker: Reranker;
  allPayloadSignalDescriptors: PayloadSignalDescriptor[];
  allDerivedSignals: DerivedSignalDescriptor[];
  allStatsAccumulators: StatsAccumulatorDescriptor[];
  resolvedPresets: RerankPreset[];
  /**
   * Real `LanguageFactoryDescriptor` — all languages are native `domains/language/<lang>`
   * providers built by the factory itself (the legacy per-language adapter was
   * removed by tea-rags-mcp-jh40 once every vertical migrated). Injected into the
   * codegraph provider (walker + resolver capabilities). The chunker worker is a
   * SECOND composition root that builds its own factory (functions can't cross
   * the worker boundary).
   */
  languageFactory: LanguageFactoryDescriptor;
}

export interface CompositionOptions {
  /**
   * Git trajectory provider configuration. The GitEnrichmentProvider is
   * constructed inside GitTrajectory at composition time so the registry's
   * `getAllEnrichmentProviders()` returns a fully-configured provider —
   * IngestFacade consumes the registry list directly (no inline
   * construction). When omitted, GitTrajectory wires with default config.
   */
  git?: {
    config?: Partial<GitProviderConfig>;
    squashOpts?: SquashOptions;
    /**
     * Worker-pool descriptor built by the bootstrap composition root (which
     * alone knows the absolute compiled-JS worker module path). When present,
     * the GitEnrichmentProvider surfaces it so `WorkerPoolEnrichmentExecutor`
     * dispatches git blame off-thread instead of inline. Omitted in tests ⇒
     * inline-only (graceful fallback). bd tea-rags-mcp-dz7f.
     */
    workerDescriptor?: WorkerEnrichmentDescriptor;
  };
  /**
   * When provided, registers the codegraph L1 family (Slice 1: Symbols).
   * Bootstrap supplies these deps when `CODEGRAPH_ENABLED` is true; tests
   * pass them directly. Omitting opts the family out — the rest of the
   * composition is unaffected.
   */
  codegraph?: CodegraphDeps;
}

/**
 * Assemble the gated filter-preset catalog for a composition.
 *
 * Static presets are always-on. Git presets gate on the "git" key;
 * codegraph presets gate on "codegraph.symbols". Composite presets gate
 * via `buildCompositeFilterPresets`, which drops any preset whose
 * `requires` references a non-registered trajectory key. Mirrors the
 * rerank-preset gating done by `buildCompositePresets`.
 */
export function assembleFilterPresets(registeredKeys: ReadonlySet<string>): FilterPresetDef[] {
  return [
    ...STATIC_FILTER_PRESETS,
    ...(registeredKeys.has("git") ? GIT_FILTER_PRESETS : []),
    ...(registeredKeys.has("codegraph.symbols") ? CODEGRAPH_FILTER_PRESETS : []),
    ...buildCompositeFilterPresets(registeredKeys),
  ];
}

export function createComposition(options: CompositionOptions = {}): CompositionResult {
  // Real LanguageFactoryDescriptor: it ENCAPSULATES construction. All languages are
  // native `domains/language/<lang>` providers built by the factory itself; each
  // native provider carries its own resolver, built with the configured
  // ambiguous-resolve mode (threaded via CodegraphDeps). Built before the
  // codegraph trajectory so it can be injected into the codegraph provider.
  const languageFactory = new LanguageFactory({
    ambiguousResolveMode: options.codegraph?.ambiguousResolveMode,
  });

  const registry = new TrajectoryRegistry();
  registry.register(new StaticTrajectory());
  registry.register(new GitTrajectory(options.git?.config, options.git?.squashOpts, options.git?.workerDescriptor));
  if (options.codegraph) {
    for (const trajectory of createCodegraphTrajectories({ ...options.codegraph, languageFactory })) {
      registry.register(trajectory);
    }
  }

  // Assemble + gate the filter-preset catalog by registered trajectory
  // keys, then load it into the registry (pure data owner). Done before
  // Reranker construction and before validateSignalDependencies so the
  // validation sees the REAL filter presets alongside the real descriptors.
  const filterPresets = assembleFilterPresets(new Set(registry.getRegisteredKeys()));
  registry.setFilterPresets(filterPresets);

  const allPayloadSignalDescriptors = registry.getAllPayloadSignalDescriptors();
  // Fail-loud at composition time: if any descriptor's confidence block
  // references a percentile that the support signal doesn't declare
  // (neither stats.labels nor stats.percentilesToCompute), this throws.
  // The filter presets are validated too — a filter preset referencing a
  // pN that the descriptor doesn't declare throws here. Prevents silent
  // fallback in production. See `validateSignalDependencies` for details.
  validateSignalDependencies(allPayloadSignalDescriptors, filterPresets);
  const allDerivedSignals = registry.getAllDerivedSignals();
  const allStatsAccumulators = registry.getAllStatsAccumulators();
  // Trajectory presets come from the registry (one trajectory per preset);
  // composite presets cross trajectories (e.g. blastRadius weights
  // codegraph.fanIn + git.churn) and live in their own namespace under
  // `domains/trajectory/composite/presets/`. The resolver merges by
  // (name, tools[i]) and the composite list wins, so composites override
  // trajectory presets of the same name without modifying them in place.
  // Gating: buildCompositePresets filters each composite against the
  // registered trajectory keys — a composite whose `requires` references
  // a non-registered trajectory is silently dropped.
  const compositePresets = buildCompositePresets(new Set(registry.getRegisteredKeys()));
  const resolvedPresets = resolvePresets(registry.getAllPresets(), compositePresets);
  const reranker = new Reranker(allDerivedSignals, resolvedPresets, allPayloadSignalDescriptors);
  // Passthrough the registered filter-preset names so the MCP schema layer
  // (SchemaBuilder) can surface them through its single Reranker dependency.
  reranker.setFilterPresetNames(registry.filterPresetNames());

  return {
    registry,
    reranker,
    allPayloadSignalDescriptors,
    allDerivedSignals,
    allStatsAccumulators,
    resolvedPresets,
    languageFactory,
  };
}
