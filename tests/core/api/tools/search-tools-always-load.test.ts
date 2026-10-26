import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { App, SchemaBuilder } from "../../../../src/core/api/index.js";
import { registerSearchTools } from "../../../../src/core/api/tools/explore.js";
import { createRegisterTool } from "../../../../src/core/api/tools/middleware/error-handler.js";
import { TYPED_FILTER_PARAM_NAMES } from "../../../../src/core/api/tools/schemas.js";

/**
 * bd tea-rags-mcp-45kbu: Claude Code defers MCP tool schemas behind ToolSearch
 * and loads a tool upfront when its `tools/list` entry carries
 * `_meta["anthropic/alwaysLoad"]: true` (code.claude.com/docs/en/mcp, "Mark a
 * tool to load upfront or stay deferred"). The key must survive the SDK's
 * `tools/list` serialization, not only sit on the registration config.
 */
describe("search tools — tools/list _meta", () => {
  it("carries anthropic/alwaysLoad on exactly find_symbol and hybrid_search", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const schemaBuilder = {
      buildRerankSchema: vi.fn(() => z.any()),
      customWeightSignals: () => ["similarity"],
      buildFilterSchema: vi.fn(() => z.any()),
      filterParamNames: vi.fn(() => [...TYPED_FILTER_PARAM_NAMES]),
    } as unknown as SchemaBuilder;
    registerSearchTools(server, { app: {} as App, schemaBuilder, register: createRegisterTool() });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const { tools } = await client.listTools();
      const upfront = tools.filter((t) => t._meta?.["anthropic/alwaysLoad"] === true).map((t) => t.name);

      expect(tools.length).toBeGreaterThan(2);
      expect(upfront.sort()).toEqual(["find_symbol", "hybrid_search"]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
