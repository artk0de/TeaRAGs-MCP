import { beforeEach, describe, expect, it, vi } from "vitest";

import { getZodConfig, parseAppConfig } from "../../../src/bootstrap/config/index.js";
import { createAppContext, createConfiguredServer, loadPrompts } from "../../../src/bootstrap/factory.js";
import { migrateHomeDir } from "../../../src/bootstrap/migrate.js";
import { startHttpServer } from "../../../src/bootstrap/transport/http.js";
import { startStdioServer } from "../../../src/bootstrap/transport/stdio.js";
import { runServer } from "../../../src/cli/commands/server.js";

vi.mock("../../../src/bootstrap/config/index.js", () => ({
  parseAppConfig: vi.fn().mockReturnValue({ transportMode: "stdio" }),
  getZodConfig: vi.fn().mockReturnValue({ deprecations: [] }),
}));

vi.mock("../../../src/bootstrap/factory.js", () => ({
  createAppContext: vi.fn().mockResolvedValue({ cleanup: undefined }),
  createConfiguredServer: vi.fn().mockReturnValue({
    sendLoggingMessage: vi.fn(),
  }),
  loadPrompts: vi.fn().mockReturnValue({}),
}));

vi.mock("../../../src/bootstrap/migrate.js", () => ({
  migrateHomeDir: vi.fn(),
}));

vi.mock("../../../src/bootstrap/transport/stdio.js", () => ({
  startStdioServer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/bootstrap/transport/http.js", () => ({
  startHttpServer: vi.fn().mockResolvedValue(undefined),
}));

describe("server command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-establish default mocks after clearAllMocks
    vi.mocked(parseAppConfig).mockReturnValue({ transportMode: "stdio" } as ReturnType<typeof parseAppConfig>);
    vi.mocked(getZodConfig).mockReturnValue({ deprecations: [] } as ReturnType<typeof getZodConfig>);
    vi.mocked(createAppContext).mockResolvedValue({ cleanup: undefined } as any);
    vi.mocked(createConfiguredServer).mockReturnValue({ sendLoggingMessage: vi.fn() } as any);
    vi.mocked(loadPrompts).mockReturnValue({} as any);
    vi.mocked(startStdioServer).mockResolvedValue(undefined);
    vi.mocked(startHttpServer).mockResolvedValue(undefined as any);
  });

  it("should call migrateHomeDir on startup", async () => {
    await runServer({ http: false });

    expect(migrateHomeDir).toHaveBeenCalledOnce();
  });

  it("should parse config and create app context", async () => {
    await runServer({ http: false });

    expect(parseAppConfig).toHaveBeenCalledOnce();
    expect(createAppContext).toHaveBeenCalledOnce();
  });

  it("should start stdio server by default", async () => {
    await runServer({ http: false });

    expect(startStdioServer).toHaveBeenCalledOnce();
    expect(startHttpServer).not.toHaveBeenCalled();
  });

  it("should start HTTP server when --http flag is set", async () => {
    vi.mocked(parseAppConfig).mockReturnValue({ transportMode: "http" } as ReturnType<typeof parseAppConfig>);

    await runServer({ http: true });

    expect(startHttpServer).toHaveBeenCalledOnce();
    expect(startStdioServer).not.toHaveBeenCalled();
  });

  it("should create configured server for stdio mode", async () => {
    await runServer({ http: false });

    expect(createConfiguredServer).toHaveBeenCalledOnce();
  });

  it("should log deprecation warnings to stderr", async () => {
    vi.mocked(getZodConfig).mockReturnValue({
      deprecations: [{ oldName: "OLD_VAR", newName: "NEW_VAR" }],
    } as ReturnType<typeof getZodConfig>);

    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await runServer({ http: false });

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Deprecated env vars"));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("OLD_VAR"));

    stderrSpy.mockRestore();
  });

  it("should send deprecation warnings via MCP logging in stdio mode", async () => {
    const sendLoggingMessage = vi.fn();
    vi.mocked(getZodConfig).mockReturnValue({
      deprecations: [{ oldName: "OLD_VAR", newName: "NEW_VAR" }],
    } as ReturnType<typeof getZodConfig>);
    vi.mocked(createConfiguredServer).mockReturnValue({ sendLoggingMessage } as any);

    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await runServer({ http: false });

    expect(sendLoggingMessage).toHaveBeenCalledWith(expect.objectContaining({ level: "warning" }));

    stderrSpy.mockRestore();
  });

  it("should register cleanup handlers when context provides cleanup", async () => {
    const cleanup = vi.fn();
    vi.mocked(createAppContext).mockResolvedValue({ cleanup } as any);

    const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);

    await runServer({ http: false });

    expect(onSpy).toHaveBeenCalledWith("SIGTERM", cleanup);
    expect(onSpy).toHaveBeenCalledWith("SIGINT", cleanup);

    onSpy.mockRestore();
  });
});
