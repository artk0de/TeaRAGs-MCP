import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkerMessage } from "../../../src/cli/index-progress/ipc-protocol.js";
import { computeEtaSeconds } from "../../../src/cli/index-progress/phase-tracker.js";
import {
  barTimeFields,
  buildBarLine,
  countdownEta,
  createRenderer,
  formatEta,
  formatProgressLine,
  JsonProgressRenderer,
  LineProgressRenderer,
  TtyProgressRenderer,
} from "../../../src/cli/index-progress/renderer.js";
import { createColorizer } from "../../../src/cli/infra/color.js";

// ---------------------------------------------------------------------------
// cli-progress mock — must be declared via vi.hoisted so the factory closure
// runs before ESM static imports are evaluated (vi.mock is hoisted to the top
// but variable initializers are not).
// ---------------------------------------------------------------------------
const { mockSingleBar, mockMultibar } = vi.hoisted(() => {
  const mockSingleBar = {
    update: vi.fn(),
    setTotal: vi.fn(),
  };
  const mockMultibar = {
    create: vi.fn().mockReturnValue(mockSingleBar),
    stop: vi.fn(),
    log: vi.fn(),
  };
  return { mockSingleBar, mockMultibar };
});

vi.mock("cli-progress", () => ({
  default: {
    // Must be a real class/constructor — vi.fn() alone is not newable in this context
    MultiBar: class {
      create = mockMultibar.create;
      stop = mockMultibar.stop;
      log = mockMultibar.log;
    },
    Presets: { shades_classic: {} },
  },
}));

describe("formatProgressLine", () => {
  it("formats an embedding message", () => {
    const line = formatProgressLine({ type: "embedding", phase: "embedding", percentage: 45, current: 45, total: 100 });
    expect(line).toContain("embedding");
    expect(line).toContain("45%");
  });

  it("formats an enrichment message with provider, level and counts", () => {
    const line = formatProgressLine({ type: "enrichment", providerKey: "git", level: "chunk", applied: 10, total: 20 });
    expect(line).toContain("git");
    expect(line).toContain("chunk");
    expect(line).toContain("10");
    expect(line).toContain("20");
  });

  it("renders fixed-width label before the counts", () => {
    expect(
      formatProgressLine({ type: "enrichment", providerKey: "git", level: "file", applied: 120, total: 120 }),
    ).toBe("git file              120/120 (100%)");
  });

  it("renders embedding with chunk/sec rate when throughput present", () => {
    const line = formatProgressLine({
      type: "embedding",
      phase: "embedding",
      percentage: 80,
      current: 80,
      total: 100,
      throughput: 42.5,
    });
    expect(line).toContain("42.5 ch/s");
  });

  it("renders embedding without rate segment when throughput absent", () => {
    const line = formatProgressLine({ type: "embedding", phase: "embedding", percentage: 80, current: 80, total: 100 });
    expect(line).not.toContain("ch/s");
  });

  it("guards percentage when total is zero", () => {
    const line = formatProgressLine({ type: "enrichment", providerKey: "git", level: "file", applied: 0, total: 0 });
    expect(line).toContain("0%");
  });

  it("formats an error message", () => {
    expect(formatProgressLine({ type: "error", message: "boom" })).toContain("boom");
  });

  it("returns null for status/done (not progress lines)", () => {
    expect(formatProgressLine({ type: "done", result: { failed: [], degraded: [] } })).toBeNull();
    expect(formatProgressLine({ type: "status", status: { isIndexed: true, status: "indexed" } })).toBeNull();
  });
});

describe("LineProgressRenderer", () => {
  it("writes a line per progress message via the injected sink", () => {
    const written: string[] = [];
    const r = new LineProgressRenderer((s) => written.push(s));
    r.handle({ type: "embedding", phase: "embedding", percentage: 10, current: 10, total: 100 });
    r.handle({ type: "enrichment", providerKey: "git", level: "file", applied: 5, total: 20 });
    expect(written).toHaveLength(2);
    expect(written[0]).toContain("10%");
    expect(written[1]).toContain("git");
  });

  it("suppresses duplicate consecutive lines (throttle spam)", () => {
    const written: string[] = [];
    const r = new LineProgressRenderer((s) => written.push(s));
    const msg: WorkerMessage = { type: "embedding", phase: "embedding", percentage: 10, current: 10, total: 100 };
    r.handle(msg);
    r.handle(msg);
    expect(written).toHaveLength(1);
  });

  it("ignores non-progress messages (status/done)", () => {
    const written: string[] = [];
    const r = new LineProgressRenderer((s) => written.push(s));
    r.handle({ type: "done", result: { failed: [], degraded: [] } });
    expect(written).toHaveLength(0);
  });

  it("stop() is a no-op (no persistent resource to release)", () => {
    const r = new LineProgressRenderer(() => {});
    expect(() => {
      r.stop();
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// TtyProgressRenderer — drives the mocked cli-progress MultiBar
// ---------------------------------------------------------------------------
describe("TtyProgressRenderer", () => {
  const colors = createColorizer({ env: {}, isTTY: false });

  beforeEach(() => {
    mockMultibar.create.mockClear();
    mockMultibar.stop.mockClear();
    mockMultibar.log.mockClear();
    mockSingleBar.update.mockClear();
    mockSingleBar.setTotal.mockClear();
    mockMultibar.create.mockReturnValue(mockSingleBar);
  });

  it("stop() delegates to multibar.stop()", () => {
    const r = new TtyProgressRenderer(colors);
    r.stop();
    expect(mockMultibar.stop).toHaveBeenCalledTimes(1);
  });

  it("creates and updates the embedding bar on the first embedding message", () => {
    const r = new TtyProgressRenderer(colors);
    r.handle({ type: "embedding", phase: "embedding", percentage: 20, current: 20, total: 100 });

    expect(mockMultibar.create).toHaveBeenCalledWith(100, 0, expect.objectContaining({ label: expect.any(String) }));
    expect(mockSingleBar.update).toHaveBeenCalledWith(20, expect.any(Object));
    expect(mockSingleBar.setTotal).toHaveBeenCalledWith(100);
  });

  it("reuses the existing embedding bar on subsequent embedding messages", () => {
    const r = new TtyProgressRenderer(colors);
    r.handle({ type: "embedding", phase: "embedding", percentage: 10, current: 10, total: 100 });
    r.handle({ type: "embedding", phase: "embedding", percentage: 50, current: 50, total: 100 });

    expect(mockMultibar.create).toHaveBeenCalledTimes(1);
    expect(mockSingleBar.update).toHaveBeenCalledTimes(2);
  });

  it("creates an enrichment bar per provider+level key and updates it", () => {
    const r = new TtyProgressRenderer(colors);
    r.handle({ type: "enrichment", providerKey: "git", level: "file", applied: 5, total: 20 });

    expect(mockMultibar.create).toHaveBeenCalledWith(
      20,
      0,
      expect.objectContaining({ label: expect.stringContaining("git file") }),
    );
    expect(mockSingleBar.setTotal).toHaveBeenCalledWith(20);
    expect(mockSingleBar.update).toHaveBeenCalledWith(
      5,
      expect.objectContaining({ label: expect.stringContaining("git file") }),
    );
  });

  it("reuses the enrichment bar for the same provider+level on subsequent messages", () => {
    const r = new TtyProgressRenderer(colors);
    r.handle({ type: "enrichment", providerKey: "git", level: "chunk", applied: 3, total: 10 });
    r.handle({ type: "enrichment", providerKey: "git", level: "chunk", applied: 7, total: 10 });

    expect(mockMultibar.create).toHaveBeenCalledTimes(1);
  });

  it("creates separate bars for different provider+level combinations", () => {
    const r = new TtyProgressRenderer(colors);
    r.handle({ type: "enrichment", providerKey: "git", level: "file", applied: 1, total: 5 });
    r.handle({ type: "enrichment", providerKey: "git", level: "chunk", applied: 1, total: 5 });

    expect(mockMultibar.create).toHaveBeenCalledTimes(2);
  });

  it("ignores non-progress message types (status/done/error)", () => {
    const r = new TtyProgressRenderer(colors);
    r.handle({ type: "status", status: { isIndexed: true, status: "indexed" } });
    r.handle({ type: "done", result: { failed: [], degraded: [] } });
    r.handle({ type: "error", message: "oops" });

    expect(mockMultibar.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// createRenderer — factory selects the correct implementation
// ---------------------------------------------------------------------------
describe("createRenderer", () => {
  const colors = createColorizer({ env: {}, isTTY: false });

  beforeEach(() => {
    mockMultibar.create.mockClear();
    mockMultibar.stop.mockClear();
    mockMultibar.log.mockClear();
    mockSingleBar.update.mockClear();
    mockSingleBar.setTotal.mockClear();
    mockMultibar.create.mockReturnValue(mockSingleBar);
  });

  it("returns a TtyProgressRenderer when isTTY is true", () => {
    const r = createRenderer({ isTTY: true, colors });
    expect(r).toBeInstanceOf(TtyProgressRenderer);
  });

  it("returns a LineProgressRenderer when isTTY is false", () => {
    const r = createRenderer({ isTTY: false, colors });
    expect(r).toBeInstanceOf(LineProgressRenderer);
  });

  it("uses the injected sink for LineProgressRenderer when provided", () => {
    const written: string[] = [];
    const r = createRenderer({ isTTY: false, colors, sink: (s) => written.push(s) });
    r.handle({ type: "embedding", phase: "embedding", percentage: 75, current: 75, total: 100 });
    expect(written).toHaveLength(1);
    expect(written[0]).toContain("75%");
  });

  it("returns a JsonProgressRenderer when json is true", () => {
    const r = createRenderer({ isTTY: true, colors, json: true });
    expect(r).toBeInstanceOf(JsonProgressRenderer);
  });
});

// ---------------------------------------------------------------------------
// JsonProgressRenderer — no-op bars, state collection for JSON mode
// ---------------------------------------------------------------------------
describe("JsonProgressRenderer", () => {
  it("records the latest status from status messages", () => {
    const r = new JsonProgressRenderer();
    r.handle({ type: "status", status: { isIndexed: true, status: "indexed" } });
    expect(r.latestStatus?.status).toBe("indexed");
  });

  it("records phase-done timings", () => {
    const r = new JsonProgressRenderer();
    r.handle({ type: "phase-done", phase: "embedding", elapsedMs: 1500 });
    expect(r.phases["embedding"]).toBe(1500);
  });

  it("records done outcome", () => {
    const r = new JsonProgressRenderer();
    r.handle({ type: "done", result: { failed: ["git"], degraded: [] } });
    expect(r.outcome?.failed).toEqual(["git"]);
  });

  it("records error message", () => {
    const r = new JsonProgressRenderer();
    r.handle({ type: "error", message: "something went wrong" });
    expect(r.error).toBe("something went wrong");
  });

  it("ignores embedding and enrichment progress messages (no-op bars)", () => {
    const r = new JsonProgressRenderer();
    r.handle({ type: "embedding", phase: "embedding", percentage: 50, current: 50, total: 100 });
    r.handle({ type: "enrichment", providerKey: "git", level: "file", applied: 5, total: 20 });
    expect(r.latestStatus).toBeUndefined();
    expect(r.outcome).toBeUndefined();
  });

  it("stop() is a no-op", () => {
    const r = new JsonProgressRenderer();
    expect(() => {
      r.stop();
    }).not.toThrow();
  });
});

// This will fail until formatEta is exported from renderer.ts
describe("formatEta", () => {
  it("returns empty string for null (no throughput yet)", () => {
    expect(formatEta(null)).toBe("");
  });

  it("returns empty string for zero (complete — nothing remaining)", () => {
    expect(formatEta(0)).toBe("");
  });

  it("formats seconds under 60 with ceil", () => {
    expect(formatEta(5)).toBe("~5s");
    expect(formatEta(5.2)).toBe("~6s");
    expect(formatEta(59.9)).toBe("~60s");
  });

  it("formats minutes when >= 60 seconds", () => {
    expect(formatEta(90)).toBe("~1.5m");
    expect(formatEta(120)).toBe("~2.0m");
  });

  it("composes correctly with computeEtaSeconds: returns sensible value after partial progress", () => {
    // 100 units applied, 3040 total, 10s elapsed → remaining=2940, rate=10/s → 294s → ~4.9m
    const eta = formatEta(computeEtaSeconds(100, 3040, 10_000));
    expect(eta).toMatch(/^~\d+(\.\d+)?[sm]$/);
    expect(eta).not.toBe("");
  });

  it("composes correctly with computeEtaSeconds: blank at applied=0", () => {
    expect(formatEta(computeEtaSeconds(0, 3040, 0))).toBe("");
  });
});

// ETA wiring in TtyProgressRenderer — injected clock + per-bar start tracking
describe("TtyProgressRenderer ETA wiring", () => {
  const colors = createColorizer({ env: {}, isTTY: false });
  let nowMs = 0;
  const fakeClock = () => nowMs;

  beforeEach(() => {
    nowMs = 0;
    mockMultibar.create.mockClear();
    mockMultibar.stop.mockClear();
    mockMultibar.log.mockClear();
    mockSingleBar.update.mockClear();
    mockSingleBar.setTotal.mockClear();
    mockMultibar.create.mockReturnValue(mockSingleBar);
  });

  it("passes eta='' on first embedding message (applied=0 → no throughput)", () => {
    const r = new TtyProgressRenderer(colors, fakeClock);
    r.handle({ type: "embedding", phase: "embedding", percentage: 0, current: 0, total: 3040 });
    // create payload should have eta: ""
    expect(mockMultibar.create).toHaveBeenCalledWith(3040, 0, expect.objectContaining({ eta: "" }));
  });

  it("passes a non-empty eta on subsequent embedding messages with progress and elapsed time", () => {
    const r = new TtyProgressRenderer(colors, fakeClock);
    nowMs = 0;
    r.handle({ type: "embedding", phase: "embedding", percentage: 0, current: 0, total: 3040 });
    nowMs = 10_000; // 10s elapsed
    r.handle({ type: "embedding", phase: "embedding", percentage: 3, current: 100, total: 3040 });
    // update payload should have a non-empty eta
    const updateCalls = mockSingleBar.update.mock.calls;
    const lastPayload = updateCalls[updateCalls.length - 1][1] as Record<string, unknown>;
    expect(lastPayload["eta"]).not.toBe("");
    expect(typeof lastPayload["eta"]).toBe("string");
  });

  it("passes eta='' for enrichment bar at first message (applied=0)", () => {
    const r = new TtyProgressRenderer(colors, fakeClock);
    nowMs = 0;
    r.handle({ type: "enrichment", providerKey: "git", level: "file", applied: 0, total: 1024 });
    expect(mockMultibar.create).toHaveBeenCalledWith(1024, 0, expect.objectContaining({ eta: "" }));
  });

  it("passes a non-empty eta for enrichment after progress and elapsed time", () => {
    const r = new TtyProgressRenderer(colors, fakeClock);
    nowMs = 0;
    r.handle({ type: "enrichment", providerKey: "git", level: "file", applied: 0, total: 1024 });
    nowMs = 5_000;
    r.handle({ type: "enrichment", providerKey: "git", level: "file", applied: 200, total: 1024 });
    const updateCalls = mockSingleBar.update.mock.calls;
    const lastPayload = updateCalls[updateCalls.length - 1][1] as Record<string, unknown>;
    expect(lastPayload["eta"]).not.toBe("");
  });
});

describe("createRenderer — original tests continued", () => {
  const colors = createColorizer({ env: {}, isTTY: false });

  beforeEach(() => {
    mockMultibar.create.mockClear();
    mockMultibar.stop.mockClear();
    mockMultibar.log.mockClear();
    mockSingleBar.update.mockClear();
    mockSingleBar.setTotal.mockClear();
    mockMultibar.create.mockReturnValue(mockSingleBar);
  });

  it("uses process.stderr as the default sink when no sink is provided (non-TTY)", () => {
    const written: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      written.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    });
    try {
      const r = createRenderer({ isTTY: false, colors });
      r.handle({ type: "embedding", phase: "embedding", percentage: 30, current: 30, total: 100 });
      expect(written.join("")).toContain("30%");
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// buildBarLine — pure helper for colored bar line assembly
// ---------------------------------------------------------------------------
describe("buildBarLine", () => {
  const identityColors = createColorizer({ env: { NO_COLOR: "1" }, isTTY: false });

  it("produces plain █/░ glyphs with an identity colorizer", () => {
    const line = buildBarLine({
      label: "test",
      progress: 0.5,
      value: 50,
      total: 100,
      elapsed: "5.0s",
      eta: "~5s",
      rate: "10 ch/s",
      barsize: 10,
      colors: identityColors,
    });
    // half filled: 5 filled + 5 empty
    expect(line).toContain("█".repeat(5));
    expect(line).toContain("░".repeat(5));
  });

  it("wraps the filled segment with brand ANSI codes when colors are enabled", () => {
    const colorColors = createColorizer({ env: { FORCE_COLOR: "1" }, isTTY: true });
    const line = buildBarLine({
      label: "test",
      progress: 0.5,
      value: 50,
      total: 100,
      elapsed: "5.0s",
      eta: "~5s",
      rate: "",
      barsize: 10,
      colors: colorColors,
    });
    // ANSI escape codes present
    expect(line).toContain("\x1b[");
    // The filled portion still has the actual glyph characters
    expect(line).toContain("█");
    expect(line).toContain("░");
  });

  it("clamps displayed value to total when value exceeds total", () => {
    const line = buildBarLine({
      label: "git file",
      progress: 1,
      value: 7328, // overshoot — common live bug
      total: 7325,
      elapsed: "0s",
      eta: "",
      rate: "",
      barsize: 10,
      colors: identityColors,
    });
    // Must show 7325/7325, NOT 7328/7325
    expect(line).toContain("7325/7325");
    expect(line).not.toContain("7328");
  });

  it("places elapsed between percentage and eta", () => {
    const line = buildBarLine({
      label: "emb",
      progress: 0.8,
      value: 80,
      total: 100,
      elapsed: "12.3s",
      eta: "~3s",
      rate: "",
      barsize: 10,
      colors: identityColors,
    });
    const pctIdx = line.indexOf("80%");
    const elapsedIdx = line.indexOf("12.3s");
    const etaIdx = line.indexOf("~3s");
    expect(pctIdx).toBeGreaterThanOrEqual(0);
    expect(elapsedIdx).toBeGreaterThan(pctIdx);
    expect(etaIdx).toBeGreaterThan(elapsedIdx);
  });

  it("includes label and rate in the line", () => {
    const line = buildBarLine({
      label: "embeddings",
      progress: 0.9,
      value: 90,
      total: 100,
      elapsed: "9.0s",
      eta: "",
      rate: "60.8 ch/s",
      barsize: 10,
      colors: identityColors,
    });
    expect(line).toContain("embeddings");
    expect(line).toContain("60.8 ch/s");
  });

  it("handles zero progress (0/0) without NaN or division errors", () => {
    const line = buildBarLine({
      label: "test",
      progress: 0,
      value: 0,
      total: 0,
      elapsed: "0ms",
      eta: "",
      rate: "",
      barsize: 10,
      colors: identityColors,
    });
    expect(line).not.toContain("NaN");
    expect(line).toContain("0%");
  });
});

// ---------------------------------------------------------------------------
// TtyProgressRenderer — value clamping + phase completion
// ---------------------------------------------------------------------------
describe("TtyProgressRenderer — value clamping", () => {
  const colors = createColorizer({ env: {}, isTTY: false });

  beforeEach(() => {
    mockMultibar.create.mockClear();
    mockMultibar.stop.mockClear();
    mockMultibar.log.mockClear();
    mockSingleBar.update.mockClear();
    mockSingleBar.setTotal.mockClear();
    mockMultibar.create.mockReturnValue(mockSingleBar);
  });

  it("clamps embedding bar update to total when value overshoots", () => {
    const r = new TtyProgressRenderer(colors);
    r.handle({ type: "embedding", phase: "embedding", percentage: 100, current: 7328, total: 7325 });
    // update must be called with Math.min(7328, 7325) = 7325
    const updateCalls = mockSingleBar.update.mock.calls;
    expect(updateCalls[0]?.[0]).toBe(7325);
  });

  it("clamps enrichment bar update to total when value overshoots", () => {
    const r = new TtyProgressRenderer(colors);
    r.handle({ type: "enrichment", providerKey: "git", level: "file", applied: 105, total: 100 });
    const updateCalls = mockSingleBar.update.mock.calls;
    expect(updateCalls[0]?.[0]).toBe(100);
  });
});

describe("TtyProgressRenderer — elapsed in payload", () => {
  const colors = createColorizer({ env: {}, isTTY: false });
  let nowMs = 0;

  beforeEach(() => {
    nowMs = 0;
    mockMultibar.create.mockClear();
    mockMultibar.stop.mockClear();
    mockMultibar.log.mockClear();
    mockSingleBar.update.mockClear();
    mockSingleBar.setTotal.mockClear();
    mockMultibar.create.mockReturnValue(mockSingleBar);
  });

  it("passes elapsed string in the payload on embedding update", () => {
    const r = new TtyProgressRenderer(colors, () => nowMs);
    nowMs = 0;
    r.handle({ type: "embedding", phase: "embedding", percentage: 0, current: 0, total: 100 });
    nowMs = 5000;
    r.handle({ type: "embedding", phase: "embedding", percentage: 50, current: 50, total: 100 });
    const updateCalls = mockSingleBar.update.mock.calls;
    const lastPayload = updateCalls[updateCalls.length - 1]?.[1] as Record<string, unknown>;
    expect(typeof lastPayload["elapsed"]).toBe("string");
    expect(lastPayload["elapsed"]).not.toBe("");
    expect(lastPayload["elapsed"]).toContain("5");
  });

  it("passes elapsed string in the payload on enrichment update", () => {
    const r = new TtyProgressRenderer(colors, () => nowMs);
    nowMs = 0;
    r.handle({ type: "enrichment", providerKey: "git", level: "file", applied: 0, total: 100 });
    nowMs = 3000;
    r.handle({ type: "enrichment", providerKey: "git", level: "file", applied: 50, total: 100 });
    const updateCalls = mockSingleBar.update.mock.calls;
    const lastPayload = updateCalls[updateCalls.length - 1]?.[1] as Record<string, unknown>;
    expect(typeof lastPayload["elapsed"]).toBe("string");
    expect(lastPayload["elapsed"]).toContain("3");
  });
});

describe("TtyProgressRenderer — phase-done via multibar.log (legacy: now inline)", () => {
  const colors = createColorizer({ env: {}, isTTY: false });

  beforeEach(() => {
    mockMultibar.create.mockClear();
    mockMultibar.stop.mockClear();
    mockMultibar.log.mockClear();
    mockSingleBar.update.mockClear();
    mockSingleBar.setTotal.mockClear();
    mockMultibar.create.mockReturnValue(mockSingleBar);
  });

  it("does NOT call multibar.log on phase-done (inline bar update instead)", () => {
    const r = new TtyProgressRenderer(colors);
    r.handle({ type: "phase-done", phase: "embedding", elapsedMs: 3500 });
    expect(mockMultibar.log).not.toHaveBeenCalled();
  });

  it("marks embedding bar done inline (fills value to total)", () => {
    const r = new TtyProgressRenderer(colors);
    // Create the embedding bar first
    r.handle({ type: "embedding", phase: "embedding", percentage: 99, current: 7325, total: 7339 });
    mockSingleBar.update.mockClear();
    // Now fire phase-done
    r.handle({ type: "phase-done", phase: "embedding", elapsedMs: 129400 });
    // update must be called with done payload and value filled to total (7339)
    const updateCalls = mockSingleBar.update.mock.calls;
    expect(updateCalls.some((c) => (c[1] as Record<string, unknown>)["done"] !== undefined)).toBe(true);
    // Value MUST be filled to total (7339) on done
    expect(updateCalls.some((c) => c[0] === 7339)).toBe(true);
  });

  it("marks all enrichment bars done inline on enrichment phase-done (fills to total)", () => {
    const r = new TtyProgressRenderer(colors);
    // Create two enrichment bars
    r.handle({ type: "enrichment", providerKey: "git", level: "file", applied: 7000, total: 7325 });
    r.handle({ type: "enrichment", providerKey: "git", level: "chunk", applied: 5000, total: 7325 });
    mockSingleBar.update.mockClear();
    // Fire enrichment phase-done
    r.handle({ type: "phase-done", phase: "enrichment", elapsedMs: 45000 });
    const updateCalls = mockSingleBar.update.mock.calls;
    // Both bars get done payload
    const doneUpdates = updateCalls.filter((c) => (c[1] as Record<string, unknown>)["done"] !== undefined);
    expect(doneUpdates).toHaveLength(2);
    // Values MUST be filled to total (7325) on done
    expect(updateCalls.every((c) => c[0] === 7325)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// barTimeFields — pure helper for ETA/elapsed computation
// ---------------------------------------------------------------------------
describe("barTimeFields", () => {
  it("elapsed grows as nowMs advances", () => {
    const a = barTimeFields(0, 50, 100, 1000);
    const b = barTimeFields(0, 50, 100, 5000);
    expect(a.elapsed).not.toBe(b.elapsed);
    expect(a.elapsed).toContain("1");
    expect(b.elapsed).toContain("5");
  });

  it("eta shrinks as value approaches total", () => {
    // 10s elapsed, 50/100 → rate=5/s, remaining=50 → eta=10s
    const a = barTimeFields(0, 50, 100, 10_000);
    // 10s elapsed, 90/100 → rate=9/s, remaining=10 → eta≈1.1s
    const b = barTimeFields(0, 90, 100, 10_000);
    // Both must be non-empty
    expect(a.eta).not.toBe("");
    expect(b.eta).not.toBe("");
    // a eta should be longer (more remaining)
    const aSeconds = parseFloat(a.eta.replace(/[^0-9.]/g, ""));
    const bSeconds = parseFloat(b.eta.replace(/[^0-9.]/g, ""));
    expect(aSeconds).toBeGreaterThan(bSeconds);
  });

  it("eta is empty string when value=0", () => {
    expect(barTimeFields(0, 0, 100, 5000).eta).toBe("");
  });
});

// ---------------------------------------------------------------------------
// TtyProgressRenderer — tick interval lifecycle
// ---------------------------------------------------------------------------
describe("TtyProgressRenderer — tick interval lifecycle", () => {
  const colors = createColorizer({ env: {}, isTTY: false });

  beforeEach(() => {
    mockMultibar.create.mockClear();
    mockMultibar.stop.mockClear();
    mockMultibar.log.mockClear();
    mockSingleBar.update.mockClear();
    mockSingleBar.setTotal.mockClear();
    mockMultibar.create.mockReturnValue(mockSingleBar);
  });

  it("tickInterval is null before any handle call", () => {
    const r = new TtyProgressRenderer(colors);
    expect((r as unknown as { tickInterval: unknown }).tickInterval).toBeNull();
  });

  it("tickInterval is non-null after first embedding handle", () => {
    const r = new TtyProgressRenderer(colors);
    r.handle({ type: "embedding", phase: "embedding", percentage: 0, current: 0, total: 100 });
    expect((r as unknown as { tickInterval: unknown }).tickInterval).not.toBeNull();
    r.stop();
  });

  it("tickInterval is non-null after first enrichment handle", () => {
    const r = new TtyProgressRenderer(colors);
    r.handle({ type: "enrichment", providerKey: "git", level: "file", applied: 0, total: 100 });
    expect((r as unknown as { tickInterval: unknown }).tickInterval).not.toBeNull();
    r.stop();
  });

  it("stop() clears the tick interval (null after stop)", () => {
    const r = new TtyProgressRenderer(colors);
    r.handle({ type: "embedding", phase: "embedding", percentage: 0, current: 0, total: 100 });
    r.stop();
    expect((r as unknown as { tickInterval: unknown }).tickInterval).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TtyProgressRenderer — freeze elapsed at 100% (pre-done) — Bug 3
// ---------------------------------------------------------------------------
describe("TtyProgressRenderer — freeze elapsed at 100% (pre-done)", () => {
  const colors = createColorizer({ env: {}, isTTY: false });
  let nowMs = 0;

  beforeEach(() => {
    nowMs = 0;
    mockMultibar.create.mockClear();
    mockMultibar.stop.mockClear();
    mockMultibar.log.mockClear();
    mockSingleBar.update.mockClear();
    mockSingleBar.setTotal.mockClear();
    mockMultibar.create.mockReturnValue(mockSingleBar);
  });

  it("refreshActiveBars does NOT call update on a full (value>=total) non-done bar", () => {
    const r = new TtyProgressRenderer(colors, () => nowMs);
    nowMs = 10_000;
    r.handle({ type: "embedding", phase: "embedding", percentage: 100, current: 7344, total: 7344 });
    mockSingleBar.update.mockClear();
    nowMs = 15_000;
    (r as unknown as { refreshActiveBars: () => void }).refreshActiveBars();
    expect(mockSingleBar.update).not.toHaveBeenCalled();
  });

  it("full bar (value>=total, not done) shows eta='' in the update payload", () => {
    const r = new TtyProgressRenderer(colors, () => nowMs);
    nowMs = 10_000;
    r.handle({
      type: "embedding",
      phase: "embedding",
      percentage: 100,
      current: 7344,
      total: 7344,
      throughput: 60,
    });
    const updateCalls = mockSingleBar.update.mock.calls;
    const lastPayload = updateCalls[updateCalls.length - 1][1] as Record<string, unknown>;
    expect(lastPayload["eta"]).toBe("");
  });

  it("non-full bar (value<total) still ticks on refreshActiveBars (regression guard)", () => {
    const r = new TtyProgressRenderer(colors, () => nowMs);
    nowMs = 0;
    r.handle({ type: "embedding", phase: "embedding", percentage: 50, current: 50, total: 100 });
    mockSingleBar.update.mockClear();
    nowMs = 5_000;
    (r as unknown as { refreshActiveBars: () => void }).refreshActiveBars();
    expect(mockSingleBar.update).toHaveBeenCalledTimes(1);
  });

  it("phase-done still marks bar done and emits Done ✓ payload after bar was full", () => {
    const r = new TtyProgressRenderer(colors, () => nowMs);
    nowMs = 10_000;
    r.handle({ type: "embedding", phase: "embedding", percentage: 100, current: 7344, total: 7344 });
    mockSingleBar.update.mockClear();
    r.handle({ type: "phase-done", phase: "embedding", elapsedMs: 10_000 });
    const { barStates } = r as unknown as { barStates: Map<string, { done: boolean }> };
    expect(barStates.get("embedding")?.done).toBe(true);
    const updateCalls = mockSingleBar.update.mock.calls;
    expect(updateCalls.some((c) => (c[1] as Record<string, unknown>)["done"] !== undefined)).toBe(true);
  });

  it("zero-total bar is NOT considered full (refreshActiveBars still ticks it)", () => {
    const r = new TtyProgressRenderer(colors, () => nowMs);
    nowMs = 0;
    r.handle({ type: "embedding", phase: "embedding", percentage: 0, current: 0, total: 0 });
    mockSingleBar.update.mockClear();
    nowMs = 5_000;
    (r as unknown as { refreshActiveBars: () => void }).refreshActiveBars();
    expect(mockSingleBar.update).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// TtyProgressRenderer — refreshActiveBars
// ---------------------------------------------------------------------------
describe("TtyProgressRenderer — refreshActiveBars", () => {
  const colors = createColorizer({ env: {}, isTTY: false });
  let nowMs = 0;

  beforeEach(() => {
    nowMs = 0;
    mockMultibar.create.mockClear();
    mockMultibar.stop.mockClear();
    mockMultibar.log.mockClear();
    mockSingleBar.update.mockClear();
    mockSingleBar.setTotal.mockClear();
    mockMultibar.create.mockReturnValue(mockSingleBar);
  });

  it("re-updates a non-done bar after clock advances", () => {
    const r = new TtyProgressRenderer(colors, () => nowMs);
    r.handle({ type: "embedding", phase: "embedding", percentage: 50, current: 50, total: 100 });
    mockSingleBar.update.mockClear();
    nowMs = 5000;
    (r as unknown as { refreshActiveBars: () => void }).refreshActiveBars();
    expect(mockSingleBar.update).toHaveBeenCalledTimes(1);
  });

  it("does NOT call update on a done bar", () => {
    const r = new TtyProgressRenderer(colors, () => nowMs);
    r.handle({ type: "embedding", phase: "embedding", percentage: 50, current: 50, total: 100 });
    r.handle({ type: "phase-done", phase: "embedding", elapsedMs: 5000 });
    mockSingleBar.update.mockClear();
    nowMs = 5000;
    (r as unknown as { refreshActiveBars: () => void }).refreshActiveBars();
    expect(mockSingleBar.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// buildBarLine — DONE mode
// ---------------------------------------------------------------------------
describe("buildBarLine — DONE mode", () => {
  const identityColors = createColorizer({ env: { NO_COLOR: "1" }, isTTY: false });

  it("output contains 'Done ✓ in 90s' (NO_COLOR)", () => {
    const line = buildBarLine({
      label: "embeddings",
      progress: 0.57,
      value: 4096,
      total: 7194,
      elapsed: "",
      eta: "",
      rate: "",
      barsize: 10,
      colors: identityColors,
      done: { elapsed: "90s" },
    });
    expect(line).toContain("Done ✓ in 90s");
  });

  it("output contains 4096/7194 (NO_COLOR)", () => {
    const line = buildBarLine({
      label: "embeddings",
      progress: 0.57,
      value: 4096,
      total: 7194,
      elapsed: "",
      eta: "",
      rate: "",
      barsize: 10,
      colors: identityColors,
      done: { elapsed: "90s" },
    });
    expect(line).toContain("4096/7194");
  });

  it("output does NOT contain eta or rate segment (NO_COLOR)", () => {
    const line = buildBarLine({
      label: "embeddings",
      progress: 0.57,
      value: 4096,
      total: 7194,
      elapsed: "50s",
      eta: "~30s",
      rate: "100 ch/s",
      barsize: 10,
      colors: identityColors,
      done: { elapsed: "90s" },
    });
    expect(line).not.toContain("~30s");
    expect(line).not.toContain("100 ch/s");
    expect(line).not.toContain("50s");
  });

  it("text segments are bold (FORCE_COLOR) but bar glyph █ is NOT directly preceded by bold ANSI", () => {
    const boldColors = createColorizer({ env: { FORCE_COLOR: "1" }, isTTY: true });
    const line = buildBarLine({
      label: "embeddings",
      progress: 0.57,
      value: 4096,
      total: 7194,
      elapsed: "",
      eta: "",
      rate: "",
      barsize: 10,
      colors: boldColors,
      done: { elapsed: "90s" },
    });
    // bold ANSI must be present (text segments wrapped in bold)
    expect(line).toContain("\x1b[1m");
    // The filled glyph █ must NOT be immediately preceded by the bold code ESC[1m
    const boldThenGlyph = "\x1b[1m█";
    expect(line.includes(boldThenGlyph)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TtyProgressRenderer — phase-done inline (replaces multibar.log)
// ---------------------------------------------------------------------------
describe("TtyProgressRenderer — phase-done inline", () => {
  const colors = createColorizer({ env: {}, isTTY: false });

  beforeEach(() => {
    mockMultibar.create.mockClear();
    mockMultibar.stop.mockClear();
    mockMultibar.log.mockClear();
    mockSingleBar.update.mockClear();
    mockSingleBar.setTotal.mockClear();
    mockMultibar.create.mockReturnValue(mockSingleBar);
  });

  it("does NOT call multibar.log on phase-done (inline bar update instead)", () => {
    const r = new TtyProgressRenderer(colors);
    r.handle({ type: "embedding", phase: "embedding", percentage: 57, current: 4096, total: 7194 });
    mockSingleBar.update.mockClear();
    r.handle({ type: "phase-done", phase: "embedding", elapsedMs: 3500 });
    expect(mockMultibar.log).not.toHaveBeenCalled();
    expect(mockSingleBar.update).toHaveBeenCalledWith(
      expect.any(Number),
      expect.objectContaining({ done: { elapsed: expect.any(String) } }),
    );
  });

  it("after phase-done embedding: embedding barState has done=true", () => {
    const r = new TtyProgressRenderer(colors);
    r.handle({ type: "embedding", phase: "embedding", percentage: 57, current: 4096, total: 7194 });
    r.handle({ type: "phase-done", phase: "embedding", elapsedMs: 3500 });
    const { barStates } = r as unknown as { barStates: Map<string, { done: boolean }> };
    expect(barStates.get("embedding")?.done).toBe(true);
  });

  it("after phase-done enrichment: ALL enrichment barStates have done=true", () => {
    const r = new TtyProgressRenderer(colors);
    r.handle({ type: "enrichment", providerKey: "git", level: "file", applied: 7000, total: 7325 });
    r.handle({ type: "enrichment", providerKey: "git", level: "chunk", applied: 5000, total: 7325 });
    r.handle({ type: "phase-done", phase: "enrichment", elapsedMs: 45000 });
    const { barStates } = r as unknown as { barStates: Map<string, { done: boolean }> };
    expect(barStates.get("git:file")?.done).toBe(true);
    expect(barStates.get("git:chunk")?.done).toBe(true);
  });

  it("marks embedding bar done inline (fills value to total)", () => {
    const r = new TtyProgressRenderer(colors);
    r.handle({ type: "embedding", phase: "embedding", percentage: 57, current: 4096, total: 7194 });
    mockSingleBar.update.mockClear();
    r.handle({ type: "phase-done", phase: "embedding", elapsedMs: 129400 });
    const updateCalls = mockSingleBar.update.mock.calls;
    // Must be called with done payload
    expect(updateCalls.some((c) => (c[1] as Record<string, unknown>)["done"] !== undefined)).toBe(true);
    // MUST fill value to total (7194) on done
    expect(updateCalls.some((c) => c[0] === 7194)).toBe(true);
  });

  it("marks all enrichment bars done inline on enrichment phase-done (fills to total)", () => {
    const r = new TtyProgressRenderer(colors);
    r.handle({ type: "enrichment", providerKey: "git", level: "file", applied: 7000, total: 7325 });
    r.handle({ type: "enrichment", providerKey: "git", level: "chunk", applied: 5000, total: 7325 });
    mockSingleBar.update.mockClear();
    r.handle({ type: "phase-done", phase: "enrichment", elapsedMs: 45000 });
    const updateCalls = mockSingleBar.update.mock.calls;
    // Both bars get update called with done payload
    const doneUpdates = updateCalls.filter((c) => (c[1] as Record<string, unknown>)["done"] !== undefined);
    expect(doneUpdates).toHaveLength(2);
    // Values MUST be filled to total (7325) on done
    expect(updateCalls.every((c) => c[0] === 7325)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// LineProgressRenderer — phase-done emits a line
// ---------------------------------------------------------------------------
describe("LineProgressRenderer — phase-done", () => {
  it("emits a phase-done line via the sink", () => {
    const written: string[] = [];
    const r = new LineProgressRenderer((s) => written.push(s));
    r.handle({ type: "phase-done", phase: "embedding", elapsedMs: 3500 });
    expect(written).toHaveLength(1);
    expect(written[0]).toContain("embedding");
    expect(written[0]).toContain("3.5s");
  });

  it("does not duplicate consecutive identical phase-done lines", () => {
    const written: string[] = [];
    const r = new LineProgressRenderer((s) => written.push(s));
    r.handle({ type: "phase-done", phase: "embedding", elapsedMs: 3500 });
    r.handle({ type: "phase-done", phase: "embedding", elapsedMs: 3500 });
    expect(written).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// countdownEta — pure helper (Bug 1 fix)
// ---------------------------------------------------------------------------
describe("countdownEta", () => {
  it("returns the base when no time has elapsed", () => {
    expect(countdownEta(50, 0, 0)).toBe(50);
  });

  it("counts down by the elapsed wall time", () => {
    expect(countdownEta(50, 0, 10_000)).toBe(40);
  });

  it("clamps to 0 when wall time exceeds base", () => {
    expect(countdownEta(50, 0, 60_000)).toBe(0);
  });

  it("returns null when etaBaseSeconds is null", () => {
    expect(countdownEta(null, 0, 10_000)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Bug 1 — ETA uses throughput when present + counts DOWN between messages
// ---------------------------------------------------------------------------
describe("TtyProgressRenderer — ETA countdown (Bug 1)", () => {
  const colors = createColorizer({ env: { NO_COLOR: "1" }, isTTY: false });
  let nowMs = 0;

  beforeEach(() => {
    nowMs = 0;
    mockMultibar.create.mockClear();
    mockMultibar.stop.mockClear();
    mockMultibar.log.mockClear();
    mockSingleBar.update.mockClear();
    mockSingleBar.setTotal.mockClear();
    mockMultibar.create.mockReturnValue(mockSingleBar);
  });

  it("embedding ETA base uses throughput when present (not cumulative rate)", () => {
    const r = new TtyProgressRenderer(colors, () => nowMs);
    nowMs = 0;
    r.handle({ type: "embedding", phase: "embedding", percentage: 0, current: 0, total: 7344 });
    nowMs = 10_000;
    r.handle({
      type: "embedding",
      phase: "embedding",
      percentage: 99,
      current: 7283,
      total: 7344,
      throughput: 60,
    });
    const { barStates } = r as unknown as { barStates: Map<string, { etaBaseSeconds: number | null }> };
    const state = barStates.get("embedding");
    // expected = (7344 - 7283) / 60 = 61/60 ≈ 1.017
    expect(state?.etaBaseSeconds).not.toBeNull();
    expect(state!.etaBaseSeconds!).toBeCloseTo((7344 - 7283) / 60, 1);
  });

  it("ETA in rendered bar line decreases (not increases) between messages when value is fixed", () => {
    const r = new TtyProgressRenderer(colors, () => nowMs);

    // Use throughput=1 ch/s with 100 remaining → base ETA = 100s
    // After 5s tick the countdown gives ~95s — clearly less than ~100s
    nowMs = 0;
    r.handle({ type: "embedding", phase: "embedding", percentage: 0, current: 0, total: 200 });
    nowMs = 10_000;
    r.handle({
      type: "embedding",
      phase: "embedding",
      percentage: 50,
      current: 100,
      total: 200,
      throughput: 1, // 1 ch/s → base = (200-100)/1 = 100s
    });
    // Capture eta from the update call right after the message
    const callsAfterMsg = mockSingleBar.update.mock.calls;
    const etaAfterMsg = (callsAfterMsg[callsAfterMsg.length - 1][1] as Record<string, unknown>)["eta"] as string;

    mockSingleBar.update.mockClear();
    // Advance clock by 5 seconds — no new message, just a tick
    nowMs = 15_000;
    (r as unknown as { refreshActiveBars: () => void }).refreshActiveBars();

    const callsAfterTick = mockSingleBar.update.mock.calls;
    const etaAfterTick = (callsAfterTick[callsAfterTick.length - 1][1] as Record<string, unknown>)["eta"] as string;

    // Both ETAs must be non-empty (base=100s, after 5s tick=95s — both > 0)
    expect(etaAfterMsg).not.toBe("");
    expect(etaAfterTick).not.toBe("");

    // Parse numeric value (strip ~, s, m)
    const parse = (s: string): number => {
      const n = parseFloat(s.replace(/[^0-9.]/g, ""));
      return s.includes("m") ? n * 60 : n;
    };
    expect(parse(etaAfterTick)).toBeLessThan(parse(etaAfterMsg));
  });
});

// ---------------------------------------------------------------------------
// Bug 2 — phase-done fills bar to 100%
// ---------------------------------------------------------------------------
describe("TtyProgressRenderer — phase-done fills to 100% (Bug 2)", () => {
  const colors = createColorizer({ env: { NO_COLOR: "1" }, isTTY: false });
  let nowMs = 0;

  beforeEach(() => {
    nowMs = 0;
    mockMultibar.create.mockClear();
    mockMultibar.stop.mockClear();
    mockMultibar.log.mockClear();
    mockSingleBar.update.mockClear();
    mockSingleBar.setTotal.mockClear();
    mockMultibar.create.mockReturnValue(mockSingleBar);
  });

  it("after phase-done embedding: bar.value equals bar.total", () => {
    const r = new TtyProgressRenderer(colors, () => nowMs);
    r.handle({ type: "embedding", phase: "embedding", percentage: 99, current: 7325, total: 7344 });
    r.handle({ type: "phase-done", phase: "embedding", elapsedMs: 5000 });
    const { barStates } = r as unknown as {
      barStates: Map<string, { value: number; total: number }>;
    };
    const state = barStates.get("embedding");
    expect(state?.value).toBe(state?.total);
  });

  it("after phase-done embedding: update is called with total as value argument", () => {
    const r = new TtyProgressRenderer(colors, () => nowMs);
    r.handle({ type: "embedding", phase: "embedding", percentage: 99, current: 7325, total: 7344 });
    mockSingleBar.update.mockClear();
    r.handle({ type: "phase-done", phase: "embedding", elapsedMs: 5000 });
    const updateCalls = mockSingleBar.update.mock.calls;
    // update called with value=total=7344
    expect(updateCalls.some((c) => c[0] === 7344)).toBe(true);
  });

  it("after phase-done enrichment: bar.value equals bar.total for all enrichment bars", () => {
    const r = new TtyProgressRenderer(colors, () => nowMs);
    r.handle({ type: "enrichment", providerKey: "git", level: "file", applied: 7000, total: 7325 });
    r.handle({ type: "enrichment", providerKey: "git", level: "chunk", applied: 5000, total: 7325 });
    r.handle({ type: "phase-done", phase: "enrichment", elapsedMs: 45000 });
    const { barStates } = r as unknown as {
      barStates: Map<string, { value: number; total: number }>;
    };
    const file = barStates.get("git:file");
    const chunk = barStates.get("git:chunk");
    expect(file?.value).toBe(file?.total);
    expect(chunk?.value).toBe(chunk?.total);
  });
});
