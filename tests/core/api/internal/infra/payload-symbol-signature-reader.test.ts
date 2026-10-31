import { describe, expect, it, vi } from "vitest";

import { readPayloadSymbolSignatures } from "../../../../../src/core/api/internal/infra/payload-symbol-signature-reader.js";

type Scroll = (collection: string, ids: string[], limit: number) => Promise<{ payload: Record<string, unknown> }[]>;

function qdrantReturning(points: { payload: Record<string, unknown> }[]): {
  scrollBySymbolIds: ReturnType<typeof vi.fn<Scroll>>;
} {
  return { scrollBySymbolIds: vi.fn<Scroll>(async () => points) };
}

describe("readPayloadSymbolSignatures", () => {
  it("answers an empty map without touching the index when no ids are asked", async () => {
    const qdrant = qdrantReturning([]);
    const result = await readPayloadSymbolSignatures(qdrant as never, "col", []);
    expect(result.size).toBe(0);
    expect(qdrant.scrollBySymbolIds).not.toHaveBeenCalled();
  });

  it("derives each symbol's signature from its lowest-line chunk, in one deduplicated scroll", async () => {
    const qdrant = qdrantReturning([
      // second chunk of a split method: must lose to the first chunk
      { payload: { symbolId: "Svc#run", startLine: 30, content: "  const tail = 1;" } },
      { payload: { symbolId: "Svc#run", startLine: 10, content: "// docs\n  run(input: string): void {\n  body" } },
      { payload: { symbolId: "helper", startLine: 4, content: "export function helper(): number {" } },
      // namesake that was not asked for, malformed rows, and a chunk with no readable line
      { payload: { symbolId: "Other#x", startLine: 1, content: "other" } },
      { payload: { startLine: 1, content: "no symbol id" } },
      { payload: { symbolId: "empty", content: "\n   \n" } },
      { payload: { symbolId: "nostart", content: "function nostart() {}" } },
    ]);

    const result = await readPayloadSymbolSignatures(qdrant as never, "col", [
      "Svc#run",
      "helper",
      "Svc#run",
      "empty",
      "nostart",
    ]);

    expect(qdrant.scrollBySymbolIds).toHaveBeenCalledTimes(1);
    expect(qdrant.scrollBySymbolIds).toHaveBeenCalledWith("col", ["Svc#run", "helper", "empty", "nostart"], 16);
    expect(result.get("Svc#run")).toBe("run(input: string): void {");
    expect(result.get("helper")).toBe("export function helper(): number {");
    expect(result.get("nostart")).toBe("function nostart() {}");
    expect(result.has("empty")).toBe(false);
    expect(result.has("Other#x")).toBe(false);
  });
});
