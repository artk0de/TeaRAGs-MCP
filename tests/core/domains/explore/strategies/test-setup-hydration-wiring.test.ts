/**
 * Test setup hydration through the explore strategies (bd tea-rags-mcp-5xpq4):
 * an example chunk a search or find_symbol returns carries its scope setup
 * again, a metaOnly answer does not pay for it, and a member of a grouped tiny
 * example chunk is still addressable by its own id.
 */

import { describe, expect, it, vi } from "vitest";

import type { QdrantManager } from "../../../../../src/core/adapters/qdrant/client.js";
import type { Reranker } from "../../../../../src/core/domains/explore/reranker.js";
import { ScrollRankStrategy } from "../../../../../src/core/domains/explore/strategies/scroll-rank.js";
import { SymbolSearchStrategy } from "../../../../../src/core/domains/explore/strategies/symbol.js";
import { VectorSearchStrategy } from "../../../../../src/core/domains/explore/strategies/vector.js";

const SPEC = "spec/models/user_spec.rb";
const ROOT = "User.RSpec.describe User";
const EXAMPLE = `${ROOT}.it 'can invite'`;

const reranker = {
  rerank: vi.fn((r: unknown[]) => r),
  getDescriptors: vi.fn().mockReturnValue([]),
  getFullPreset: vi.fn().mockReturnValue(undefined),
  getPreset: vi.fn().mockReturnValue(undefined),
} as unknown as Reranker;

const examplePayload = {
  symbolId: EXAMPLE,
  name: "it 'can invite'",
  parentSymbolId: ROOT,
  parentType: "test_scope",
  chunkType: "test",
  relativePath: SPEC,
  startLine: 4,
  endLine: 6,
  content: "RSpec.describe User do\nit 'can invite' do\n  expect(user.invite).to be(true)\nend",
  setupScopeIds: [ROOT],
};

const setupPoint = {
  id: "setup-1",
  payload: { symbolId: ROOT, relativePath: SPEC, content: "RSpec.describe User do\nlet(:user) { create(:user) }" },
};

const HYDRATED = [
  "RSpec.describe User do",
  "let(:user) { create(:user) }",
  "it 'can invite' do",
  "  expect(user.invite).to be(true)",
  "end",
].join("\n");

const isSetupFetch = (filter: Record<string, unknown>) => JSON.stringify(filter).includes('"test_setup"');

describe("test setup hydration in explore strategies", () => {
  it("semantic_search (base postProcess) returns an example with its setup prepended, in one fetch", async () => {
    const scrollFiltered = vi.fn().mockResolvedValue([setupPoint]);
    const qdrant = {
      search: vi.fn().mockResolvedValue([{ id: "ex-1", score: 0.9, payload: examplePayload }]),
      scrollFiltered,
    } as unknown as QdrantManager;

    const [hit] = await new VectorSearchStrategy(qdrant, reranker, [], []).execute({
      collectionName: "code_x",
      embedding: [0.1],
      limit: 5,
    });

    expect(hit.payload?.content).toBe(HYDRATED);
    expect(scrollFiltered).toHaveBeenCalledTimes(1);
  });

  it("skips hydration on a metaOnly answer", async () => {
    const scrollFiltered = vi.fn().mockResolvedValue([setupPoint]);
    const qdrant = {
      search: vi.fn().mockResolvedValue([{ id: "ex-1", score: 0.9, payload: examplePayload }]),
      scrollFiltered,
    } as unknown as QdrantManager;

    await new VectorSearchStrategy(qdrant, reranker, [], []).execute({
      collectionName: "code_x",
      embedding: [0.1],
      limit: 5,
      metaOnly: true,
    });

    expect(scrollFiltered).not.toHaveBeenCalled();
  });

  it("rank_chunks with metaOnly=false hydrates the ranked examples", async () => {
    const scrollFiltered = vi.fn().mockResolvedValue([setupPoint]);
    const strategy = new ScrollRankStrategy({ scrollFiltered } as unknown as QdrantManager, reranker, [], []);
    const hydrated = await (
      strategy as unknown as {
        postProcess: (r: unknown[], ctx: unknown) => Promise<{ payload?: Record<string, unknown> }[]>;
      }
    ).postProcess([{ id: "ex-1", score: 1, payload: examplePayload }], {
      collectionName: "code_x",
      limit: 5,
      metaOnly: false,
    });

    expect(hydrated[0].payload?.content).toBe(HYDRATED);
  });

  it("find_symbol on an example id returns the example runnable in the head", async () => {
    const scrollFiltered = vi.fn(async (_c: string, filter: Record<string, unknown>) => {
      if (isSetupFetch(filter)) return [setupPoint];
      return JSON.stringify(filter).includes('"symbolId"') ? [{ id: "ex-1", payload: examplePayload }] : [];
    });
    const qdrant = { scrollFiltered } as unknown as QdrantManager;
    const registry = { buildMergedFilter: vi.fn() } as never;

    const [result] = await new SymbolSearchStrategy(qdrant, reranker, [], [], registry, { symbol: EXAMPLE }).execute({
      collectionName: "code_x",
      limit: 50,
    });

    expect(result.payload?.symbolId).toBe(EXAMPLE);
    expect(result.payload?.content).toBe(HYDRATED);
  });

  it("find_symbol on a grouped tiny example's id returns the group chunk that carries it", async () => {
    const groupId = `${ROOT}.it`;
    const memberId = `${ROOT}.it~2`;
    const group = {
      id: "grp-1",
      payload: {
        ...examplePayload,
        symbolId: groupId,
        name: "it",
        content: "RSpec.describe User do\nit { is_expected.to be_valid }\nit { is_expected.to be_persisted }",
        exampleSymbolIds: [groupId, memberId],
        setupScopeIds: undefined,
      },
    };
    const scrollFiltered = vi.fn(async (_c: string, filter: Record<string, unknown>) =>
      JSON.stringify(filter).includes('"exampleSymbolIds"') ? [group] : [],
    );
    const qdrant = { scrollFiltered } as unknown as QdrantManager;
    const registry = { buildMergedFilter: vi.fn() } as never;

    const results = await new SymbolSearchStrategy(qdrant, reranker, [], [], registry, { symbol: memberId }).execute({
      collectionName: "code_x",
      limit: 50,
    });

    expect(results.map((r) => r.payload?.content)).toEqual([group.payload.content]);
    const memberFetch = scrollFiltered.mock.calls.find(([, f]) => JSON.stringify(f).includes('"exampleSymbolIds"'));
    expect(memberFetch?.[1]).toMatchObject({ must: [{ key: "exampleSymbolIds", match: { value: memberId } }] });
  });
});
