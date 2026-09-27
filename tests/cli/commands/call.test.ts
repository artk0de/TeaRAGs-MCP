/**
 * `tea-rags call <tool> [params]` (bd tea-rags-mcp-8vy3o).
 *
 * Every test drives `runCall` over the REAL MCP path: a real `McpServer` with
 * the real tool registrars (fake `App` underneath, as tests/mcp/tools/* do),
 * reached through the SDK in-memory transport by `connectInProcessClient` —
 * so zod input validation, the error middleware and the formatters are the
 * ones a client sees.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { connectInProcessClient, type InProcessToolSession } from "../../../src/bootstrap/transport/in-memory.js";
import { CLI_OWNED_TOOLS } from "../../../src/cli/call/cli-owned-tools.js";
import { resolveParamsArg, runCall, type CallArgs, type CallDeps } from "../../../src/cli/commands/call.js";
import { InvalidParameterError, type App, type SchemaBuilder } from "../../../src/core/api/public/index.js";
import { createRegisterTool } from "../../../src/mcp/middleware/error-handler.js";
import { registerCodegraphTools } from "../../../src/mcp/tools/codegraph.js";
import { registerCollectionTools } from "../../../src/mcp/tools/collection.js";
import { registerSearchTools } from "../../../src/mcp/tools/explore.js";
import { registerProjectTools } from "../../../src/mcp/tools/list-projects.js";
import { TYPED_FILTER_PARAM_NAMES } from "../../../src/mcp/tools/schemas.js";

function makeApp(overrides: Partial<Record<string, unknown>> = {}, hasCodegraph = false): App {
  return {
    hasProvider: vi.fn((key: string) => key === "codegraph.symbols" && hasCodegraph),
    listCollections: vi.fn().mockResolvedValue(["code_a", "code_b"]),
    getCollectionInfo: vi.fn().mockResolvedValue({ name: "code_a", vectorSize: 768, pointsCount: 3 }),
    createCollection: vi.fn(),
    deleteCollection: vi.fn(),
    listProjects: vi.fn().mockResolvedValue([]),
    findSymbol: vi.fn().mockResolvedValue({
      results: [{ id: "p1", score: 1, payload: { symbolId: "Reranker#rerank", relativePath: "src/reranker.ts" } }],
    }),
    ...overrides,
  } as unknown as App;
}

function makeSchemaBuilder(): SchemaBuilder {
  return {
    buildPresetSchema: vi.fn(() => z.enum(["bugHunt", "dangerous", "hotspots"])),
    buildRerankSchema: vi.fn(() => z.any()),
    buildFilterSchema: vi.fn(() => z.any()),
    filterParamNames: vi.fn(() => [...TYPED_FILTER_PARAM_NAMES]),
  } as unknown as SchemaBuilder;
}

interface Harness {
  deps: CallDeps;
  stdout: string[];
  stderr: string[];
  closed: () => boolean;
  opened: () => number;
  remembered: string[][];
}

function harness(app: App, opts: { stdin?: string } = {}): Harness {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const remembered: string[][] = [];
  let session: InProcessToolSession | undefined;
  let closed = false;
  let opened = 0;
  const deps: CallDeps = {
    openSession: async () => {
      opened += 1;
      const server = new McpServer({ name: "tea-rags-test", version: "0.0.0" });
      const register = createRegisterTool();
      registerCollectionTools(server, { app, register });
      registerProjectTools(server, { app, register });
      registerSearchTools(server, { app, schemaBuilder: makeSchemaBuilder(), register });
      registerCodegraphTools(server, { app, schemaBuilder: makeSchemaBuilder(), register });
      session = await connectInProcessClient(server);
      const inner = session;
      return {
        listTools: async () => inner.listTools(),
        callTool: async (name, args) => inner.callTool(name, args),
        close: async () => {
          closed = true;
          await inner.close();
        },
      };
    },
    readStdin: async () => opts.stdin ?? "",
    out: (text) => stdout.push(text),
    err: (text) => stderr.push(text),
    rememberToolNames: (names) => remembered.push(names),
  };
  return { deps, stdout, stderr, closed: () => closed, opened: () => opened, remembered };
}

async function call(h: Harness, args: CallArgs): Promise<number> {
  return runCall(args, h.deps);
}

describe("runCall — params parsing", () => {
  it("passes a JSON object string as the tool arguments", async () => {
    const app = makeApp();
    const h = harness(app);

    const code = await call(h, { tool: "get_collection_info", params: '{"name":"code_a"}' });

    expect(code).toBe(0);
    expect(app.getCollectionInfo).toHaveBeenCalledWith("code_a");
    expect(h.stdout.join("\n")).toContain('"vectorSize": 768');
    expect(h.closed()).toBe(true);
  });

  it("reads the params JSON from stdin when params is `-`", async () => {
    const app = makeApp();
    const h = harness(app, { stdin: '  {"name":"code_b"}\n' });

    const code = await call(h, { tool: "get_collection_info", params: "-" });

    expect(code).toBe(0);
    expect(app.getCollectionInfo).toHaveBeenCalledWith("code_b");
  });

  it("defaults to no arguments when params is omitted", async () => {
    const h = harness(makeApp());

    const code = await call(h, { tool: "list_collections" });

    expect(code).toBe(0);
    expect(h.stdout.join("\n")).toContain("code_a");
  });

  it("rejects invalid JSON with exit 1 before opening a session", async () => {
    const h = harness(makeApp());

    const code = await call(h, { tool: "get_collection_info", params: "{name:" });

    expect(code).toBe(1);
    expect(h.stderr.join("\n")).toMatch(/not valid JSON/);
    expect(h.opened()).toBe(0);
  });

  it("rejects a JSON value that is not an object with exit 1", async () => {
    const h = harness(makeApp());

    const code = await call(h, { tool: "get_collection_info", params: '["code_a"]' });

    expect(code).toBe(1);
    expect(h.stderr.join("\n")).toMatch(/JSON object/);
  });
});

describe("resolveParamsArg — the `-` stdin marker survives yargs", () => {
  // yargs re-parses command positionals as `--params -`, so a bare `-` arrives
  // as "" (string positional) or `true`; the raw tokens still carry it.
  it("recovers `-` from the raw tokens when yargs mangled it", () => {
    expect(resolveParamsArg("", ["call", "find_symbol", "-", "--json"])).toBe("-");
    expect(resolveParamsArg(true, ["call", "find_symbol", "-"])).toBe("-");
  });

  it("passes a real params string through untouched", () => {
    expect(resolveParamsArg('{"a":1}', ["call", "t", '{"a":1}'])).toBe('{"a":1}');
  });

  it("no params and no `-` token → undefined", () => {
    expect(resolveParamsArg(undefined, ["call", "t"])).toBeUndefined();
    expect(resolveParamsArg("", ["call", "t", ""])).toBeUndefined();
  });
});

describe("runCall — tool resolution", () => {
  it("unknown tool → exit 2 with close matches, no call made", async () => {
    const h = harness(makeApp());

    const code = await call(h, { tool: "get_colection_info", params: "{}" });

    expect(code).toBe(2);
    const err = h.stderr.join("\n");
    expect(err).toMatch(/Unknown tool "get_colection_info"/);
    expect(err).toContain("get_collection_info");
    expect(h.closed()).toBe(true);
  });

  it("a tool gated off by the server's config is unknown (codegraph disabled)", async () => {
    const h = harness(makeApp({}, false));

    const code = await call(h, { tool: "get_callers", params: '{"symbolId":"x"}' });

    expect(code).toBe(2);
  });

  it("a CLI-owned tool is refused with a pointer to its command, exit 2, no session opened", async () => {
    for (const [tool, command] of Object.entries(CLI_OWNED_TOOLS)) {
      const h = harness(makeApp());

      const code = await call(h, { tool, params: "{}" });

      expect(code).toBe(2);
      expect(h.stderr.join("\n")).toContain(command);
      expect(h.opened()).toBe(0);
    }
  });

  it("the CLI-owned table names real commands (index-codebase, projects …)", () => {
    expect(CLI_OWNED_TOOLS).toEqual({
      index_codebase: "tea-rags index-codebase",
      list_projects: "tea-rags projects list",
      register_project: "tea-rags projects register",
      unregister_project: "tea-rags projects unregister",
    });
  });
});

describe("runCall — results and exit codes", () => {
  it("isError result (typed error through the middleware) → exit 1, error text on stderr", async () => {
    const app = makeApp({
      getCollectionInfo: vi.fn().mockRejectedValue(new InvalidParameterError("name", "no such collection")),
    });
    const h = harness(app);

    const code = await call(h, { tool: "get_collection_info", params: '{"name":"nope"}' });

    expect(code).toBe(1);
    expect(h.stderr.join("\n")).toContain('Invalid parameter "name": no such collection');
    expect(h.stdout).toEqual([]);
  });

  it("zod input validation failure → exit 1 with the SDK validation message", async () => {
    const app = makeApp();
    const h = harness(app);

    const code = await call(h, { tool: "get_collection_info", params: '{"name":42}' });

    expect(code).toBe(1);
    expect(h.stderr.join("\n")).toMatch(/Input validation error/);
    expect(app.getCollectionInfo).not.toHaveBeenCalled();
  });

  it("a structured-output tool (empty content + structuredContent) prints the structured payload", async () => {
    const h = harness(makeApp());

    const code = await call(h, { tool: "find_symbol", params: '{"project":"tea-rags","symbol":"Reranker#rerank"}' });

    expect(code).toBe(0);
    const printed = JSON.parse(h.stdout.join("\n")) as { results: { payload: { symbolId: string } }[] };
    expect(printed.results[0].payload.symbolId).toBe("Reranker#rerank");
  });

  it("--json prints the full CallToolResult as one JSON document and nothing else", async () => {
    const h = harness(makeApp());

    const code = await call(h, { tool: "get_collection_info", params: '{"name":"code_a"}', json: true });

    expect(code).toBe(0);
    expect(h.stdout).toHaveLength(1);
    const parsed = JSON.parse(h.stdout[0]) as { content: { type: string; text: string }[]; isError?: boolean };
    expect(parsed.content[0].type).toBe("text");
    expect(parsed.content[0].text).toContain("vectorSize");
  });

  it("--json on an isError result still prints the result and exits 1", async () => {
    const app = makeApp({
      getCollectionInfo: vi.fn().mockRejectedValue(new InvalidParameterError("name", "no such collection")),
    });
    const h = harness(app);

    const code = await call(h, { tool: "get_collection_info", params: '{"name":"nope"}', json: true });

    expect(code).toBe(1);
    expect(h.stdout).toHaveLength(1);
    expect((JSON.parse(h.stdout[0]) as { isError: boolean }).isError).toBe(true);
  });

  it("--json keeps pre-session failures machine-readable on stdout", async () => {
    const h = harness(makeApp());

    const invalid = await call(h, { tool: "get_collection_info", params: "{", json: true });
    const unknown = await call(h, { tool: "nope_tool", params: "{}", json: true });

    expect(invalid).toBe(1);
    expect(unknown).toBe(2);
    expect(h.stdout).toHaveLength(2);
    expect((JSON.parse(h.stdout[0]) as { error: { code: string } }).error.code).toBe("INVALID_JSON");
    expect((JSON.parse(h.stdout[1]) as { error: { code: string } }).error.code).toBe("UNKNOWN_TOOL");
  });
});

// bd tea-rags-mcp-nxwsq: the target project's registry env is replayed
// before the server is built, so its gating (codegraph) matches the project.
describe("runCall — project env replay", () => {
  it("hands the parsed params to prepareProjectEnv before the session opens", async () => {
    const h = harness(makeApp());
    const seen: { params: Record<string, unknown>; openedBefore: number }[] = [];
    h.deps.prepareProjectEnv = async (params) => {
      seen.push({ params, openedBefore: h.opened() });
    };

    const code = await call(h, { tool: "get_collection_info", params: '{"name":"code_a","project":"alpha"}' });

    expect(code).toBe(0);
    expect(seen).toEqual([{ params: { name: "code_a", project: "alpha" }, openedBefore: 0 }]);
  });

  it("replays the cwd's project for --list (no params)", async () => {
    const h = harness(makeApp());
    const seen: Record<string, unknown>[] = [];
    h.deps.prepareProjectEnv = async (params) => {
      seen.push(params);
    };

    await call(h, { list: true });

    expect(seen).toEqual([{}]);
  });

  it("a replay that cannot resolve the project's backend fails the call before any session", async () => {
    const h = harness(makeApp());
    h.deps.prepareProjectEnv = async () => {
      throw new Error("registry entry contradicts itself");
    };

    const code = await call(h, { tool: "get_collection_info", params: '{"name":"code_a"}', json: true });

    expect(code).toBe(1);
    expect(h.opened()).toBe(0);
    expect((JSON.parse(h.stdout[0]) as { error: { code: string; message: string } }).error).toMatchObject({
      code: "CALL_FAILED",
      message: "registry entry contradicts itself",
    });
  });
});

describe("runCall — --list", () => {
  it("lists callable tools one per line with a one-line description, excluding CLI-owned ones", async () => {
    const h = harness(makeApp());

    const code = await call(h, { list: true });

    expect(code).toBe(0);
    const lines = h.stdout.join("\n").split("\n");
    const toolLine = lines.find((l) => l.startsWith("get_collection_info"));
    expect(toolLine).toMatch(/^get_collection_info\s+Get collection details/);
    expect(lines.some((l) => l.startsWith("list_projects"))).toBe(false);
    expect(lines.every((l) => !l.includes("\n"))).toBe(true);
  });

  it("no tool given behaves like --list", async () => {
    const h = harness(makeApp());

    const code = await call(h, {});

    expect(code).toBe(0);
    expect(h.stdout.join("\n")).toContain("list_collections");
  });

  it("reflects the server's gating: codegraph tools appear only when codegraph is enabled", async () => {
    const off = harness(makeApp({}, false));
    const on = harness(makeApp({}, true));

    await call(off, { list: true });
    await call(on, { list: true });

    expect(off.stdout.join("\n")).not.toContain("get_callers");
    expect(on.stdout.join("\n")).toContain("get_callers");
  });

  it("--list --json emits { tools, cliOwned }", async () => {
    const h = harness(makeApp());

    await call(h, { list: true, json: true });

    expect(h.stdout).toHaveLength(1);
    const parsed = JSON.parse(h.stdout[0]) as {
      tools: { name: string; description: string }[];
      cliOwned: { name: string; command: string }[];
    };
    expect(parsed.tools.map((t) => t.name)).toContain("list_collections");
    expect(parsed.tools.map((t) => t.name)).not.toContain("list_projects");
    expect(parsed.cliOwned).toContainEqual({ name: "list_projects", command: "tea-rags projects list" });
  });

  it("remembers the callable tool names for shell completion", async () => {
    const h = harness(makeApp());

    await call(h, { list: true });

    expect(h.remembered).toHaveLength(1);
    expect(h.remembered[0]).toContain("get_collection_info");
    expect(h.remembered[0]).not.toContain("list_projects");
  });
});
