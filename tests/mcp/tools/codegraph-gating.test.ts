/**
 * Provider-gating test for `registerCodegraphTools` — RFC
 * docs/superpowers/specs/2026-05-21-codegraph-provider-gating-design.md.
 *
 * When `app.hasProvider("codegraph.symbols") === false`, the registrar must
 * be a complete no-op — neither `get_callers`, `get_callees`, nor `find_cycles`
 * appears in the MCP tool list. When true, all three tools register.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";

import type { App } from "../../../src/core/api/index.js";
import { registerCodegraphTools } from "../../../src/mcp/tools/codegraph.js";

function makeApp(hasCodegraph: boolean): App {
  return {
    hasProvider: vi.fn().mockImplementation((key: string) => key === "codegraph.symbols" && hasCodegraph),
    getCallers: vi.fn(),
    getCallees: vi.fn(),
    findCycles: vi.fn(),
  } as unknown as App;
}

function makeServer(): McpServer {
  return {} as McpServer;
}

describe("registerCodegraphTools — provider gating", () => {
  it("registers all 3 codegraph tools when hasProvider('codegraph.symbols') is true", () => {
    const register = vi.fn();
    const app = makeApp(true);

    registerCodegraphTools(makeServer(), { app, register });

    expect(register).toHaveBeenCalledTimes(3);
    const names = register.mock.calls.map((c) => c[1] as string).sort();
    expect(names).toEqual(["find_cycles", "get_callees", "get_callers"]);
  });

  it("is a complete no-op when hasProvider('codegraph.symbols') is false", () => {
    const register = vi.fn();
    const app = makeApp(false);

    registerCodegraphTools(makeServer(), { app, register });

    expect(register).not.toHaveBeenCalled();
  });

  it("queries hasProvider exactly once with 'codegraph.symbols' (no other keys)", () => {
    const register = vi.fn();
    const app = makeApp(true);

    registerCodegraphTools(makeServer(), { app, register });

    expect(app.hasProvider).toHaveBeenCalledTimes(1);
    expect(app.hasProvider).toHaveBeenCalledWith("codegraph.symbols");
  });
});
