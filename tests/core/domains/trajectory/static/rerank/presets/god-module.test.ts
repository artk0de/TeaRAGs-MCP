/**
 * `godModule` — the file-level structural preset from spec §B.
 *
 * Static trajectory on purpose: it needs neither git nor codegraph, so it
 * ranks files on any collection once the symbol-mass fields are indexed.
 */

import { describe, expect, it } from "vitest";

import {
  getPresetNames,
  getPresetWeights,
} from "../../../../../../../src/core/domains/explore/rerank/presets/index.js";
import { StaticTrajectory } from "../../../../../../../src/core/domains/trajectory/static/index.js";
import { GodModulePreset } from "../../../../../../../src/core/domains/trajectory/static/rerank/presets/god-module.js";

const TOOLS = ["semantic_search", "hybrid_search", "rank_chunks", "find_similar"];

describe("GodModulePreset", () => {
  const preset = new GodModulePreset();

  it("weights symbol mass as the dominant term", () => {
    expect(preset.name).toBe("godModule");
    expect(preset.weights).toEqual({ similarity: 0.2, symbolCount: 0.8 });
  });

  it("ranks files, so chunk-level signals do not dilute the score", () => {
    expect(preset.signalLevel).toBe("file");
  });

  it("carries the attribution numbers in the overlay", () => {
    expect(preset.overlayMask).toEqual({
      file: ["moduleLines", "fileMethodCount"],
      chunk: ["memberCount"],
    });
  });

  it("is offered on every tool that reranks", () => {
    expect(preset.tools).toEqual(TOOLS);
  });
});

describe("godModule registration", () => {
  const trajectory = new StaticTrajectory();

  it("is registered in the static trajectory's presets", () => {
    expect(trajectory.presets.map((p) => p.name)).toContain("godModule");
  });

  it("resolves by name for each of its four tools", () => {
    for (const tool of TOOLS) {
      expect(getPresetNames(trajectory.presets, tool)).toContain("godModule");
      expect(getPresetWeights(trajectory.presets, "godModule", tool)).toEqual({
        similarity: 0.2,
        symbolCount: 0.8,
      });
    }
  });

  it("weights only derived signals the static trajectory actually provides", () => {
    const derived = new Set(trajectory.derivedSignals.map((d) => d.name));
    for (const key of Object.keys(new GodModulePreset().weights)) {
      expect(derived, `weight key "${key}" has no derived signal`).toContain(key);
    }
  });

  it("masks only payload keys the static trajectory actually declares", () => {
    const declared = new Set(trajectory.payloadSignals.map((s) => s.key));
    const mask = new GodModulePreset().overlayMask;
    for (const key of [...(mask.file ?? []), ...(mask.chunk ?? [])]) {
      expect(declared, `overlay key "${key}" has no payload signal descriptor`).toContain(key);
    }
  });
});
