// tests/bootstrap/factory-codegraph-fallback.test.ts
import { describe, expect, it, vi } from "vitest";

import { createSymbolChunkResolver } from "../../src/bootstrap/factory.js";

describe("createSymbolChunkResolver", () => {
  it("returns an adapter that delegates to graphFacade.resolveSymbolChunk with collection triad", async () => {
    const mockResult = { chunkId: "chunk_abc", collectionName: "col" };
    const graphFacade = {
      resolveSymbolChunk: vi.fn().mockResolvedValue(mockResult),
    } as unknown as Parameters<typeof createSymbolChunkResolver>[0];

    const adapter = createSymbolChunkResolver(graphFacade);

    expect(adapter).toBeDefined();
    const result = await adapter!.resolveSymbolChunk("col", "Foo#bar");

    expect(graphFacade!.resolveSymbolChunk).toHaveBeenCalledWith({ collection: "col" }, "Foo#bar");
    expect(result).toEqual(mockResult);
  });

  it("returns undefined when graphFacade is undefined", () => {
    const adapter = createSymbolChunkResolver(undefined);
    expect(adapter).toBeUndefined();
  });
});
