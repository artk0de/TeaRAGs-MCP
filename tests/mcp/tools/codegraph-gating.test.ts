/**
 * Provider-gating test for `registerCodegraphTools` — RFC
 * docs/superpowers/specs/2026-05-21-codegraph-provider-gating-design.md.
 *
 * When `app.hasProvider("codegraph.symbols") === false`, the registrar must
 * be a complete no-op — neither `get_callers`, `get_callees`, `find_cycles`,
 * nor `trace_path` appears in the MCP tool list. When true, all four tools
 * register.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { App, SchemaBuilder } from "../../../src/core/api/index.js";
import { registerCodegraphTools } from "../../../src/mcp/tools/codegraph.js";

function makeApp(hasCodegraph: boolean): App {
  return {
    hasProvider: vi.fn().mockImplementation((key: string) => key === "codegraph.symbols" && hasCodegraph),
    getCallers: vi.fn(),
    getCallees: vi.fn(),
    findCycles: vi.fn(),
    tracePath: vi.fn(),
  } as unknown as App;
}

/**
 * Minimal SchemaBuilder stub. `buildPresetSchema("trace_path")` returns the
 * curated enum the tool exposes — assertions on accept/reject mirror what the
 * real registry-derived enum does at the MCP boundary.
 */
function makeSchemaBuilder(): SchemaBuilder {
  return {
    buildPresetSchema: vi.fn((tool: string) => {
      expect(tool).toBe("trace_path");
      return z.enum(["bugHunt", "dangerous", "hotspots"]);
    }),
  } as unknown as SchemaBuilder;
}

function makeServer(): McpServer {
  return {} as McpServer;
}

describe("registerCodegraphTools — provider gating", () => {
  it("registers all 4 codegraph tools when hasProvider('codegraph.symbols') is true", () => {
    const register = vi.fn();
    const app = makeApp(true);

    registerCodegraphTools(makeServer(), { app, schemaBuilder: makeSchemaBuilder(), register });

    expect(register).toHaveBeenCalledTimes(4);
    const names = register.mock.calls.map((c) => c[1] as string).sort();
    expect(names).toEqual(["find_cycles", "get_callees", "get_callers", "trace_path"]);
  });

  it("registers trace_path when codegraph.symbols is present", () => {
    const register = vi.fn();
    const app = makeApp(true);

    registerCodegraphTools(makeServer(), { app, schemaBuilder: makeSchemaBuilder(), register });

    const names = register.mock.calls.map((c) => c[1] as string);
    expect(names).toContain("trace_path");
  });

  it("does NOT register trace_path when codegraph.symbols is absent", () => {
    const register = vi.fn();
    const app = makeApp(false);

    registerCodegraphTools(makeServer(), { app, schemaBuilder: makeSchemaBuilder(), register });

    const names = register.mock.calls.map((c) => c[1] as string);
    expect(names).not.toContain("trace_path");
  });

  it("is a complete no-op when hasProvider('codegraph.symbols') is false", () => {
    const register = vi.fn();
    const app = makeApp(false);

    registerCodegraphTools(makeServer(), { app, schemaBuilder: makeSchemaBuilder(), register });

    expect(register).not.toHaveBeenCalled();
  });

  it("queries hasProvider exactly once with 'codegraph.symbols' (no other keys)", () => {
    const register = vi.fn();
    const app = makeApp(true);

    registerCodegraphTools(makeServer(), { app, schemaBuilder: makeSchemaBuilder(), register });

    expect(app.hasProvider).toHaveBeenCalledTimes(1);
    expect(app.hasProvider).toHaveBeenCalledWith("codegraph.symbols");
  });

  it("trace_path rerank is a curated enum: accepts a tagged preset, rejects a bogus one", () => {
    const register = vi.fn();
    const app = makeApp(true);

    registerCodegraphTools(makeServer(), { app, schemaBuilder: makeSchemaBuilder(), register });

    const traceCall = register.mock.calls.find((c) => c[1] === "trace_path");
    expect(traceCall).toBeDefined();
    const { inputSchema } = traceCall?.[2] as { inputSchema: Record<string, z.ZodTypeAny> };
    const { rerank: rerankSchema } = inputSchema;

    // Curated preset accepted; undefined accepted (optional → defaults to bugHunt downstream).
    expect(rerankSchema.safeParse("bugHunt").success).toBe(true);
    expect(rerankSchema.safeParse(undefined).success).toBe(true);
    // Typo rejected at the MCP boundary — no more silent no-op.
    expect(rerankSchema.safeParse("totally_bogus").success).toBe(false);
  });
});
