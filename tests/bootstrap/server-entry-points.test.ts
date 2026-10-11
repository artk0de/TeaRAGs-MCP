/**
 * The two MCP server entry points — the `tea-rags server` command and the
 * `src/index.ts` script (`npm run dev`) — run ONE server lifecycle,
 * `runMcpServer`. They used to carry the same body twice (signal listeners,
 * transport choice, stdio deprecation logging) and every lifecycle fix had to
 * edit both by hand (bd tea-rags-mcp-f3gq0).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runMcpServer } from "../../src/bootstrap/server-runtime.js";
import { runServer } from "../../src/cli/commands/server.js";

vi.mock("../../src/bootstrap/server-runtime.js", () => ({
  runMcpServer: vi.fn(),
}));

describe("MCP server entry points", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runMcpServer).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("the server command runs the shared lifecycle, passing --http through", async () => {
    await runServer({ http: true });
    expect(runMcpServer).toHaveBeenCalledWith({ http: true });
  });

  it("src/index.ts runs the same shared lifecycle with no transport override", async () => {
    await import("../../src/index.js");
    await vi.waitFor(() => {
      expect(runMcpServer).toHaveBeenCalledWith({});
    });
  });
});
