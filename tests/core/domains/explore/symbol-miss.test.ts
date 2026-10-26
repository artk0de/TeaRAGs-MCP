/**
 * SymbolMissExplainer (agent turn economy N6): a single `symbol` that nothing
 * answered says why — `unknownSymbol`, with the real id when the address was
 * only written wrong (other `#`/`.` separator, a `#partN` window id).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ScrollChunk } from "../../../../src/core/domains/explore/chunk-grouping/types.js";
import { SymbolSearchStrategy } from "../../../../src/core/domains/explore/strategies/symbol.js";
import { SymbolMissExplainer } from "../../../../src/core/domains/explore/symbol-miss.js";
import { codeRow } from "./__fixtures__/working-tree-view.js";

describe("SymbolMissExplainer", () => {
  const mockScrollFiltered = vi.fn();
  const qdrant = { scrollFiltered: mockScrollFiltered, getPoint: vi.fn() } as any;
  const reranker = { rerank: vi.fn((r: any[]) => r) } as any;
  const registry = { buildMergedFilter: vi.fn().mockReturnValue(undefined) } as any;

  const indexHolds = (rows: ScrollChunk[]) => {
    mockScrollFiltered.mockImplementation(async (_c: string, filter: { must: any[] }) => {
      const [{ key, match }] = filter.must;
      return rows.filter((r) => {
        const v = r.payload[key];
        return (
          typeof v === "string" &&
          match.text !== undefined &&
          v.toLowerCase().includes(String(match.text).toLowerCase())
        );
      });
    });
  };

  const explainer = new SymbolMissExplainer(
    (symbol) => new SymbolSearchStrategy(qdrant, reranker, [], [], registry, { symbol }),
  );
  const explain = async (address: string) => explainer.explain(address, { collectionName: "c", limit: 50 });

  const row = (id: string, symbolId: string) =>
    codeRow(id, { symbolId, name: symbolId.split(/[#.]/).pop(), relativePath: "src/foo.ts", content: `${id} body` });

  beforeEach(() => {
    vi.clearAllMocks();
    indexHolds([row("m1", "Foo#bar"), row("m2", "Foo.create"), row("m3", "Other#create")]);
  });

  it("an address nothing resembles is unknownSymbol with a message and no suggestions", async () => {
    const empty = await explain("NoSuchThingAtAll");

    expect(empty.reason).toBe("unknownSymbol");
    expect(empty.message).toContain("NoSuchThingAtAll");
    expect(empty.suggestions).toBeUndefined();
  });

  it("the wrong separator suggests the swapped id that exists", async () => {
    const empty = await explain("Foo.bar");

    expect(empty.reason).toBe("unknownSymbol");
    expect(empty.suggestions).toEqual(["Foo#bar"]);
  });

  it("a #partN id whose parent exists suggests the parent", async () => {
    const empty = await explain("Foo#bar#part2");

    expect(empty.reason).toBe("unknownSymbol");
    expect(empty.suggestions).toEqual(["Foo#bar"]);
  });

  it("a member name defined elsewhere suggests the ids defined under that name", async () => {
    const empty = await explain("Missing#create");

    expect(empty.suggestions).toEqual(expect.arrayContaining(["Foo.create", "Other#create"]));
    expect(empty.suggestions!.length).toBeLessThanOrEqual(5);
  });
});
