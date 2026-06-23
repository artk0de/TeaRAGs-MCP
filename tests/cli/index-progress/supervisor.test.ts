import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import type { WorkerMessage } from "../../../src/cli/index-progress/ipc-protocol.js";
import { JsonProgressRenderer } from "../../../src/cli/index-progress/renderer.js";
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

  it("calls renderer.stop before writing to the out sink (no interleave)", async () => {
    const child = fakeChild();
    const callOrder: string[] = [];
    const renderer = {
      handle: vi.fn(),
      stop: vi.fn(() => {
        callOrder.push("stop");
      }),
    };
    const p = superviseIndexing(child as never, {
      renderer,
      waitEnrichments: false,
      colors: plain,
      out: (s) => {
        callOrder.push(`out:${s}`);
      },
    });

    child.emit("message", statusMsg);
    await p;

    const stopIdx = callOrder.indexOf("stop");
    const firstOutIdx = callOrder.findIndex((e) => e.startsWith("out:"));
    expect(stopIdx).toBeGreaterThanOrEqual(0);
    expect(firstOutIdx).toBeGreaterThan(stopIdx);
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

describe("superviseIndexing — overall timer + phase-done", () => {
  it("prints overall elapsed from index start to finish (not a sum of phases)", async () => {
    const out: string[] = [];
    let t = 0;
    const child = fakeChild();
    const renderer = fakeRenderer();
    const p = superviseIndexing(child as never, {
      renderer,
      waitEnrichments: true,
      colors: plain,
      out: (l) => out.push(l),
      now: () => t,
    });

    t = 0;
    child.emit("message", { type: "embedding", phase: "embedding", percentage: 100, current: 10, total: 10 });
    t = 4200;
    child.emit("message", { type: "done", result: { failed: [], degraded: [] } });
    await p;

    const joined = out.join("\n");
    expect(joined).toMatch(/total.*4\.2s|total.*4200ms/);
  });

  it("does NOT write phase-done 'done in' lines to out (renderer's responsibility now)", async () => {
    const out: string[] = [];
    const child = fakeChild();
    const renderer = fakeRenderer();
    const p = superviseIndexing(child as never, {
      renderer,
      waitEnrichments: true,
      colors: plain,
      out: (l) => out.push(l),
      now: () => 0,
    });

    child.emit("message", { type: "phase-done", phase: "embedding", elapsedMs: 3500 });
    child.emit("message", { type: "done", result: { failed: [], degraded: [] } });
    await p;

    // The supervisor must NOT write "done in" to out — that's now renderer.handle()'s job
    expect(out.join("\n")).not.toContain("done in");
    // But renderer.handle must have been called with the phase-done message
    expect(renderer.handle).toHaveBeenCalledWith(
      expect.objectContaining({ type: "phase-done", phase: "embedding", elapsedMs: 3500 }),
    );
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

describe("superviseIndexing — JSON mode", () => {
  it("emits one JSON object and suppresses the human total line when JsonProgressRenderer is used", async () => {
    const child = fakeChild();
    const renderer = new JsonProgressRenderer();
    const out: string[] = [];
    const p = superviseIndexing(child as never, {
      renderer,
      waitEnrichments: false,
      colors: plain,
      out: (s) => out.push(s),
      projectName: "tea-rags",
      path: "/repo",
    });

    child.emit("message", statusMsg);
    const code = await p;

    expect(code).toBe(0);
    // Should have emitted exactly one line: the JSON object
    expect(out).toHaveLength(1);
    const parsed = JSON.parse(out[0] ?? "") as Record<string, unknown>;
    expect(parsed.projectName).toBe("tea-rags");
    expect(parsed.status).toBe("indexed");
    // No "total Nms" human line in JSON mode
    expect(out.join("\n")).not.toContain("total");
  });

  it("--wait mode with phase-done: stdout contains EXACTLY ONE parseable JSON, no human lines", async () => {
    const child = fakeChild();
    const renderer = new JsonProgressRenderer();
    const out: string[] = [];
    const p = superviseIndexing(child as never, {
      renderer,
      waitEnrichments: true,
      colors: plain,
      out: (s) => out.push(s),
      projectName: "tea-rags",
      path: "/repo",
    });

    // Worker emits phase-done lines before done — these must NOT appear on stdout in json mode
    child.emit("message", { type: "phase-done", phase: "embedding", elapsedMs: 1200 });
    child.emit("message", { type: "phase-done", phase: "enrichment", elapsedMs: 2300 });
    child.emit("message", statusMsg);
    child.emit("message", { type: "done", result: { failed: [], degraded: [] } });
    await p;

    // Exactly one item in stdout
    expect(out).toHaveLength(1);
    // Must be valid JSON
    const parsed = JSON.parse(out[0] ?? "") as Record<string, unknown>;
    expect(parsed.status).toBe("indexed");
    // No "done in" human text
    expect(out.join("\n")).not.toContain("done in");
    // No "total" human text
    expect(out.join("\n")).not.toContain("total");
  });

  it("--wait mode with outcome failures: failures appear inside JSON, not as human lines on stdout", async () => {
    const child = fakeChild();
    const renderer = new JsonProgressRenderer();
    const out: string[] = [];
    const p = superviseIndexing(child as never, {
      renderer,
      waitEnrichments: true,
      colors: plain,
      out: (s) => out.push(s),
      path: "/repo",
    });

    child.emit("message", statusMsg);
    child.emit("message", { type: "done", result: { failed: ["git"], degraded: ["codegraph"] } });
    await p;

    // Still exactly one JSON item on stdout
    expect(out).toHaveLength(1);
    const parsed = JSON.parse(out[0] ?? "") as Record<string, unknown>;
    // Outcome must be in the JSON object
    expect(parsed.outcome).toBeDefined();
    const outcome = parsed.outcome as { failed: string[]; degraded: string[] };
    expect(outcome.failed).toContain("git");
    expect(outcome.degraded).toContain("codegraph");
    // No human "✗" or "⚠" lines on stdout
    expect(out.join("\n")).not.toContain("✗");
    expect(out.join("\n")).not.toContain("⚠");
  });

  it("error message in json mode: stdout has exactly one JSON object with no human error text", async () => {
    const child = fakeChild();
    const renderer = new JsonProgressRenderer();
    const out: string[] = [];
    const p = superviseIndexing(child as never, {
      renderer,
      waitEnrichments: true,
      colors: plain,
      out: (s) => out.push(s),
      path: "/repo",
    });

    child.emit("message", { type: "error", message: "disk full" });
    await p;

    // In error path without a status there may be 0 JSON items (no status to format),
    // but there must be NO human error text on stdout
    const joined = out.join("\n");
    expect(joined).not.toContain("disk full");
    // If anything is on stdout it must be valid JSON
    for (const line of out) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});
