/**
 * bugHunt and dangerous rank at FILE level by default (bd tea-rags-mcp-9z8ae,
 * owner decision option A). Their weights were calibrated on a file-level
 * backtest (label = the file receives a bug-fix commit within 90/180 days), so
 * the default ranking unit is the file. An explicit caller `level: "chunk"`
 * still wins over the preset's `signalLevel`.
 */

import { describe, expect, it, vi } from "vitest";

import { ExploreFacade } from "../../../../src/core/api/index.js";
import {
  BugHuntCompositePreset,
  DangerousCompositePreset,
} from "../../../../src/core/api/internal/composite-presets/index.js";
import type { RerankPreset } from "../../../../src/core/contracts/types/reranker.js";
import { BugHuntPreset } from "../../../../src/core/domains/trajectory/git/rerank/presets/bug-hunt.js";
import { DangerousPreset } from "../../../../src/core/domains/trajectory/git/rerank/presets/dangerous.js";
import { TrajectoryRegistry } from "../../../../src/core/domains/trajectory/index.js";
import { STATIC_FILTER_PRESETS } from "../../../../src/core/domains/trajectory/static/filter-presets/index.js";
import { StaticTrajectory } from "../../../../src/core/domains/trajectory/static/index.js";

const PRESET_CLASSES: Record<string, RerankPreset> = {
  "git bugHunt": new BugHuntPreset(),
  "composite bugHunt": new BugHuntCompositePreset(),
  "git dangerous": new DangerousPreset(),
  "composite dangerous": new DangerousCompositePreset(),
};

function makeFacade(preset: RerankPreset) {
  const qdrant = {
    collectionExists: vi.fn().mockResolvedValue(true),
    search: vi.fn().mockResolvedValue([]),
    queryGroups: vi.fn().mockResolvedValue([]),
    getCollectionInfo: vi.fn().mockResolvedValue({ hybridEnabled: false }),
    ensurePayloadIndex: vi.fn(),
  } as any;
  const reranker = {
    rerank: vi.fn((results: unknown[]) => results),
    hasCollectionStats: false,
    setCollectionStats: vi.fn(),
    getCollectionStats: vi.fn().mockReturnValue(undefined),
    getDescriptors: vi.fn().mockReturnValue([]),
    getFullPreset: vi.fn((name: string) => (name === preset.name ? preset : undefined)),
    getPreset: vi.fn(),
    getPresetNames: vi.fn().mockReturnValue([preset.name]),
  } as any;
  const registry = new TrajectoryRegistry();
  registry.register(new StaticTrajectory());
  registry.setFilterPresets(STATIC_FILTER_PRESETS);
  const facade = new ExploreFacade({
    qdrant,
    embeddings: { embed: vi.fn().mockResolvedValue({ embedding: [0.1, 0.2] }) } as any,
    reranker,
    registry,
  } as any);
  return { facade, qdrant };
}

describe("bugHunt and dangerous default to file level (9z8ae option A)", () => {
  for (const [label, preset] of Object.entries(PRESET_CLASSES)) {
    it(`${label} declares signalLevel "file"`, () => {
      expect(preset.signalLevel).toBe("file");
    });

    it(`${label}: an unleveled semantic_search groups by file`, async () => {
      const { facade, qdrant } = makeFacade(preset);
      await facade.semanticSearch({ collection: "col", query: "q", rerank: preset.name });
      expect(qdrant.queryGroups).toHaveBeenCalledTimes(1);
      expect(qdrant.search).not.toHaveBeenCalled();
    });

    it(`${label}: an explicit level "chunk" still overrides the preset`, async () => {
      const { facade, qdrant } = makeFacade(preset);
      await facade.semanticSearch({ collection: "col", query: "q", rerank: preset.name, level: "chunk" });
      expect(qdrant.search).toHaveBeenCalledTimes(1);
      expect(qdrant.queryGroups).not.toHaveBeenCalled();
    });
  }
});
