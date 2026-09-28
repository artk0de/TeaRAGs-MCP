/**
 * `tea-rags call` as the yargs command runs it (bd tea-rags-mcp-8vy3o): the
 * handler wires `runCall` to the real process — stdout / stderr, stdin for the
 * `-` marker, the tool-name completion cache, the console reroute and the
 * explicit exit. `call.test.ts` pins `runCall` over a real MCP server; this file
 * pins the process contract around it. The only seam replaced is the one that
 * would boot a full server from the user's config (`openInProcessMcpSession`).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InProcessToolSession } from "../../../src/bootstrap/transport/in-memory.js";
import { recallCallToolNames } from "../../../src/cli/call/tool-name-cache.js";

const sessionState = vi.hoisted(() => ({
  open: undefined as undefined | (() => Promise<unknown>),
}));

vi.mock("../../../src/bootstrap/in-process-session.js", () => ({
  openInProcessMcpSession: async () => {
    if (!sessionState.open) throw new Error("no session configured");
    return sessionState.open();
  },
}));

const { callCommand, runCall } = await import("../../../src/cli/commands/call.js");

const ECHO_TOOL: Tool = {
  name: "echo_tool",
  description: "Echo the arguments back. Second sentence is dropped.",
  inputSchema: { type: "object" },
};

interface FakeSession extends InProcessToolSession {
  calls: { name: string; args: Record<string, unknown> }[];
  closed: boolean;
}

function fakeSession(onCall?: (args: Record<string, unknown>) => void): FakeSession {
  const session: FakeSession = {
    calls: [],
    closed: false,
    listTools: async () => [ECHO_TOOL, { name: "index_codebase", inputSchema: { type: "object" } }],
    callTool: async (name, args) => {
      session.calls.push({ name, args });
      onCall?.(args);
      return { content: [{ type: "text", text: `echo:${JSON.stringify(args)}` }] };
    },
    close: async () => {
      session.closed = true;
    },
  };
  return session;
}

describe("callCommand.handler — the process contract", () => {
  let dataDir: string;
  let stdout: string[];
  let stderr: string[];
  let exitCodes: (number | undefined)[];
  const savedArgv = process.argv;
  const savedDataDir = process.env.TEA_RAGS_DATA_DIR;
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin");

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "call-handler-"));
    process.env.TEA_RAGS_DATA_DIR = dataDir;
    stdout = [];
    stderr = [];
    exitCodes = [];
    const capture =
      (sink: string[]) =>
      (chunk: unknown, ...rest: unknown[]): boolean => {
        if (String(chunk) !== "") sink.push(String(chunk));
        const cb = rest.find((r): r is () => void => typeof r === "function");
        cb?.();
        return true;
      };
    vi.spyOn(process.stdout, "write").mockImplementation(capture(stdout));
    vi.spyOn(process.stderr, "write").mockImplementation(capture(stderr));
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      exitCodes.push(code);
    }) as typeof process.exit);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.argv = savedArgv;
    if (savedDataDir === undefined) delete process.env.TEA_RAGS_DATA_DIR;
    else process.env.TEA_RAGS_DATA_DIR = savedDataDir;
    if (stdinDescriptor) Object.defineProperty(process, "stdin", stdinDescriptor);
    sessionState.open = undefined;
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function runHandler(argv: Record<string, unknown>): Promise<void> {
    await (callCommand.handler as (a: Record<string, unknown>) => Promise<void>)({
      _: ["call"],
      $0: "tea-rags",
      ...argv,
    });
  }

  it("prints the tool's answer on stdout, exits 0 and closes the session", async () => {
    const session = fakeSession();
    sessionState.open = async () => session;
    process.argv = ["node", "tea-rags", "call", "echo_tool", '{"q":1}'];

    await runHandler({ tool: "echo_tool", params: '{"q":1}', list: false, json: false });

    expect(stdout).toEqual(['echo:{"q":1}\n']);
    expect(exitCodes).toEqual([0]);
    expect(session.calls).toEqual([{ name: "echo_tool", args: { q: 1 } }]);
    expect(session.closed).toBe(true);
  });

  it("reads the params JSON from stdin when yargs swallowed the `-` marker", async () => {
    const session = fakeSession();
    sessionState.open = async () => session;
    process.argv = ["node", "tea-rags", "call", "echo_tool", "-"];
    Object.defineProperty(process, "stdin", {
      configurable: true,
      value: Readable.from([Buffer.from('{"project":'), '"my-app"}']),
    });

    await runHandler({ tool: "echo_tool", params: "", list: false, json: false });

    expect(session.calls).toEqual([{ name: "echo_tool", args: { project: "my-app" } }]);
    expect(exitCodes).toEqual([0]);
  });

  it("keeps stdout for the answer alone: server console output goes to stderr, and console is restored after", async () => {
    const originalLog = console.log;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const session = fakeSession(() => {
      console.log("server noise");
      console.info("server info");
    });
    sessionState.open = async () => session;
    process.argv = ["node", "tea-rags", "call", "echo_tool"];

    await runHandler({ tool: "echo_tool", list: false, json: false });

    expect(errSpy).toHaveBeenCalledWith("server noise");
    expect(errSpy).toHaveBeenCalledWith("server info");
    expect(stdout.join("")).not.toContain("server noise");
    expect(console.log).toBe(originalLog);
  });

  it("records the callable tool names (CLI-owned ones excluded) for shell completion", async () => {
    sessionState.open = async () => fakeSession();
    process.argv = ["node", "tea-rags", "call", "--list"];

    await runHandler({ list: true, json: false });

    expect(recallCallToolNames(dataDir)).toEqual(["echo_tool"]);
    expect(stdout.join("")).toContain("Echo the arguments back.");
    expect(stdout.join("")).not.toContain("Second sentence");
    expect(exitCodes).toEqual([0]);
  });

  it("restores console and still exits when the server cannot start", async () => {
    const originalLog = console.log;
    sessionState.open = async () => {
      throw new Error("Qdrant unreachable at http://localhost:6333");
    };
    process.argv = ["node", "tea-rags", "call", "echo_tool", "--json"];

    await runHandler({ tool: "echo_tool", list: false, json: true });

    expect(exitCodes).toEqual([1]);
    expect(JSON.parse(stdout.join(""))).toEqual({
      error: { code: "CALL_FAILED", message: "Qdrant unreachable at http://localhost:6333" },
    });
    expect(console.log).toBe(originalLog);
  });
});

describe("runCall — a server that fails to start", () => {
  it("reports the startup failure as CALL_FAILED on stderr with exit 1, without a session to close", async () => {
    const err: string[] = [];
    const out: string[] = [];
    const code = await runCall(
      { tool: "echo_tool", params: "{}" },
      {
        openSession: async () => {
          throw new Error("config: QDRANT_URL is not a URL");
        },
        readStdin: async () => "",
        out: (text) => out.push(text),
        errOut: (text) => err.push(text),
      },
    );

    expect(code).toBe(1);
    expect(err).toEqual(["config: QDRANT_URL is not a URL"]);
    expect(out).toEqual([]);
  });
});
