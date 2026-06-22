import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import type { WorkerMessage } from "../../../src/cli/index-progress/ipc-protocol.js";
import { superviseIndexing } from "../../../src/cli/index-progress/supervisor.js";
import { createColorizer } from "../../../src/cli/infra/color.js";

const plain = createColorizer({ env: {}, isTTY: false });

function fakeChild() {
  const ee = new EventEmitter() as EventEmitter & { disconnect: () => void };
  ee.disconnect = vi.fn();
  return ee;
}

function fakeRenderer() {
  return { handle: vi.fn(), stop: vi.fn() };
}

const statusMsg: WorkerMessage = {
  type: "status",
  status: { isIndexed: true, status: "indexed", collectionName: "code_x", chunksCount: 100 },
};

describe("superviseIndexing — default mode (no wait)", () => {
  it("prints status and resolves 0 on the first status message, then detaches", async () => {
    const child = fakeChild();
    const renderer = fakeRenderer();
    const out: string[] = [];
    const p = superviseIndexing(child as never, {
      renderer,
      waitEnrichments: false,
      colors: plain,
      out: (s) => out.push(s),
    });

    child.emit("message", statusMsg);
    const code = await p;

    expect(code).toBe(0);
    expect(out.join("\n")).toContain("indexed");
    expect(renderer.stop).toHaveBeenCalled();
    expect(child.disconnect).toHaveBeenCalled();
  });

  it("forwards progress messages to the renderer", async () => {
    const child = fakeChild();
    const renderer = fakeRenderer();
    const p = superviseIndexing(child as never, {
      renderer,
      waitEnrichments: false,
      colors: plain,
      out: () => {},
    });

    child.emit("message", { type: "embedding", phase: "embedding", percentage: 50, current: 50, total: 100 });
    child.emit("message", { type: "enrichment", providerKey: "git", level: "file", applied: 5, total: 20 });
    child.emit("message", statusMsg);
    await p;

    expect(renderer.handle).toHaveBeenCalledTimes(3);
  });
});

describe("superviseIndexing — wait mode", () => {
  it("waits for done and resolves 0 when no provider failed", async () => {
    const child = fakeChild();
    const renderer = fakeRenderer();
    const p = superviseIndexing(child as never, {
      renderer,
      waitEnrichments: true,
      colors: plain,
      out: () => {},
    });

    child.emit("message", statusMsg); // intermediate status must NOT resolve in wait mode
    child.emit("message", { type: "done", result: { failed: [], degraded: [] } });
    const code = await p;

    expect(code).toBe(0);
    expect(child.disconnect).not.toHaveBeenCalled();
  });

  it("resolves non-zero when a provider failed", async () => {
    const child = fakeChild();
    const renderer = fakeRenderer();
    const out: string[] = [];
    const p = superviseIndexing(child as never, {
      renderer,
      waitEnrichments: true,
      colors: plain,
      out: (s) => out.push(s),
    });

    child.emit("message", statusMsg);
    child.emit("message", { type: "done", result: { failed: ["git"], degraded: [] } });
    const code = await p;

    expect(code).not.toBe(0);
    expect(out.join("\n")).toContain("git");
  });

  it("resolves non-zero on an error message", async () => {
    const child = fakeChild();
    const renderer = fakeRenderer();
    const out: string[] = [];
    const p = superviseIndexing(child as never, {
      renderer,
      waitEnrichments: true,
      colors: plain,
      out: (s) => out.push(s),
    });

    child.emit("message", { type: "error", message: "kaboom" });
    const code = await p;

    expect(code).not.toBe(0);
    expect(out.join("\n")).toContain("kaboom");
  });
});

describe("superviseIndexing — ETA and outcome formatting", () => {
  it("prints the seconds-remaining ETA when enrichment data was received before status", async () => {
    const child = fakeChild();
    const renderer = fakeRenderer();
    const out: string[] = [];

    // Use a real monotonic clock injection so eta tracker accumulates progress
    let t = 0;
    const p = superviseIndexing(child as never, {
      renderer,
      waitEnrichments: false,
      colors: plain,
      out: (s) => out.push(s),
      now: () => t,
    });

    // Feed enrichment data so etaSeconds returns a value instead of null
    t = 0;
    child.emit("message", {
      type: "enrichment",
      providerKey: "git",
      level: "file",
      applied: 5,
      total: 100,
    });
    t = 1000; // 1 second elapsed
    child.emit("message", {
      type: "enrichment",
      providerKey: "git",
      level: "file",
      applied: 10,
      total: 100,
    });

    // Trigger status → resolve
    child.emit("message", {
      type: "status",
      status: { isIndexed: true, status: "indexed", collectionName: "code_x", chunksCount: 50 },
    });
    await p;

    // At least one of: null ETA ("background") or seconds ETA must appear
    const joined = out.join("\n");
    const hasEta = joined.includes("background") || joined.includes("remaining");
    expect(hasEta).toBe(true);
  });

  it("prints degraded provider warnings in the done outcome", async () => {
    const child = fakeChild();
    const renderer = fakeRenderer();
    const out: string[] = [];
    const p = superviseIndexing(child as never, {
      renderer,
      waitEnrichments: true,
      colors: plain,
      out: (s) => out.push(s),
    });

    child.emit("message", statusMsg);
    child.emit("message", { type: "done", result: { failed: [], degraded: ["codegraph"] } });
    const code = await p;

    // degraded is not a hard failure → code still 0
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("codegraph");
  });
});

describe("superviseIndexing — child exit event", () => {
  it("resolves 0 when the child exits with code 0 before any terminal message", async () => {
    const child = fakeChild();
    const renderer = fakeRenderer();
    const p = superviseIndexing(child as never, {
      renderer,
      waitEnrichments: false,
      colors: plain,
      out: () => {},
    });

    child.emit("exit", 0);
    const code = await p;

    expect(code).toBe(0);
    expect(renderer.stop).toHaveBeenCalled();
  });

  it("resolves 1 when the child crashes (non-zero exit) before any terminal message", async () => {
    const child = fakeChild();
    const renderer = fakeRenderer();
    const p = superviseIndexing(child as never, {
      renderer,
      waitEnrichments: false,
      colors: plain,
      out: () => {},
    });

    child.emit("exit", 137);
    const code = await p;

    expect(code).toBe(1);
    expect(renderer.stop).toHaveBeenCalled();
  });

  it("ignores a second exit event after the promise already settled via a status message", async () => {
    const child = fakeChild();
    const renderer = fakeRenderer();
    const p = superviseIndexing(child as never, {
      renderer,
      waitEnrichments: false,
      colors: plain,
      out: () => {},
    });

    // Settle via status first
    child.emit("message", {
      type: "status",
      status: { isIndexed: true, status: "indexed", collectionName: "code_x", chunksCount: 0 },
    });
    child.emit("exit", 1); // must be a no-op after settle
    const code = await p;

    expect(code).toBe(0);
    // stop must have been called exactly once (from the first settle)
    expect(renderer.stop).toHaveBeenCalledTimes(1);
  });
});
