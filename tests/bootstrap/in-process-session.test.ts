/**
 * `openInProcessMcpSession` (bd tea-rags-mcp-8vy3o) — the server `tea-rags
 * call` talks to is built the way `tea-rags server` builds it: same runtime
 * preparation (home migration, config, AppContext as the `server` env role,
 * prompts), same `createConfiguredServer`, with ONE deliberate difference —
 * the auto-update trigger is off, so a validation call from a worktree build
 * never spawns a detached reindex of the project it queried.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { parseAppConfig } from "../../src/bootstrap/config/index.js";
import { createAppContext, createConfiguredServer, loadPrompts } from "../../src/bootstrap/factory.js";
import { openInProcessMcpSession } from "../../src/bootstrap/in-process-session.js";
import { migrateHomeDir } from "../../src/bootstrap/migrate.js";

vi.mock("../../src/bootstrap/config/index.js", () => ({
  parseAppConfig: vi.fn(),
  getZodConfig: vi.fn(),
}));

vi.mock("../../src/bootstrap/factory.js", () => ({
  createAppContext: vi.fn(),
  createConfiguredServer: vi.fn(),
  loadPrompts: vi.fn(),
}));

vi.mock("../../src/bootstrap/migrate.js", () => ({ migrateHomeDir: vi.fn() }));

const { getZodConfig } = await import("../../src/bootstrap/config/index.js");

function echoServer(): McpServer {
  const server = new McpServer({ name: "tea-rags-test", version: "0.0.0" });
  server.registerTool(
    "echo",
    { description: "Echo the input", inputSchema: { value: z.string() } },
    async ({ value }) => ({ content: [{ type: "text", text: `echo:${value}` }] }),
  );
  return server;
}

describe("openInProcessMcpSession", () => {
  const cleanup = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(parseAppConfig).mockReturnValue({ transportMode: "stdio" } as ReturnType<typeof parseAppConfig>);
    vi.mocked(getZodConfig).mockReturnValue({ deprecations: [] } as unknown as ReturnType<typeof getZodConfig>);
    vi.mocked(createAppContext).mockResolvedValue({ cleanup } as never);
    vi.mocked(loadPrompts).mockReturnValue(null);
    vi.mocked(createConfiguredServer).mockImplementation(() => echoServer());
  });

  it("prepares the runtime the way `server` does (server env role) and disables auto-update and tree watching", async () => {
    const session = await openInProcessMcpSession();
    await session.close();

    expect(migrateHomeDir).toHaveBeenCalledOnce();
    // A one-shot call exits after one answer: a watcher would only hold fs handles until cleanup.
    expect(createAppContext).toHaveBeenCalledWith(expect.anything(), {
      ambientEnvRole: "server",
      watchWorkingTrees: false,
    });
    expect(createConfiguredServer).toHaveBeenCalledWith(expect.anything(), null, { autoUpdate: false });
  });

  it("round-trips list + call through the in-memory transport", async () => {
    const session = await openInProcessMcpSession();

    const tools = await session.listTools();
    const result = await session.callTool("echo", { value: "hi" });
    await session.close();

    expect(tools.map((t) => t.name)).toEqual(["echo"]);
    expect(result.content).toEqual([{ type: "text", text: "echo:hi" }]);
  });

  // bd tea-rags-mcp-xi2r9, B1: `tea-rags call` calls process.exit right after
  // close(); a cleanup that flushes pending store writes must be awaited, or the
  // exit cuts them between temp and rename.
  it("close() resolves only after an asynchronous cleanup has settled", async () => {
    let flushed = false;
    cleanup.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      flushed = true;
    });
    const session = await openInProcessMcpSession();

    await session.close();

    expect(flushed).toBe(true);
  });

  it("close() releases the AppContext exactly once", async () => {
    const session = await openInProcessMcpSession();

    await session.close();
    await session.close();

    expect(cleanup).toHaveBeenCalledOnce();
  });
});
