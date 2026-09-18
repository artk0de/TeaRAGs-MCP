/**
 * Preset DEFAULT filter vs an explicit caller scope (tea-rags-mcp-9mwny).
 *
 * Most analytics presets ship `filter: { presets: "production" }` — a hygiene
 * default for unscoped searches (no tests, no docs, no catch-all blocks). A
 * caller who explicitly scopes the search to tests (`testFile: "only"`,
 * `chunkType: "test" | "test_setup"`) or docs (`documentation: "only"`) used
 * to get the default AND-ed on top, i.e. 0 results by construction. Invariant:
 * a preset default that excludes the population the caller's typed params
 * select is dropped; an explicit caller `filter` keeps its precedence.
 *
 * Observable surface: the Qdrant filter ExploreFacade.semanticSearch sends.
 */

import { describe, expect, it, vi } from "vitest";

import { ExploreFacade } from "../../../../src/core/api/internal/facades/explore-facade.js";
import type { RerankPreset } from "../../../../src/core/contracts/types/reranker.js";
import {
  BugHuntCompositePreset,
  OwnershipCompositePreset,
} from "../../../../src/core/domains/trajectory/composite/presets/index.js";
import { TechDebtPreset } from "../../../../src/core/domains/trajectory/git/rerank/presets/tech-debt.js";
import { TrajectoryRegistry } from "../../../../src/core/domains/trajectory/index.js";
import { STATIC_FILTER_PRESETS } from "../../../../src/core/domains/trajectory/static/filter-presets/index.js";
import { StaticTrajectory } from "../../../../src/core/domains/trajectory/static/index.js";
import { DecompositionPreset } from "../../../../src/core/domains/trajectory/static/rerank/presets/decomposition.js";

const PRESETS: Record<string, RerankPreset> = {
  bugHunt: new BugHuntCompositePreset() as unknown as RerankPreset,
  techDebt: new TechDebtPreset(),
  ownership: new OwnershipCompositePreset() as unknown as RerankPreset,
  // The static decomposition preset ships the coreLogic default (function/class only).
  decomposition: new DecompositionPreset(),
};

const EXCLUDE_TESTS = { key: "isTest", match: { value: true } };
const SELECT_TESTS = { key: "isTest", match: { value: true } };

function makeFacade() {
  const sentFilters: unknown[] = [];
  const capture = (filter: unknown) => {
    sentFilters.push(filter);
    return [];
  };
  const qdrant = {
    collectionExists: vi.fn().mockResolvedValue(true),
    search: vi.fn(async (_c: string, _v: number[], _l: number, filter: unknown) => capture(filter)),
    queryGroups: vi.fn(async (_c: string, _v: number[], opts: { filter?: unknown }) => capture(opts.filter)),
    getCollectionInfo: vi.fn().mockResolvedValue({ hybridEnabled: false }),
    ensurePayloadIndex: vi.fn(),
  } as any;
  const reranker = {
    rerank: vi.fn((results: unknown[]) => results),
    hasCollectionStats: false,
    setCollectionStats: vi.fn(),
    getCollectionStats: vi.fn().mockReturnValue(undefined),
    getDescriptors: vi.fn().mockReturnValue([]),
    getFullPreset: vi.fn((name: string) => PRESETS[name]),
    getPreset: vi.fn(),
    getPresetNames: vi.fn().mockReturnValue(Object.keys(PRESETS)),
  } as any;
  const registry = new TrajectoryRegistry();
  registry.register(new StaticTrajectory());
  registry.setFilterPresets(STATIC_FILTER_PRESETS);
  const facade = new ExploreFacade({
    qdrant,
    embeddings: { embed: vi.fn().mockResolvedValue({ embedding: [0.1, 0.2] }) } as any,
    reranker,
    registry,
  });
  return { facade, sentFilters };
}

async function sentFilter(request: Record<string, unknown>): Promise<any> {
  const { facade, sentFilters } = makeFacade();
  await facade.semanticSearch({ collection: "col", query: "q", ...request } as any);
  expect(sentFilters).toHaveLength(1);
  return sentFilters[0];
}

describe("preset default filter yields to an explicit test / docs scope", () => {
  for (const preset of ["bugHunt", "techDebt", "ownership"]) {
    it(`${preset}: default still excludes tests on an unscoped search`, async () => {
      const filter = await sentFilter({ rerank: preset });
      expect(filter.must_not).toContainEqual(EXCLUDE_TESTS);
    });

    it(`${preset}: testFile "only" drops the production default instead of returning nothing`, async () => {
      const filter = await sentFilter({ rerank: preset, testFile: "only" });
      expect(filter.must).toContainEqual(SELECT_TESTS);
      expect(filter.must_not ?? []).not.toContainEqual(EXCLUDE_TESTS);
    });

    it(`${preset}: chunkType "test_setup" drops the production default`, async () => {
      const filter = await sentFilter({ rerank: preset, chunkType: "test_setup" });
      expect(filter.must).toContainEqual({ key: "chunkType", match: { value: "test_setup" } });
      expect(filter.must_not ?? []).not.toContainEqual(EXCLUDE_TESTS);
    });
  }

  it("documentation 'only' drops a default that excludes documentation", async () => {
    const filter = await sentFilter({ rerank: "techDebt", documentation: "only" });
    expect(filter.must).toContainEqual({ key: "isDocumentation", match: { value: true } });
    expect(filter.must_not ?? []).not.toContainEqual({ key: "isDocumentation", match: { value: true } });
  });

  it("a coreLogic default (function/class only) yields to chunkType 'test'", async () => {
    const filter = await sentFilter({ rerank: "decomposition", chunkType: "test" });
    expect(filter.must).toEqual([{ key: "chunkType", match: { value: "test" } }]);
    expect(filter.must_not).toBeUndefined();
  });

  it("a scope the default does NOT exclude keeps the default (chunkType 'function' + techDebt)", async () => {
    const filter = await sentFilter({ rerank: "techDebt", chunkType: "function" });
    expect(filter.must).toContainEqual({ key: "chunkType", match: { value: "function" } });
    expect(filter.must_not).toContainEqual(EXCLUDE_TESTS);
  });

  it("an explicit caller filter keeps its precedence even when it contradicts the scope", async () => {
    const filter = await sentFilter({ rerank: "techDebt", testFile: "only", filter: { presets: "production" } });
    expect(filter.must).toContainEqual(SELECT_TESTS);
    expect(filter.must_not).toContainEqual(EXCLUDE_TESTS);
  });
});
