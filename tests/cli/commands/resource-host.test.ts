/**
 * `tea-rags resource` host wiring: the real stdout/stderr sinks, the in-process
 * session opened after replaying the target project's env, and the yargs
 * handler's exit code. The session itself is faked at the module boundary.
 */
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resourceCommand, runResource } from "../../../src/cli/commands/resource.js";

const mocks = vi.hoisted(() => ({
  openInProcessMcpSession: vi.fn(),
  prepareCallProjectEnv: vi.fn(async (..._args: unknown[]) => undefined),
  resolveProjectAlias: vi.fn(),
}));

vi.mock("../../../src/bootstrap/transport/in-process-session.js", () => ({
  openInProcessMcpSession: mocks.openInProcessMcpSession,
}));
vi.mock("../../../src/cli/call/project-env.js", () => ({ prepareCallProjectEnv: mocks.prepareCallProjectEnv }));
vi.mock("../../../src/cli/commands/project.js", () => ({
  createCollectionRegistry: () => ({ registry: true }),
  resolveProjectAlias: mocks.resolveProjectAlias,
}));

function session(result: ReadResourceResult): {
  readResource: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} & Record<string, unknown> {
  return {
    listTools: vi.fn(),
    callTool: vi.fn(),
    readResource: vi.fn(async () => result),
    listResources: vi.fn(async () => []),
    listResourceTemplates: vi.fn(async () => []),
    close: vi.fn(async () => undefined),
  };
}

describe("runResource host wiring", () => {
  beforeEach(() => {
    mocks.openInProcessMcpSession.mockReset();
    mocks.prepareCallProjectEnv.mockClear();
    mocks.resolveProjectAlias.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("replays the project env by alias, opens the in-process session and writes to the real stdout", async () => {
    const opened = session({ contents: [{ uri: "tea-rags://project/web/digest", text: "digest body" }] });
    mocks.openInProcessMcpSession.mockResolvedValue(opened);
    mocks.resolveProjectAlias.mockResolvedValue("web");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const code = await runResource({ uri: "tea-rags://project/{alias}/digest", path: "/work/web" });

    expect(code).toBe(0);
    expect(mocks.resolveProjectAlias).toHaveBeenCalledWith({ path: "/work/web", project: undefined });
    expect(mocks.prepareCallProjectEnv).toHaveBeenCalledTimes(1);
    expect(mocks.prepareCallProjectEnv.mock.calls[0]?.[0]).toEqual({ project: "web" });
    expect(opened.readResource).toHaveBeenCalledWith("tea-rags://project/web/digest");
    expect(stdout).toHaveBeenCalledWith("digest body\n");
    expect(opened.close).toHaveBeenCalled();
  });

  it("targets the cwd path when no alias is involved, and flags binary content on the real stderr", async () => {
    const opened = session({ contents: [{ uri: "tea-rags://blob", mimeType: "image/png", blob: "AAAA" }] });
    mocks.openInProcessMcpSession.mockResolvedValue(opened);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const code = await runResource({ uri: "tea-rags://blob", path: "/work/cli" });

    expect(code).toBe(0);
    expect(mocks.prepareCallProjectEnv.mock.calls[0]?.[0]).toEqual({ path: "/work/cli" });
    expect(stderr).toHaveBeenCalledWith("tea-rags://blob: binary image/png — use --json\n");
  });

  it("names the unresolved path on the real stderr when the alias cannot be resolved", async () => {
    mocks.resolveProjectAlias.mockResolvedValue(null);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    expect(await runResource({ uri: "tea-rags://project/{alias}/digest", path: "/work/none" })).toBe(1);

    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("No registered project for path /work/none"));
    expect(mocks.openInProcessMcpSession).not.toHaveBeenCalled();
  });

  it("reports a missing uri on the real stderr", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await runResource({})).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("No resource URI given"));
  });
});

describe("resourceCommand handler", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("describes its positional and flags, and exits with the run's code after flushing", async () => {
    const opened = session({ contents: [{ uri: "tea-rags://guide/core", text: "core" }] });
    mocks.openInProcessMcpSession.mockResolvedValue(opened);
    const acknowledge = ((...args: unknown[]) => {
      const callback = args.find((arg) => typeof arg === "function") as (() => void) | undefined;
      callback?.();
      return true;
    }) as typeof process.stdout.write;
    vi.spyOn(process.stdout, "write").mockImplementation(acknowledge);
    vi.spyOn(process.stderr, "write").mockImplementation(acknowledge);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    const handler = resourceCommand.handler as (argv: unknown) => Promise<void>;
    await handler({ uri: "tea-rags://guide/core", json: true, list: false });

    expect(exit).toHaveBeenCalledWith(0);
    expect(opened.readResource).toHaveBeenCalledWith("tea-rags://guide/core");
    expect(resourceCommand.command).toBe("resource [uri]");
  });
});
