import { describe, expect, it, vi } from "vitest";
import yargs from "yargs";

import { runServer, serverCommand } from "../../../src/cli/commands/server.js";

const runMcpServer = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../../../src/bootstrap/transport/server-runtime.js", () => ({ runMcpServer }));

describe("server command", () => {
  it("runServer forwards the http flag to the MCP runtime", async () => {
    await runServer({ http: true });
    expect(runMcpServer).toHaveBeenCalledWith({ http: true });
  });

  it("the yargs handler defaults to stdio and honours --http", async () => {
    await yargs(["server"]).command(serverCommand).parseAsync();
    expect(runMcpServer).toHaveBeenLastCalledWith({ http: false });
    await yargs(["server", "--http"]).command(serverCommand).parseAsync();
    expect(runMcpServer).toHaveBeenLastCalledWith({ http: true });
  });
});
