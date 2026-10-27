/**
 * get_callers / get_callees `depth` + `offset` at the MCP surface (bd tea-rags-mcp-afdpc): the schema bounds
 * depth, a cut page carries `truncated.next` = the exact next-page call, and a tree goes out as a column table.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { App, SchemaBuilder } from "../../../../src/core/api/index.js";
import { registerCodegraphTools } from "../../../../src/core/api/tools/codegraph.js";

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;

function registeredTool(name: "get_callers" | "get_callees", respond: (req: Record<string, unknown>) => unknown) {
  const register = vi.fn();
  const app = {
    hasProvider: vi.fn(() => true),
    getCallers: vi.fn(async (req: Record<string, unknown>) => respond(req)),
    getCallees: vi.fn(async (req: Record<string, unknown>) => respond(req)),
  } as unknown as App;
  const schemaBuilder = { buildPresetSchema: vi.fn(() => z.enum(["bugHunt"])) } as unknown as SchemaBuilder;
  registerCodegraphTools({} as McpServer, { app, schemaBuilder, register });
  const call = register.mock.calls.find((c) => c[1] === name);
  const config = call?.[2] as { inputSchema: z.ZodRawShape };
  return { schema: z.object(config.inputSchema), handler: call?.[3] as Handler };
}

describe("get_callers / get_callees — depth + offset (afdpc)", () => {
  for (const name of ["get_callers", "get_callees"] as const) {
    it(`${name} accepts depth 1–3 and offset ≥ 0, rejects the rest`, () => {
      const { schema } = registeredTool(name, () => ({}));
      for (const depth of [1, 2, 3]) expect(schema.safeParse({ symbolId: "A#a", depth }).success).toBe(true);
      for (const depth of [0, 4, 1.5]) expect(schema.safeParse({ symbolId: "A#a", depth }).success).toBe(false);
      expect(schema.safeParse({ symbolId: "A#a", offset: 0 }).success).toBe(true);
      expect(schema.safeParse({ symbolId: "A#a", offset: -1 }).success).toBe(false);
    });
  }

  it("a page cut by limit carries truncated.next = the next page's call, run as given", async () => {
    const all = ["B#b", "C#c", "D#d"].map((id) => ({ targetSymbolId: id, targetRelPath: "x.ts", callExpression: id }));
    const respond = (req: Record<string, unknown>) => {
      const offset = (req.offset as number | undefined) ?? 0;
      const limit = req.limit as number;
      const callees = all.slice(offset, offset + limit);
      const omitted = all.length - offset - callees.length;
      return { callees, ...(omitted > 0 && { truncated: { returned: callees.length, omitted } }) };
    };
    const { handler } = registeredTool("get_callees", respond);
    const args = { project: "p", path: "/w", symbolId: "A#a", limit: 2 };

    const page1 = JSON.parse((await handler(args)).content[0].text);

    expect(page1.truncated).toEqual({
      returned: 2,
      omitted: 1,
      next: { tool: "get_callees", args: { ...args, offset: 2 }, why: expect.any(String) },
    });
    const page2 = JSON.parse((await handler(page1.truncated.next.args)).content[0].text);
    expect(page2.callees).toEqual([all[2]]);
    expect(page2).not.toHaveProperty("truncated");
  });

  it("a tree goes out as one column table led by depth and parent", async () => {
    const tree = [
      { depth: 1, parent: "A#a", symbolId: "B#b", relPath: "b.ts", edgeKind: "exact", confidence: 1 },
      { depth: 2, parent: "B#b", symbolId: "C#c", relPath: "c.ts", edgeKind: "exact", confidence: 1, seen: true },
    ];
    const { handler } = registeredTool("get_callers", () => ({ tree }));

    const out = JSON.parse((await handler({ symbolId: "A#a", depth: 2 })).content[0].text);

    expect(out.tree.columns).toEqual(["depth", "parent", "symbolId", "relPath", "edgeKind", "confidence", "seen"]);
    expect(out.tree.rows).toHaveLength(2);
  });
});
