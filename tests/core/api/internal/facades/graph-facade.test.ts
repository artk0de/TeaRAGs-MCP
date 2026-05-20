import { describe, expect, it, vi } from "vitest";

import { GraphFacade } from "../../../../../src/core/api/internal/facades/graph-facade.js";

describe("GraphFacade", () => {
  it("getCallers delegates to GraphDbClient and respects limit", async () => {
    const graphDb = {
      getCallers: vi.fn().mockResolvedValue([
        { sourceSymbolId: "A.f", sourceRelPath: "src/a.ts", callExpression: "B.x()" },
        { sourceSymbolId: "C.g", sourceRelPath: "src/c.ts", callExpression: "B.x()" },
      ]),
      getCallees: vi.fn(),
    } as never;
    const facade = new GraphFacade({ graphDb });
    const response = await facade.getCallers({ path: "/proj", symbolId: "B.x", limit: 50 });
    expect(graphDb.getCallers).toHaveBeenCalledWith("B.x");
    expect(response.callers).toHaveLength(2);
  });

  it("getCallers truncates results when over limit", async () => {
    const graphDb = {
      getCallers: vi.fn().mockResolvedValue(
        Array.from({ length: 10 }, (_, i) => ({
          sourceSymbolId: `A${i}.f`,
          sourceRelPath: `src/a${i}.ts`,
          callExpression: "B.x()",
        })),
      ),
      getCallees: vi.fn(),
    } as never;
    const facade = new GraphFacade({ graphDb });
    const response = await facade.getCallers({ path: "/proj", symbolId: "B.x", limit: 3 });
    expect(response.callers).toHaveLength(3);
  });

  it("getCallees delegates with the default limit of 50", async () => {
    const callees = Array.from({ length: 75 }, (_, i) => ({
      targetSymbolId: `T${i}`,
      targetRelPath: `src/t${i}.ts`,
      callExpression: `T${i}.run()`,
    }));
    const graphDb = {
      getCallers: vi.fn(),
      getCallees: vi.fn().mockResolvedValue(callees),
    } as never;
    const facade = new GraphFacade({ graphDb });
    const response = await facade.getCallees({ path: "/proj", symbolId: "main" });
    expect(graphDb.getCallees).toHaveBeenCalledWith("main");
    expect(response.callees).toHaveLength(50);
  });
});
