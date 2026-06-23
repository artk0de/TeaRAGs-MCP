import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkerMessage } from "../../../src/cli/index-progress/ipc-protocol.js";
import { computeEtaSeconds } from "../../../src/cli/index-progress/phase-tracker.js";
import {
  buildBarLine,
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

describe("TtyProgressRenderer — phase-done via multibar.log", () => {
  const colors = createColorizer({ env: {}, isTTY: false });

  beforeEach(() => {
    mockMultibar.create.mockClear();
    mockMultibar.stop.mockClear();
    mockMultibar.log.mockClear();
    mockSingleBar.update.mockClear();
    mockSingleBar.setTotal.mockClear();
    mockMultibar.create.mockReturnValue(mockSingleBar);
  });

  it("calls multibar.log on phase-done (no collision with live bars)", () => {
    const r = new TtyProgressRenderer(colors);
    r.handle({ type: "phase-done", phase: "embedding", elapsedMs: 3500 });
    expect(mockMultibar.log).toHaveBeenCalledTimes(1);
    const msg = mockMultibar.log.mock.calls[0]?.[0] as string;
    expect(msg).toContain("embedding");
    expect(msg).toContain("3.5s");
  });

  it("forces embedding bar to 100% on embedding phase-done", () => {
    const r = new TtyProgressRenderer(colors);
    // Create the embedding bar first
    r.handle({ type: "embedding", phase: "embedding", percentage: 99, current: 7325, total: 7339 });
    mockSingleBar.update.mockClear();
    // Now fire phase-done
    r.handle({ type: "phase-done", phase: "embedding", elapsedMs: 129400 });
    // update must be called with total (7339)
    const updateCalls = mockSingleBar.update.mock.calls;
    expect(updateCalls.some((c) => c[0] === 7339)).toBe(true);
  });

  it("forces all enrichment bars to 100% on enrichment phase-done", () => {
    const r = new TtyProgressRenderer(colors);
    // Create two enrichment bars
    r.handle({ type: "enrichment", providerKey: "git", level: "file", applied: 7000, total: 7325 });
    r.handle({ type: "enrichment", providerKey: "git", level: "chunk", applied: 5000, total: 7325 });
    mockSingleBar.update.mockClear();
    // Fire enrichment phase-done
    r.handle({ type: "phase-done", phase: "enrichment", elapsedMs: 45000 });
    // Both bars should be updated to their totals (7325 each)
    const updateVals = mockSingleBar.update.mock.calls.map((c) => c[0] as number);
    expect(updateVals.filter((v) => v === 7325).length).toBe(2);
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
