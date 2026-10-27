/**
 * The experimental `locate` tool is hidden: registered only when the
 * bootstrap-parsed `EXPERIMENTAL_LOCATE_ENABLE` flag reaches `registerAllTools`.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";

import { createComposition, SchemaBuilder, type App } from "../../../../../src/core/api/index.js";
import { registerAllTools } from "../../../../../src/core/api/tools/index.js";

async function listToolNames(experimentalLocate?: boolean): Promise<string[]> {
  const app = { hasProvider: () => false, reviewSectionIds: () => [] } as unknown as App;
  const schemaBuilder = new SchemaBuilder(createComposition({}).reranker);
  const server = new McpServer({ name: "locate-reg", version: "0.0.0" });
  registerAllTools(server, {
    app,
    schemaBuilder,
    ...(experimentalLocate !== undefined ? { experimentalLocate } : {}),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return (await client.listTools()).tools.map((t) => t.name);
  } finally {
    await client.close();
    await server.close();
  }
}

describe("locate registration gate", () => {
  it("is absent when the flag is unset", async () => {
    expect(await listToolNames()).not.toContain("locate");
  });

  it("is absent when the flag is false", async () => {
    expect(await listToolNames(false)).not.toContain("locate");
  });

  it("is registered when the flag is true", async () => {
    expect(await listToolNames(true)).toContain("locate");
  });
});
