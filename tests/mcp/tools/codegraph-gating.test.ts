/**
 * Provider-gating test for `registerCodegraphTools` — RFC
 * docs/superpowers/specs/2026-05-21-codegraph-provider-gating-design.md.
 *
 * When `app.hasProvider("codegraph.symbols") === false`, the registrar must
 * be a complete no-op — neither `get_callers`, `get_callees`, `find_cycles`,
 * `trace_path`, `get_architecture_report` nor `get_naming_lexicon` appears in
 * the MCP tool list. When true, all of them register.
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
    getArchitectureReport: vi.fn(),
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
  it("registers all 6 codegraph tools when hasProvider('codegraph.symbols') is true", () => {
    const register = vi.fn();
    const app = makeApp(true);

    registerCodegraphTools(makeServer(), { app, schemaBuilder: makeSchemaBuilder(), register });

    expect(register).toHaveBeenCalledTimes(6);
    const names = register.mock.calls.map((c) => c[1] as string).sort();
    expect(names).toEqual([
      "find_cycles",
      "get_architecture_report",
      "get_callees",
      "get_callers",
      "get_naming_lexicon",
      "trace_path",
    ]);
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

  it("find_cycles handler forwards the pathPattern scope filter into app.findCycles", async () => {
    const register = vi.fn();
    const app = makeApp(true);
    (app.findCycles as ReturnType<typeof vi.fn>).mockResolvedValue({ cycles: [] });

    registerCodegraphTools(makeServer(), { app, schemaBuilder: makeSchemaBuilder(), register });

    // register(server, name, config, handler) — pull the find_cycles handler.
    const call = register.mock.calls.find((c) => c[1] === "find_cycles");
    const handler = call?.[3] as (args: Record<string, unknown>) => Promise<unknown>;
    await handler({ path: "/proj", scope: "file", pathPattern: "**/domains/ingest/**" });

    expect(app.findCycles).toHaveBeenCalledWith({
      project: undefined,
      collection: undefined,
      path: "/proj",
      scope: "file",
      pathPattern: "**/domains/ingest/**",
    });
  });

  // bd tea-rags-mcp-z3bcv (f2jsb A4) — opt-in lazy ambiguous expansion.
  it("get_callers schema exposes optional boolean includeAmbiguous", () => {
    const register = vi.fn();
    const app = makeApp(true);

    registerCodegraphTools(makeServer(), { app, schemaBuilder: makeSchemaBuilder(), register });

    const call = register.mock.calls.find((c) => c[1] === "get_callers");
    const { inputSchema } = call?.[2] as { inputSchema: Record<string, z.ZodTypeAny> };
    const { includeAmbiguous } = inputSchema;
    expect(includeAmbiguous).toBeDefined();
    expect(includeAmbiguous.safeParse(true).success).toBe(true);
    expect(includeAmbiguous.safeParse(false).success).toBe(true);
    expect(includeAmbiguous.safeParse(undefined).success).toBe(true); // optional
    expect(includeAmbiguous.safeParse("yes").success).toBe(false);
  });

  it("get_callers handler forwards includeAmbiguous into app.getCallers", async () => {
    const register = vi.fn();
    const app = makeApp(true);
    (app.getCallers as ReturnType<typeof vi.fn>).mockResolvedValue({ callers: [] });

    registerCodegraphTools(makeServer(), { app, schemaBuilder: makeSchemaBuilder(), register });

    const call = register.mock.calls.find((c) => c[1] === "get_callers");
    const handler = call?.[3] as (args: Record<string, unknown>) => Promise<unknown>;
    await handler({ path: "/proj", symbolId: "Account#firm", includeAmbiguous: true });

    expect(app.getCallers).toHaveBeenCalledWith({
      project: undefined,
      collection: undefined,
      path: "/proj",
      symbolId: "Account#firm",
      limit: undefined,
      includeAmbiguous: true,
    });
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

// bd tea-rags-mcp-94hd9 — architecture diagnostics report, codegraph-gated like find_cycles.
describe("get_architecture_report", () => {
  function registered(hasCodegraph = true) {
    const register = vi.fn();
    const app = makeApp(hasCodegraph);
    registerCodegraphTools(makeServer(), { app, schemaBuilder: makeSchemaBuilder(), register });
    const call = register.mock.calls.find((c) => c[1] === "get_architecture_report");
    return { app, call };
  }

  it("is not registered when codegraph.symbols is absent", () => {
    expect(registered(false).call).toBeUndefined();
  });

  it("is a read-only tool whose schema takes the address triad, an optional pathPattern and limit", () => {
    const { call } = registered();
    const config = call?.[2] as {
      inputSchema: Record<string, z.ZodTypeAny>;
      annotations: Record<string, boolean>;
      description: string;
    };
    const schema = z.object(config.inputSchema);

    expect(config.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true });
    expect(config.description).toMatch(/Stable Dependencies/);
    expect(schema.safeParse({ project: "tea-rags" }).success).toBe(true);
    expect(schema.safeParse({ project: "tea-rags", pathPattern: "src/core/**", limit: 20 }).success).toBe(true);
    expect(schema.safeParse({ project: "tea-rags", limit: 0 }).success).toBe(false);
    expect(schema.safeParse({ project: "tea-rags", limit: 501 }).success).toBe(false);
  });

  it("forwards the address, pathPattern and limit into app.getArchitectureReport and returns its report as text", async () => {
    const { app, call } = registered();
    const report = { summary: {}, rootCauses: [], violations: [] };
    (app.getArchitectureReport as ReturnType<typeof vi.fn>).mockResolvedValue(report);
    const handler = call?.[3] as (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;

    const result = await handler({ project: "tea-rags", pathPattern: "src/core/**", limit: 10 });

    expect(app.getArchitectureReport).toHaveBeenCalledWith({
      project: "tea-rags",
      collection: undefined,
      path: undefined,
      pathPattern: "src/core/**",
      limit: 10,
    });
    expect(JSON.parse(result.content[0].text)).toEqual(report);
  });
});

// bd tea-rags-mcp-gfvr8 — get_callers / get_callees at FILE scope.
describe("get_callers / get_callees — file scope", () => {
  function registered(tool: "get_callers" | "get_callees") {
    const register = vi.fn();
    const app = makeApp(true);
    registerCodegraphTools(makeServer(), { app, schemaBuilder: makeSchemaBuilder(), register });
    const call = register.mock.calls.find((c) => c[1] === tool);
    const config = call?.[2] as { inputSchema: Record<string, z.ZodTypeAny>; description: string };
    const handler = call?.[3] as (args: Record<string, unknown>) => Promise<unknown>;
    return { app, config, handler };
  }

  for (const tool of ["get_callers", "get_callees"] as const) {
    it(`${tool} schema accepts relativePath without symbolId, and symbolId without relativePath`, () => {
      const schema = z.object(registered(tool).config.inputSchema);
      expect(schema.safeParse({ project: "p", relativePath: "src/a.ts" }).success).toBe(true);
      expect(schema.safeParse({ project: "p", symbolId: "A#b" }).success).toBe(true);
    });

    it(`${tool} description documents the file-scope answer`, () => {
      const { description } = registered(tool).config;
      expect(description).toMatch(/relativePath/);
      expect(description).toMatch(/import/);
    });
  }

  it("get_callers handler forwards relativePath into app.getCallers", async () => {
    const { app, handler } = registered("get_callers");
    (app.getCallers as ReturnType<typeof vi.fn>).mockResolvedValue({
      relativePath: "src/a.ts",
      importers: [],
      total: 0,
    });

    await handler({ project: "p", relativePath: "src/a.ts", limit: 5 });

    expect(app.getCallers).toHaveBeenCalledWith(
      expect.objectContaining({ project: "p", relativePath: "src/a.ts", limit: 5 }),
    );
  });

  it("get_callees handler forwards relativePath into app.getCallees", async () => {
    const { app, handler } = registered("get_callees");
    (app.getCallees as ReturnType<typeof vi.fn>).mockResolvedValue({ relativePath: "src/a.ts", imports: [], total: 0 });

    await handler({ project: "p", relativePath: "src/a.ts" });

    expect(app.getCallees).toHaveBeenCalledWith(expect.objectContaining({ project: "p", relativePath: "src/a.ts" }));
  });
});
