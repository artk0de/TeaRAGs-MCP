import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { App, SchemaBuilder } from "../../../../src/core/api/index.js";
import { registerCodegraphTools } from "../../../../src/core/api/tools/codegraph.js";

type Wire = Record<string, { columns: string[]; rows: unknown[][] }>;

async function callTool(name: "get_callees" | "get_callers", answer: unknown) {
  const app = {
    hasProvider: vi.fn().mockReturnValue(true),
    getCallees: vi.fn().mockResolvedValue(answer),
    getCallers: vi.fn().mockResolvedValue(answer),
  } as unknown as App;
  const register = vi.fn();
  const schemaBuilder = { buildPresetSchema: vi.fn(() => z.enum(["bugHunt"])) } as unknown as SchemaBuilder;
  registerCodegraphTools({} as McpServer, { app, schemaBuilder, register });
  const handler = register.mock.calls.find((c) => c[1] === name)?.[3] as (
    r: unknown,
  ) => Promise<{ content: { text: string }[] }>;
  const wire = JSON.parse((await handler({})).content[0].text) as Wire;
  return wire[name === "get_callees" ? "callees" : "callers"];
}

const A = { targetSymbolId: "A#a", targetRelPath: "a.ts", callExpression: "a()", edgeKind: "static" };
const B = { targetSymbolId: "B#b", targetRelPath: "b.ts", callExpression: "b()", visibility: "public" };

describe("get_callees / get_callers — deterministic column order", () => {
  it("get_callees columns do not depend on which keys the first row carries", async () => {
    const one = await callTool("get_callees", { callees: [A, B] });
    const other = await callTool("get_callees", { callees: [B, A] });

    expect(one.columns).toEqual(other.columns);
    expect(one.columns.slice(0, 3)).toEqual(["targetSymbolId", "targetRelPath", "callExpression"]);
  });

  it("get_callers columns do not depend on which keys the first row carries", async () => {
    const x = { sourceSymbolId: "X#x", sourceRelPath: "x.ts", callExpression: "x()", visibility: "public" };
    const y = { sourceSymbolId: "Y#y", sourceRelPath: "y.ts", callExpression: "y()", origin: "model", p: 0.5 };

    const one = await callTool("get_callers", { callers: [x, y] });
    const other = await callTool("get_callers", { callers: [y, x] });

    expect(one.columns).toEqual(other.columns);
  });
});
