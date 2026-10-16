import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { LspClient, type LspLauncher } from "../../scripts/py-oracle/lsp_oracle.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

const launcher: LspLauncher = {
  command: ["/fake/server", "--stdio"],
  settings: { python: { analysis: { extraPaths: ["/repo/src"] }, pythonPath: "/venv/bin/python" } },
  env: {},
};

function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  const sent: Record<string, unknown>[] = [];
  child.stdin.on("data", (data: Buffer) => {
    const encoded = data.toString("utf8");
    sent.push(JSON.parse(encoded.slice(encoded.indexOf("\r\n\r\n") + 4)) as Record<string, unknown>);
  });
  return { child, sent };
}

function frame(payload: object): Buffer {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...payload }), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
}

function clientFor(child: ReturnType<typeof fakeChild>["child"]) {
  const spawner = vi.fn(() => child as unknown as ChildProcessWithoutNullStreams);
  vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcessWithoutNullStreams);
  const client = new LspClient(launcher, "/repo", spawner as unknown as typeof spawn);
  return { client, spawner };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("LspClient transport", () => {
  it("uses the injected child spawner without changing existing constructor arguments", () => {
    const { child } = fakeChild();
    const { client, spawner } = clientFor(child);
    expect(spawner).toHaveBeenCalledWith("/fake/server", ["--stdio"], {
      cwd: "/repo",
      env: launcher.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(spawn).not.toHaveBeenCalled();
    client.kill();
  });

  it("preserves a real null response across fragmented UTF-8 frames", async () => {
    const { child, sent } = fakeChild();
    const { client } = clientFor(child);
    const result = client.request("textDocument/definition", {});
    const message = frame({ id: 1, result: null, note: "🦀" });
    const emoji = message.indexOf(Buffer.from("🦀"));
    child.stdout.write(message.subarray(0, emoji + 2));
    child.stdout.write(message.subarray(emoji + 2));
    await expect(result).resolves.toBeNull();
    expect(sent[0]).toMatchObject({ id: 1, method: "textDocument/definition" });
    client.kill();
  });

  it("responds to each workspace/configuration item and echoes a string server id", async () => {
    const { child, sent } = fakeChild();
    const { client } = clientFor(child);
    child.stdout.write(
      frame({
        id: "config-7",
        method: "workspace/configuration",
        params: { items: [{ section: "python.analysis" }, { section: "python.pythonPath" }, { section: "missing" }] },
      }),
    );
    expect(sent).toEqual([
      {
        jsonrpc: "2.0",
        id: "config-7",
        result: [{ extraPaths: ["/repo/src"] }, "/venv/bin/python", null],
      },
    ]);
    client.kill();
  });

  it("ignores server notifications without an id while an oracle request remains pending", async () => {
    const { child, sent } = fakeChild();
    const { client } = clientFor(child);
    const pending = client.request("initialize", {});
    child.stdout.write(frame({ method: "window/logMessage", params: { type: 3, message: "indexing" } }));
    child.stdout.write(frame({ id: 1, result: null }));
    await expect(pending).resolves.toBeNull();
    expect(sent).toHaveLength(1);
    client.kill();
  });

  it("rejects a timed-out request as timeout, not a successful null, and clears its timer", async () => {
    vi.useFakeTimers();
    const { child } = fakeChild();
    const { client } = clientFor(child);
    const timedOut = client.request("textDocument/definition", {}, 42);
    const failure = expect(timedOut).rejects.toMatchObject({ name: "LspRequestTimeoutError" });
    await vi.advanceTimersByTimeAsync(42);
    await failure;
    expect(vi.getTimerCount()).toBe(0);
    const later = client.request("shutdown", {}, 42);
    child.stdout.write(frame({ id: 2, result: null }));
    await expect(later).resolves.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    client.kill();
  });

  it("rejects JSON-RPC errors with code and message while leaving the connection usable", async () => {
    const { child } = fakeChild();
    const { client } = clientFor(child);
    const failed = client.request("textDocument/definition", {});
    child.stdout.write(frame({ id: 1, error: { code: -32601, message: "method missing" } }));
    await expect(failed).rejects.toMatchObject({ name: "LspRpcError", code: -32601, message: "method missing" });
    const next = client.request("shutdown", {});
    child.stdout.write(frame({ id: 2, result: null }));
    await expect(next).resolves.toBeNull();
    client.kill();
  });

  it("rejects all pending and future requests on asynchronous spawn failure", async () => {
    const { child } = fakeChild();
    const { client } = clientFor(child);
    const first = client.request("initialize", {});
    const second = client.request("textDocument/definition", {});
    const firstFailed = expect(first).rejects.toMatchObject({
      name: "LspTransportError",
      message: expect.stringContaining("ENOENT"),
    });
    const secondFailed = expect(second).rejects.toMatchObject({ name: "LspTransportError" });
    expect(() => child.emit("error", new Error("spawn ENOENT"))).not.toThrow();
    await Promise.all([firstFailed, secondFailed]);
    await expect(client.request("shutdown", {})).rejects.toMatchObject({ name: "LspTransportError" });
    client.kill();
  });

  it("rejects pending and future requests when the server exits before replying", async () => {
    const { child } = fakeChild();
    const { client } = clientFor(child);
    const failed = client.request("initialize", {});
    const rejection = expect(failed).rejects.toMatchObject({
      name: "LspTransportError",
      message: expect.stringContaining("17"),
    });
    expect(() => child.emit("exit", 17, null)).not.toThrow();
    await rejection;
    await expect(client.request("shutdown", {})).rejects.toMatchObject({ name: "LspTransportError" });
    client.kill();
  });

  it("rejects on stdin failure instead of leaving a request pending", async () => {
    const { child } = fakeChild();
    const { client } = clientFor(child);
    const failed = client.request("initialize", {});
    const rejection = expect(failed).rejects.toMatchObject({ name: "LspTransportError" });
    expect(() => child.stdin.emit("error", new Error("EPIPE"))).not.toThrow();
    await rejection;
    client.kill();
  });

  it("converts a synchronous write failure to a rejected request", async () => {
    const { child } = fakeChild();
    const { client } = clientFor(child);
    vi.spyOn(child.stdin, "write").mockImplementation(() => {
      throw new Error("broken pipe");
    });
    await expect(client.request("initialize", {})).rejects.toMatchObject({
      name: "LspTransportError",
      message: expect.stringContaining("broken pipe"),
    });
    client.kill();
  });

  it.each([
    ["missing length", Buffer.from("X-Other: 1\r\n\r\n{}")],
    ["unsafe length", Buffer.from("Content-Length: 536870912\r\n\r\n")],
    ["invalid JSON", Buffer.from("Content-Length: 1\r\n\r\n{")],
  ])("rejects malformed %s frames without throwing from the data callback", async (_label, bytes) => {
    const { child } = fakeChild();
    const { client } = clientFor(child);
    const failed = client.request("initialize", {});
    const rejection = expect(failed).rejects.toMatchObject({ name: "LspTransportError" });
    expect(() => child.stdout.write(bytes)).not.toThrow();
    await rejection;
    await expect(client.request("shutdown", {})).rejects.toMatchObject({ name: "LspTransportError" });
    client.kill();
  });

  it.each([
    ["missing result and error", { id: 1 }],
    ["result alongside error", { id: 1, result: null, error: { code: -32601, message: "bad" } }],
    ["non-string method", { id: 1, method: 5, params: {} }],
  ])("rejects %s frames and settles all pending requests", async (_label, message) => {
    const { child } = fakeChild();
    const { client } = clientFor(child);
    const first = client.request("initialize", {});
    const second = client.request("textDocument/definition", {});
    const firstRejected = expect(first).rejects.toMatchObject({ name: "LspTransportError" });
    const secondRejected = expect(second).rejects.toMatchObject({ name: "LspTransportError" });
    expect(() => child.stdout.write(frame(message))).not.toThrow();
    await Promise.all([firstRejected, secondRejected]);
    client.kill();
  });

  it("rejects malformed JSON-RPC errors together with other pending requests", async () => {
    const { child } = fakeChild();
    const { client } = clientFor(child);
    const first = client.request("initialize", {});
    const second = client.request("textDocument/definition", {});
    const firstRejected = expect(first).rejects.toMatchObject({ name: "LspTransportError" });
    const secondRejected = expect(second).rejects.toMatchObject({ name: "LspTransportError" });
    expect(() => child.stdout.write(frame({ id: 1, error: { code: "bad", message: "invalid" } }))).not.toThrow();
    await Promise.all([firstRejected, secondRejected]);
    client.kill();
  });

  it("settles pending requests and clears their timers when killed twice", async () => {
    vi.useFakeTimers();
    const { child } = fakeChild();
    const { client } = clientFor(child);
    const pending = client.request("initialize", {});
    const rejection = expect(pending).rejects.toMatchObject({ name: "LspTransportError" });
    client.kill();
    client.kill();
    await rejection;
    expect(child.kill).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await expect(client.request("shutdown", {})).rejects.toMatchObject({ name: "LspTransportError" });
  });
});
