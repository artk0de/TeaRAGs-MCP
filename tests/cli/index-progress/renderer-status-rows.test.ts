/**
 * TtyProgressRenderer status-row handlers — the indeterminate spinner rows for
 * daemon readiness (`qdrant-state`) and TurboQuant migration terminal edges.
 * Both are shown WITHOUT a numerator (no observable %), created on the first
 * message and frozen with a Done marker (or a background hint) on the terminal
 * one. These paths are separate from the embedding/enrichment percentage bars
 * the sibling renderer.test.ts already covers.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TtyProgressRenderer } from "../../../src/cli/index-progress/renderer.js";
import { createColorizer } from "../../../src/cli/infra/color.js";

// cli-progress mock (mirrors renderer.test.ts): a MultiBar whose create() hands
// back a single fake bar so we can assert create/update calls without a TTY.
const { mockSingleBar, mockMultibar } = vi.hoisted(() => {
  const mockSingleBar = { update: vi.fn(), setTotal: vi.fn() };
  const mockMultibar = {
    create: vi.fn().mockReturnValue(mockSingleBar),
    stop: vi.fn(),
    log: vi.fn(),
  };
  return { mockSingleBar, mockMultibar };
});

vi.mock("cli-progress", () => ({
  default: {
    MultiBar: class {
      create = mockMultibar.create;
      stop = mockMultibar.stop;
      log = mockMultibar.log;
    },
    Presets: { shades_classic: {} },
  },
}));

const colors = createColorizer({ env: {}, isTTY: false });

beforeEach(() => {
  mockMultibar.create.mockClear();
  mockSingleBar.update.mockClear();
});

describe("TtyProgressRenderer — qdrant-state readiness row", () => {
  it("creates one indeterminate bar on the first readiness message", () => {
    const r = new TtyProgressRenderer(colors);
    r.handle({ type: "qdrant-state", state: "recovering", elapsedMs: 100 });
    expect(mockMultibar.create).toHaveBeenCalledTimes(1);
  });

  it("updates the existing bar's rate on a follow-up message (no second bar)", () => {
    const r = new TtyProgressRenderer(colors);
    r.handle({ type: "qdrant-state", state: "starting", elapsedMs: 0 });
    mockMultibar.create.mockClear();
    r.handle({ type: "qdrant-state", state: "recovering", elapsedMs: 100 });
    expect(mockMultibar.create).not.toHaveBeenCalled();
  });

  it("freezes the bar with a Done marker when the daemon reports ready", () => {
    const r = new TtyProgressRenderer(colors);
    r.handle({ type: "qdrant-state", state: "recovering", elapsedMs: 100 });
    r.handle({ type: "qdrant-state", state: "ready", elapsedMs: 500 });
    const lastUpdate = mockSingleBar.update.mock.calls.at(-1);
    expect(lastUpdate?.[1]).toMatchObject({ done: expect.objectContaining({ elapsed: expect.any(String) }) });
  });

  it("ignores a ready message when no readiness bar exists (early return)", () => {
    const r = new TtyProgressRenderer(colors);
    r.handle({ type: "qdrant-state", state: "ready", elapsedMs: 500 });
    expect(mockSingleBar.update).not.toHaveBeenCalled();
  });
});

describe("TtyProgressRenderer — turbo-migration terminal edges", () => {
  it("freezes with a background hint when the optimizer runs past the poll cap", () => {
    const r = new TtyProgressRenderer(colors);
    r.handle({ type: "turbo-migration", collection: "c1", stage: "start" });
    mockSingleBar.update.mockClear();
    r.handle({ type: "turbo-migration", collection: "c1", stage: "background", elapsedMs: 500 });
    expect(mockSingleBar.update).toHaveBeenCalledTimes(1);
  });

  it("ignores a terminal turbo message with no prior start (early return)", () => {
    const r = new TtyProgressRenderer(colors);
    r.handle({ type: "turbo-migration", collection: "never-started", stage: "done", elapsedMs: 100 });
    expect(mockSingleBar.update).not.toHaveBeenCalled();
  });
});
