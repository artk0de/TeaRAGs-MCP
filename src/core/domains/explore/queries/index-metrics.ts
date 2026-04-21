/**
 * IndexMetricsQuery — aggregates collection-level signal statistics and
 * distributions for the get_index_metrics MCP tool.
 *
 * Extracted from ExploreFacade.getIndexMetrics. Scrolls nothing directly —
 * reads cached stats from StatsCache, cross-references PayloadSignalDescriptor
 * labels, and folds per-language / per-scope stats into the response shape.
 */

import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import type { IndexMetrics, SignalMetrics } from "../../../api/public/dto/index.js";
import type { PayloadSignalDescriptor, SignalStats } from "../../../contracts/types/trajectory.js";
import type { StatsCache } from "../../../infra/stats-cache.js";
import { INDEXING_METADATA_ID } from "../../ingest/constants.js";
import { NotIndexedError } from "../../ingest/errors.js";
import { mapMarkerToHealth } from "../../ingest/pipeline/enrichment/health-mapper.js";
import type { EnrichmentMarkerMap } from "../../ingest/pipeline/enrichment/types.js";
import { CollectionNotFoundError } from "../errors.js";

export class IndexMetricsQuery {
  constructor(
    private readonly qdrant: QdrantManager,
    private readonly statsCache: StatsCache,
    private readonly payloadSignals: PayloadSignalDescriptor[],
  ) {}

  async run(collectionName: string, sourcePath: string): Promise<IndexMetrics> {
    if (!(await this.qdrant.collectionExists(collectionName))) {
      throw new CollectionNotFoundError(collectionName);
    }

    const stats = this.statsCache.load(collectionName);
    if (!stats) {
      throw new NotIndexedError(sourcePath);
    }

    const collectionInfo = await this.qdrant.getCollectionInfo(collectionName);
    const signals = this.buildLanguageSignals(stats.perLanguage);
    this.appendGlobalSignalsIfPolyglot(signals, stats.perLanguage, stats.perSignal);

    const enrichment = await this.loadEnrichmentHealth(collectionName);

    return {
      collection: collectionName,
      totalChunks: collectionInfo.pointsCount,
      totalFiles: stats.distributions.totalFiles,
      distributions: stats.distributions,
      signals,
      enrichment,
    };
  }

  private buildSignalMetrics(perSignal: Map<string, SignalStats>): Record<string, SignalMetrics> {
    const result: Record<string, SignalMetrics> = {};
    for (const [key, signalStats] of perSignal) {
      const descriptor = this.payloadSignals.find((d) => d.key === key);
      if (!descriptor?.stats?.labels) continue;

      const labelMap: Record<string, number> = {};
      for (const [pKey, labelName] of Object.entries(descriptor.stats.labels)) {
        const p = Number(pKey.slice(1));
        const threshold = signalStats.percentiles[p];
        if (threshold !== undefined) {
          labelMap[labelName] = threshold;
        }
      }

      result[key] = {
        min: signalStats.min,
        max: signalStats.max,
        mean: signalStats.mean,
        count: signalStats.count,
        labelMap,
      };
    }
    return result;
  }

  private buildLanguageSignals(
    perLanguage: Map<string, Map<string, { source: SignalStats; test?: SignalStats }>> | undefined,
  ): Record<string, Record<string, Record<string, SignalMetrics>>> {
    const signals: Record<string, Record<string, Record<string, SignalMetrics>>> = {};
    if (!perLanguage) return signals;

    for (const [lang, langStats] of perLanguage) {
      const langSignals: Record<string, Record<string, SignalMetrics>> = {};
      for (const [key, scopedStats] of langStats) {
        const scoped: Record<string, SignalMetrics> = {};
        const sourceMetrics = this.buildSignalMetrics(new Map([[key, scopedStats.source]]));
        if (sourceMetrics[key]) {
          scoped["source"] = sourceMetrics[key];
        }
        if (scopedStats.test) {
          const testMetrics = this.buildSignalMetrics(new Map([[key, scopedStats.test]]));
          if (testMetrics[key]) {
            scoped["test"] = testMetrics[key];
          }
        }
        if (Object.keys(scoped).length > 0) {
          langSignals[key] = scoped;
        }
      }
      if (Object.keys(langSignals).length > 0) {
        signals[lang] = langSignals;
      }
    }
    return signals;
  }

  /** Attach a "global" bucket only for polyglot projects (>1 code language). */
  private appendGlobalSignalsIfPolyglot(
    signals: Record<string, Record<string, Record<string, SignalMetrics>>>,
    perLanguage: Map<string, Map<string, unknown>> | undefined,
    perSignal: Map<string, SignalStats>,
  ): void {
    const codeLanguageCount = perLanguage?.size ?? 0;
    if (codeLanguageCount === 1) return;

    const globalMetrics = this.buildSignalMetrics(perSignal);
    const globalScoped: Record<string, Record<string, SignalMetrics>> = {};
    for (const [key, metrics] of Object.entries(globalMetrics)) {
      globalScoped[key] = { source: metrics };
    }
    signals["global"] = globalScoped;
  }

  private async loadEnrichmentHealth(collectionName: string): Promise<IndexMetrics["enrichment"]> {
    const markerPoint = await this.qdrant.getPoint(collectionName, INDEXING_METADATA_ID).catch(() => null);
    const rawEnrichment = markerPoint?.payload?.enrichment as EnrichmentMarkerMap | undefined;
    return rawEnrichment ? mapMarkerToHealth(rawEnrichment) : undefined;
  }
}
