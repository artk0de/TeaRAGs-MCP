import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type { RustInventorySite } from "../../scripts/lib/rust-codegraph-inventory.js";
import {
  collectRustOracleObservations,
  RustOracleRequestFailure,
  type RustOracleRpc,
  type RustOracleSessionOptions,
} from "../../scripts/lib/rust-codegraph-oracle-session.js";
import type { RustOracleRange } from "../../scripts/lib/rust-codegraph-oracle.js";

const corpusRoot = process.cwd();
const relPath = "src/lib.rs";
const range = (line: number, start: number, end: number): RustOracleRange => ({
  start: { line, character: start },
  end: { line, character: end },
});
const site = (
  start = 12,
  path = relPath,
): RustInventorySite & { dispatch: "concrete" | "trait"; complete?: boolean } => ({
  key: `${path}:${start}`,
  relPath: path,
  expressionRange: range(1, start, start + 7),
  tokenRange: range(1, start, start + 4),
  provenance: "source",
  cfg: { status: "unconditional", attributes: [] },
  ownerKey: null,
  callee: { kind: "method", name: "call", uncertainty: ["dispatchUnknown"] },
  dispatch: "concrete",
});

function fakeRpc(
  answer: (method: string, params: object, timeoutMs: number) => unknown = (method) =>
    method === "initialize" ? { capabilities: { definitionProvider: true, positionEncoding: "utf-16" } } : null,
) {
  const calls: { method: string; params: object; timeoutMs?: number }[] = [];
  const rpc: RustOracleRpc = {
    request: vi.fn(async (method, params, timeoutMs) => {
      calls.push({ method, params, timeoutMs });
      return answer(method, params, timeoutMs);
    }),
    notify: vi.fn((method, params) => {
      calls.push({ method, params });
    }),
    kill: vi.fn(),
  };
  return { rpc, calls };
}

function options(rpc: RustOracleRpc, sites: RustOracleSessionOptions["sites"] = [site()]): RustOracleSessionOptions {
  return {
    corpusRoot,
    executable: "/explicit/pinned/rust-analyzer",
    sites,
    readSource: vi.fn(async () => 'fn run() { let s = "🦀"; obj.call(); obj.call(); }'),
    createClient: vi.fn(() => rpc),
  };
}

const methods = (calls: ReturnType<typeof fakeRpc>["calls"]) => calls.map((call) => call.method);

describe("collectRustOracleObservations", () => {
  it("initializes the canonical workspace with UTF-16 definitions, pinned no-execution settings and explicit Cargo choices", async () => {
    const { rpc, calls } = fakeRpc();
    const opts = options(rpc);
    opts.cargo = { features: ["web", "serde"], target: "x86_64-unknown-linux-gnu", allTargets: false };
    const result = await collectRustOracleObservations(opts);
    const init = calls[0].params as Record<string, any>;
    const rootUri = pathToFileURL(resolve(corpusRoot)).href;
    expect(calls[0]).toMatchObject({ method: "initialize", timeoutMs: expect.any(Number) });
    expect(init).toMatchObject({
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: expect.any(String) }],
      capabilities: {
        general: { positionEncodings: ["utf-16"] },
        textDocument: { definition: { linkSupport: true } },
      },
    });
    expect(result.settings).toMatchObject({
      "rust-analyzer": {
        checkOnSave: false,
        cargo: {
          buildScripts: { enable: false },
          features: ["web", "serde"],
          target: "x86_64-unknown-linux-gnu",
          allTargets: false,
        },
        procMacro: { enable: false },
        references: { excludeTests: false },
      },
    });
    expect(result.limitations).toEqual(
      expect.arrayContaining([
        expect.stringContaining("buildScripts"),
        expect.stringContaining("procMacro"),
        expect.stringContaining("web"),
        expect.stringContaining("x86_64-unknown-linux-gnu"),
        expect.stringContaining("allTargets=false"),
      ]),
    );
    expect(methods(calls)).toEqual([
      "initialize",
      "initialized",
      "workspace/didChangeConfiguration",
      "textDocument/didOpen",
      "textDocument/definition",
      "textDocument/didClose",
      "shutdown",
      "exit",
    ]);
    expect(rpc.kill).toHaveBeenCalledOnce();
  });

  it.each([
    [{ capabilities: { definitionProvider: false, positionEncoding: "utf-16" } }, "unsupportedDefinitionProvider"],
    [{ capabilities: { definitionProvider: true, positionEncoding: "utf-8" } }, "unsupportedPositionEncoding"],
    [null, "unsupportedInitializeResponse"],
  ] as const)("returns unsupported rather than issuing definitions for %j", async (reply, reason) => {
    const { rpc, calls } = fakeRpc((method) => (method === "initialize" ? reply : null));
    const result = await collectRustOracleObservations(options(rpc));
    expect(result.status).toBe("unsupported");
    expect(result.observations).toEqual([]);
    expect(result.skipped).toMatchObject([{ reason }]);
    expect(result.inventoryCount).toBe(1);
    expect(methods(calls)).toEqual(["initialize", "shutdown", "exit"]);
    expect(rpc.kill).toHaveBeenCalledOnce();
  });

  it("treats omitted encoding as UTF-16 and refuses an absent definition provider", async () => {
    const { rpc } = fakeRpc((method) => (method === "initialize" ? { capabilities: { definitionProvider: {} } } : []));
    const result = await collectRustOracleObservations(options(rpc));
    expect(result.status).toBe("ok");
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].response).toEqual({ kind: "success", value: [] });
  });

  it("uses supplied same-line Unicode UTF-16 token coordinates unchanged and restores input order", async () => {
    const { rpc, calls } = fakeRpc((method, params) => {
      if (method === "initialize") return { capabilities: { definitionProvider: true, positionEncoding: "utf-16" } };
      return method === "textDocument/definition" &&
        (params as { position: { character: number } }).position.character === 40
        ? []
        : null;
    });
    const later = site(36);
    const earlier = site(24);
    const opts = options(rpc, [later, earlier, { ...site(40, "src/other.rs"), dispatch: "trait", complete: true }]);
    const result = await collectRustOracleObservations(opts);
    const definitions = calls.filter((call) => call.method === "textDocument/definition");
    expect(definitions.map((call) => (call.params as any).position)).toEqual([
      later.tokenRange!.start,
      earlier.tokenRange!.start,
      { line: 1, character: 40 },
    ]);
    expect(result.observations.map(({ site: source }) => source.tokenRange.start.character)).toEqual([36, 24, 40]);
    expect(result.observations.map(({ complete }) => complete)).toEqual([false, false, true]);
    expect(result.observations[2].site.dispatch).toBe("trait");
    expect(calls.filter((call) => call.method === "textDocument/didOpen")).toHaveLength(2);
    expect(calls.filter((call) => call.method === "textDocument/didClose")).toHaveLength(2);
  });

  it("does not call the analyzer for missing token ranges and retains total inventory count", async () => {
    const { rpc, calls } = fakeRpc();
    const missing = { ...site(3), tokenRange: undefined };
    const result = await collectRustOracleObservations(options(rpc, [missing, site(15)]));
    expect(result.inventoryCount).toBe(2);
    expect(result.skipped).toMatchObject([{ site: missing, reason: "missingTokenRange" }]);
    expect(result.observations).toHaveLength(1);
    expect(calls.filter((call) => call.method === "textDocument/definition")).toHaveLength(1);
  });

  it("keeps null success as unknown evidence rather than inventing a timeout", async () => {
    const { rpc } = fakeRpc();
    const result = await collectRustOracleObservations(options(rpc));
    expect(result.observations).toMatchObject([{ response: { kind: "success", value: null }, complete: false }]);
  });

  it("retains typed timeouts and ordinary errors separately, then closes documents despite per-site failures", async () => {
    let attempts = 0;
    const { rpc, calls } = fakeRpc((method) => {
      if (method === "initialize") return { capabilities: { definitionProvider: true } };
      if (method === "textDocument/definition" && attempts++ === 0) throw new RustOracleRequestFailure("timeout");
      throw new Error("definition failed");
    });
    const result = await collectRustOracleObservations(options(rpc, [site(12), site(30)]));
    expect(result.observations.map(({ response }) => response)).toEqual([{ kind: "timeout" }, { kind: "error" }]);
    expect(methods(calls).slice(-3)).toEqual(["textDocument/didClose", "shutdown", "exit"]);
    expect(rpc.kill).toHaveBeenCalledOnce();
  });

  it("keeps an unreadable source explicitly unknown without opening a document", async () => {
    const { rpc, calls } = fakeRpc();
    const opts = options(rpc);
    opts.readSource = vi.fn(async () => {
      throw new Error("ENOENT");
    });
    const result = await collectRustOracleObservations(opts);
    expect(result.observations).toMatchObject([{ response: { kind: "error" }, complete: false }]);
    expect(result.limitations).toContain(`documentUnreadable:${relPath}`);
    expect(methods(calls)).toEqual([
      "initialize",
      "initialized",
      "workspace/didChangeConfiguration",
      "shutdown",
      "exit",
    ]);
  });

  it("still kills on initialization/configuration/didOpen failures and never leaves an open document", async () => {
    const { rpc, calls } = fakeRpc();
    rpc.notify = vi.fn((method, params) => {
      calls.push({ method, params });
      if (method === "textDocument/didOpen") throw new Error("open failed");
    });
    const result = await collectRustOracleObservations(options(rpc));
    expect(result.observations).toMatchObject([{ response: { kind: "error" }, complete: false }]);
    expect(methods(calls).slice(-3)).toEqual(["textDocument/didClose", "shutdown", "exit"]);
    expect(rpc.kill).toHaveBeenCalledOnce();
  });

  it("kills the client when shutdown rejects, without masking observations", async () => {
    const { rpc, calls } = fakeRpc((method) => {
      if (method === "shutdown") throw new Error("server gone");
      if (method === "initialize") return { capabilities: { definitionProvider: true } };
      return [];
    });
    const result = await collectRustOracleObservations(options(rpc));
    expect(result.observations).toMatchObject([{ response: { kind: "success", value: [] } }]);
    expect(methods(calls).slice(-2)).toEqual(["shutdown", "exit"]);
    expect(rpc.kill).toHaveBeenCalledOnce();
  });

  it("bounds a shutdown request that never resolves, then sends exit and kills", async () => {
    vi.useFakeTimers();
    try {
      const { rpc, calls } = fakeRpc(async (method) => {
        if (method === "initialize") return { capabilities: { definitionProvider: true } };
        if (method === "shutdown") return new Promise(() => undefined);
        return [];
      });
      const pending = collectRustOracleObservations(options(rpc));
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await pending;
      expect(result.limitations).toContain("shutdownFailed");
      expect(methods(calls).slice(-2)).toEqual(["shutdown", "exit"]);
      expect(rpc.kill).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports an explicit default spawn failure without starting a client", async () => {
    const opts = options(fakeRpc().rpc);
    delete opts.createClient;
    const result = await collectRustOracleObservations(opts);
    expect(result.status).toBe("error");
    expect(result.skipped).toMatchObject([{ reason: "rustAnalyzerUnavailable" }]);
    expect(result.observations).toEqual([]);
  });
});
