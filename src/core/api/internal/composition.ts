/**
 * Composition root — assembles the full application graph from trajectories.
 *
 * Uses TrajectoryRegistry to aggregate payloadSignals, derivedSignals,
 * filters, and presets from all registered trajectories. The only place
 * that knows which trajectories exist.
 */

import type { LanguageFactory } from "../../contracts/types/language.js";
import type { DerivedSignalDescriptor, RerankPreset } from "../../contracts/types/reranker.js";
import type { StatsAccumulatorDescriptor } from "../../contracts/types/stats-accumulator.js";
import type { PayloadSignalDescriptor } from "../../contracts/types/trajectory.js";
import { LanguageFactoryImpl } from "../../domains/language/index.js";
import { resolvePresets } from "../../domains/explore/rerank/presets/index.js";
import { Reranker } from "../../domains/explore/reranker.js";
import { validateSignalDependencies } from "../../domains/ingest/infra/collection-stats.js";
import { createCodegraphTrajectories, type CodegraphDeps } from "../../domains/trajectory/codegraph/index.js";
import { buildCompositePresets } from "../../domains/trajectory/composite/presets/index.js";
import { GitTrajectory } from "../../domains/trajectory/git.js";
import type { SquashOptions } from "../../domains/trajectory/git/infra/metrics.js";
import type { GitProviderConfig } from "../../domains/trajectory/git/provider.js";
import { TrajectoryRegistry } from "../../domains/trajectory/index.js";
import { StaticTrajectory } from "../../domains/trajectory/static/index.js";
import { buildLegacyLanguageRegistry } from "./legacy-language-adapter.js";

export interface CompositionResult {
  registry: TrajectoryRegistry;
  reranker: Reranker;
  allPayloadSignalDescriptors: PayloadSignalDescriptor[];
  allDerivedSignals: DerivedSignalDescriptor[];
  allStatsAccumulators: StatsAccumulatorDescriptor[];
  resolvedPresets: RerankPreset[];
  /**
   * Real `LanguageFactory` backed by the composition-root hybrid adapter
   * (`buildLegacyLanguageRegistry`) — wraps the legacy per-language maps into
   * `LanguageProvider`s without relocating code (spec §5, bd tea-rags-mcp-cat4).
   * Injected into the codegraph provider (walker + resolver capabilities). The
   * chunker worker is a SECOND composition root that builds its own factory
   * (functions can't cross the worker boundary). This instance carries the
   * codegraph resolvers.
   */
  languageFactory: LanguageFactory;
}

export interface CompositionOptions {
  /**
   * Git trajectory provider configuration. The GitEnrichmentProvider is
   * constructed inside GitTrajectory at composition time so the registry's
   * `getAllEnrichmentProviders()` returns a fully-configured provider —
   * IngestFacade consumes the registry list directly (no inline
   * construction). When omitted, GitTrajectory wires with default config.
   */
  git?: { config?: Partial<GitProviderConfig>; squashOpts?: SquashOptions };
  /**
   * When provided, registers the codegraph L1 family (Slice 1: Symbols).
   * Bootstrap supplies these deps when `CODEGRAPH_ENABLED` is true; tests
   * pass them directly. Omitting opts the family out — the rest of the
   * composition is unaffected.
   */
  codegraph?: CodegraphDeps;
}

export function createComposition(options: CompositionOptions = {}): CompositionResult {
  // Real LanguageFactory via the legacy adapter (composition-root hybrid, spec
  // §5). When codegraph is enabled its resolvers back each provider's `resolver`
  // capability; otherwise providers are walker/chunker-only. Built before the
  // codegraph trajectory so it can be injected into the codegraph provider.
  const languageFactory = new LanguageFactoryImpl(
    buildLegacyLanguageRegistry(options.codegraph?.resolvers),
  );

  const registry = new TrajectoryRegistry();
  registry.register(new StaticTrajectory());
  registry.register(new GitTrajectory(options.git?.config, options.git?.squashOpts));
  if (options.codegraph) {
    for (const trajectory of createCodegraphTrajectories({ ...options.codegraph, languageFactory })) {
      registry.register(trajectory);
    }
  }

  const allPayloadSignalDescriptors = registry.getAllPayloadSignalDescriptors();
  // Fail-loud at composition time: if any descriptor's confidence block
  // references a percentile that the support signal doesn't declare
  // (neither stats.labels nor stats.percentilesToCompute), this throws.
  // Prevents silent fallback to rule.fallback in production due to
  // misconfigured wiring. See `validateSignalDependencies` for details.
  validateSignalDependencies(allPayloadSignalDescriptors);
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
