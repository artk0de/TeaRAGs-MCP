/**
 * `connectInProcessClient` — the resource surface of the in-process session:
 * a real `McpServer` with registered resources, read and listed through the
 * SDK client over the in-memory transport, the path `tea-rags resource` takes.
 */

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it } from "vitest";

import { connectInProcessClient, type InProcessToolSession } from "../../../src/bootstrap/transport/in-memory.js";

function buildServer(): McpServer {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  server.registerResource("x", "tea-rags://guide/x", { mimeType: "text/markdown" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "text/markdown", text: "# X" }],
  }));
  server.registerResource(
    "digest",
    new ResourceTemplate("tea-rags://project/{alias}/digest", { list: undefined }),
    { mimeType: "text/markdown" },
    async (uri, { alias }) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: `digest of ${String(alias)}` }],
    }),
  );
  return server;
}

describe("connectInProcessClient resources", () => {
  let session: InProcessToolSession | undefined;

  afterEach(async () => {
    await session?.close();
    session = undefined;
  });

  it("reads a static resource", async () => {
    session = await connectInProcessClient(buildServer());

    const result = await session.readResource("tea-rags://guide/x");

    expect(result.contents[0]).toMatchObject({ uri: "tea-rags://guide/x", text: "# X" });
  });

  it("reads a templated resource", async () => {
    session = await connectInProcessClient(buildServer());

    const result = await session.readResource("tea-rags://project/my-app/digest");

    expect(result.contents[0]).toMatchObject({ text: "digest of my-app" });
  });

  it("lists static resources and resource templates", async () => {
    session = await connectInProcessClient(buildServer());

    expect((await session.listResources()).map((r) => r.uri)).toEqual(["tea-rags://guide/x"]);
    expect((await session.listResourceTemplates()).map((t) => t.uriTemplate)).toEqual([
      "tea-rags://project/{alias}/digest",
    ]);
  });

  it("rejects an unknown resource", async () => {
    session = await connectInProcessClient(buildServer());

    await expect(session.readResource("tea-rags://guide/missing")).rejects.toThrow(/not found/i);
  });
});
