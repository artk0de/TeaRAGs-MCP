/**
 * `get_callers` / `get_callees` surface host-class aliasing (bd
 * tea-rags-mcp-63l69 part 1): the tool description tells the agent a host id
 * may be answered through its definer, and the handler's text output carries
 * the facade's `resolvedSymbolId` verbatim so the aliasing is visible.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { App, SchemaBuilder } from "../../../src/core/api/index.js";
import { registerCodegraphTools } from "../../../src/mcp/tools/codegraph.js";

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;

function registeredTool(name: "get_callers" | "get_callees", response: unknown) {
  const register = vi.fn();
  const app = {
    hasProvider: vi.fn(() => true),
    getCallers: vi.fn().mockResolvedValue(response),
    getCallees: vi.fn().mockResolvedValue(response),
  } as unknown as App;
  const schemaBuilder = { buildPresetSchema: vi.fn(() => z.enum(["bugHunt"])) } as unknown as SchemaBuilder;
  registerCodegraphTools({} as McpServer, { app, schemaBuilder, register });
  const call = register.mock.calls.find((c) => c[1] === name);
  expect(call).toBeDefined();
  return { description: (call?.[2] as { description: string }).description, handler: call?.[3] as Handler };
}

describe("graph tools — resolvedSymbolId (bd tea-rags-mcp-63l69)", () => {
  for (const name of ["get_callers", "get_callees"] as const) {
    it(`${name} documents resolvedSymbolId in its description`, () => {
      expect(registeredTool(name, {}).description).toContain("resolvedSymbolId");
    });

    it(`${name} passes resolvedSymbolId through to the output`, async () => {
      const list = name === "get_callers" ? "callers" : "callees";
      const response = { resolvedSymbolId: "Account::Suspensions.suspended", [list]: [] };
      const { handler } = registeredTool(name, response);

      const out = await handler({ project: "p", symbolId: "Account.suspended" });

      expect(JSON.parse(out.content[0].text)).toEqual(response);
    });
  }
});
