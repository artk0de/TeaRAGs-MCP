/**
 * `prepareMcpServerRuntime` — the runtime every MCP server entry point builds.
 * The long-lived server (`tea-rags server`, stdio and HTTP) watches the working
 * trees it is asked about, so their delta stays warm between requests; an
 * entry point that answers once (`tea-rags call`) opts out.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { getZodConfig, parseAppConfig } from "../../src/bootstrap/config/index.js";
import { createAppContext, loadPrompts } from "../../src/bootstrap/factory.js";
import { prepareMcpServerRuntime } from "../../src/bootstrap/server-runtime.js";

vi.mock("../../src/bootstrap/config/index.js", () => ({
  parseAppConfig: vi.fn(),
  getZodConfig: vi.fn(),
}));

vi.mock("../../src/bootstrap/factory.js", () => ({
  createAppContext: vi.fn(),
  loadPrompts: vi.fn(),
}));

vi.mock("../../src/bootstrap/migrate.js", () => ({ migrateHomeDir: vi.fn() }));

describe("prepareMcpServerRuntime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(parseAppConfig).mockReturnValue({ transportMode: "stdio" } as ReturnType<typeof parseAppConfig>);
    vi.mocked(getZodConfig).mockReturnValue({ deprecations: [] } as unknown as ReturnType<typeof getZodConfig>);
    vi.mocked(createAppContext).mockResolvedValue({} as never);
    vi.mocked(loadPrompts).mockReturnValue(null);
  });

  it("builds the long-lived server's context with working-tree watching on", async () => {
    await prepareMcpServerRuntime();

    expect(createAppContext).toHaveBeenCalledWith(expect.anything(), {
      ambientEnvRole: "server",
      watchWorkingTrees: true,
    });
  });

  it("lets a one-shot entry point turn working-tree watching off", async () => {
    await prepareMcpServerRuntime({ watchWorkingTrees: false });

    expect(createAppContext).toHaveBeenCalledWith(expect.anything(), {
      ambientEnvRole: "server",
      watchWorkingTrees: false,
    });
  });
});
