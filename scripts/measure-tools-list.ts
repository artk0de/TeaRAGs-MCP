/**
 * measure-tools-list.ts (bd tea-rags-mcp-ewg2s)
 *
 * Serializes the MCP `tools/list` response the server actually sends and prints
 * its size — total and per tool — for both provider compositions (codegraph ON
 * and OFF). Measures the agent-facing schema budget instead of guessing it.
 *
 * The tool surface is built from the REAL composition (registry → Reranker →
 * SchemaBuilder → registerAllTools) and read back through a real MCP Client over
 * an in-memory transport, so the bytes are the JSON-RPC result the client sees.
 * The App is a stub: listing tools never calls a handler.
 *
 * Tokens are approximate: bytes / 4 (the usual rule of thumb for English + JSON).
 *
 * Usage:
 *   npx tsx scripts/measure-tools-list.ts [--per-tool] [--json]
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import type { GraphDbClientPool } from "../src/core/adapters/duckdb/pool.js";
import { createComposition, SchemaBuilder, type App } from "../src/core/api/index.js";
import { reviewSectionIds } from "../src/core/api/internal/ops/review-sections/index.js";
import type { CodegraphDeps } from "../src/core/domains/trajectory/codegraph/index.js";
import { registerAllTools } from "../src/mcp/tools/index.js";

export interface ToolsListMeasurement {
  bytes: number;
  approxTokens: number;
  toolCount: number;
  perTool: Record<string, number>;
}

export interface ToolSurface {
  /** The `tools/list` result exactly as an MCP client receives it. */
  tools: Tool[];
  /** JSON-RPC result byte size (`{ tools: [...] }`). */
  bytes: number;
  /** Filter params the composition's trajectory registry APPLIES (`FilterDescriptor#param`). */
  appliedFilterParams: Set<string>;
  /** Registered filter-preset names (they appear in the `filter` param description). */
  filterPresetNames: string[];
}

/**
 * Build the tool surface for one provider composition and read it back through
 * a real MCP client. Shared by this script and the param-applicability test, so
 * the measured surface and the tested surface are the same one.
 */
export async function buildToolSurface(codegraph: boolean): Promise<ToolSurface> {
  // Registering the codegraph trajectory never touches its deps; listing tools
  // runs no enrichment, so an empty stub stands in for the real pool.
  const codegraphDeps = { pool: {} as GraphDbClientPool } as unknown as CodegraphDeps;
  const { registry, reranker } = createComposition(codegraph ? { codegraph: codegraphDeps } : {});
  const schemaBuilder = new SchemaBuilder(reranker);
  const app = {
    hasProvider: (key: string) => codegraph && key === "codegraph.symbols",
    reviewSectionIds: () => reviewSectionIds,
  } as unknown as App;

  const server = new McpServer({ name: "measure", version: "0.0.0" });
  registerAllTools(server, { app, schemaBuilder });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "measure-client", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.listTools();
    return {
      tools: result.tools,
      bytes: Buffer.byteLength(JSON.stringify(result), "utf8"),
      appliedFilterParams: new Set(registry.getAllFilters().map((f) => f.param)),
      filterPresetNames: registry.filterPresetNames(),
    };
  } finally {
    await client.close();
    await server.close();
  }
}

/** Measure the tools/list response for one composition. */
export async function measureToolsList(codegraph: boolean): Promise<ToolsListMeasurement> {
  const { tools, bytes } = await buildToolSurface(codegraph);
  const perTool: Record<string, number> = {};
  for (const tool of tools) perTool[tool.name] = Buffer.byteLength(JSON.stringify(tool), "utf8");
  return { bytes, approxTokens: Math.round(bytes / 4), toolCount: tools.length, perTool };
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const on = await measureToolsList(true);
  const off = await measureToolsList(false);
  if (args.has("--json")) {
    console.log(JSON.stringify({ codegraphOn: on, codegraphOff: off }, null, 2));
    return;
  }
  for (const [label, m] of [
    ["codegraph ON", on],
    ["codegraph OFF", off],
  ] as const) {
    console.log(`${label}: ${m.toolCount} tools, ${m.bytes} bytes, ~${m.approxTokens} tokens`);
    if (args.has("--per-tool")) {
      for (const [name, b] of Object.entries(m.perTool).sort((a, z) => z[1] - a[1])) {
        console.log(`  ${name.padEnd(26)} ${b}`);
      }
    }
  }
}

if (process.argv[1]?.endsWith("measure-tools-list.ts")) {
  await main();
}
