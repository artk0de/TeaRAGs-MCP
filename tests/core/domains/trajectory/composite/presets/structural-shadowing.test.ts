/**
 * Structural presets under the shadow pattern — spec §C and §C2.
 *
 * `decomposition` and `godModule` both ship a static base (works on any
 * collection) and a codegraph-enriched composite that overrides it by name
 * once `codegraph.symbols` is registered. Collections without codegraph keep
 * the static variant; that degradation is a property of the existing
 * name-keyed override, not new machinery.
 */

import { describe, expect, it } from "vitest";

import type { RerankPreset } from "../../../../../../src/core/contracts/types/reranker.js";
import { resolvePresets } from "../../../../../../src/core/domains/explore/rerank/presets/index.js";
import {
  buildCompositePresets,
  DecompositionCompositePreset,
  GodModuleCompositePreset,
} from "../../../../../../src/core/domains/trajectory/composite/presets/index.js";
import { STATIC_PRESETS } from "../../../../../../src/core/domains/trajectory/static/rerank/presets/index.js";

const WITH_CODEGRAPH = new Set(["static", "git", "codegraph.symbols"]);
const WITHOUT_CODEGRAPH = new Set(["static", "git"]);

function resolve(registeredKeys: ReadonlySet<string>): Map<string, RerankPreset> {
  const resolved = resolvePresets(STATIC_PRESETS, buildCompositePresets(registeredKeys));
  return new Map(resolved.map((p) => [p.name, p]));
}

describe("composite decomposition", () => {
  const preset = new DecompositionCompositePreset();

  it("gates on codegraph alone — git contributes nothing to the method axis", () => {
    expect(preset.requires).toEqual(["codegraph.symbols"]);
  });

  it("scores what should be split: size, density and outgoing load", () => {
    expect(preset.weights).toEqual({
      similarity: 0.2,
      chunkSize: 0.35,
      chunkFanOut: 0.3,
      chunkDensity: 0.15,
    });
  });

  it("keeps fanIn and pageRank out of the score and in the overlay", () => {
    expect(preset.weights).not.toHaveProperty("chunkFanIn");
    expect(preset.weights).not.toHaveProperty("pageRank");
    expect(preset.overlayMask.chunk).toEqual([
      "codegraph.chunk.fanOut",
      "codegraph.chunk.fanIn",
      "codegraph.chunk.pageRank",
    ]);
    expect(preset.overlayMask.file).toEqual(["methodLines", "codegraph.file.transitiveImpact"]);
  });

  it("overrides the static variant when codegraph is registered", () => {
    const resolved = resolve(WITH_CODEGRAPH).get("decomposition")!;
    expect(resolved.weights).toHaveProperty("chunkFanOut");
    // groupBy is what makes rank_chunks report one row per owning class.
    expect(resolved.groupBy).toBe("parentSymbolId");
    expect(resolved.signalLevel).toBe("chunk");
  });

  it("leaves the static, size-only variant in place without codegraph", () => {
    const resolved = resolve(WITHOUT_CODEGRAPH).get("decomposition")!;
    expect(resolved.weights).not.toHaveProperty("chunkFanOut");
    expect(resolved.weights).toEqual({ similarity: 0.4, chunkSize: 0.4, chunkDensity: 0.2 });
    expect(resolved.groupBy).toBe("parentSymbolId");
  });
});

describe("composite godModule", () => {
  const preset = new GodModuleCompositePreset();

  it("gates on codegraph alone", () => {
    expect(preset.requires).toEqual(["codegraph.symbols"]);
    expect(preset.signalLevel).toBe("file");
  });

  it("keeps symbol mass dominant and uses structure only as an amplifier", () => {
    expect(preset.weights).toEqual({
      similarity: 0.15,
      symbolCount: 0.5,
      fanIn: 0.15,
      transitiveImpact: 0.1,
      isHub: 0.1,
    });
    const structural =
      (preset.weights.fanIn ?? 0) + (preset.weights.transitiveImpact ?? 0) + (preset.weights.isHub ?? 0);
    expect(preset.weights.symbolCount).toBeGreaterThan(structural);
  });

  it("keeps the static attribution numbers in the overlay and adds the graph ones", () => {
    expect(preset.overlayMask.file).toEqual([
      "fileSymbolCount",
      "codegraph.file.fanIn",
      "codegraph.file.fanOut",
      "codegraph.file.transitiveImpact",
      "codegraph.file.isHub",
    ]);
    expect(preset.overlayMask.chunk).toEqual(["memberCount", "classLines"]);
  });

  it("overrides the static variant when codegraph is registered", () => {
    const resolved = resolve(WITH_CODEGRAPH).get("godModule")!;
    expect(Object.keys(resolved.weights)).toEqual(
      expect.arrayContaining(["symbolCount", "fanIn", "transitiveImpact", "isHub"]),
    );
    expect(resolved.signalLevel).toBe("file");
  });

  it("leaves the static, mass-only variant in place without codegraph", () => {
    const resolved = resolve(WITHOUT_CODEGRAPH).get("godModule")!;
    expect(resolved.weights).toEqual({ similarity: 0.2, symbolCount: 0.8 });
  });
});

describe("shadowing does not duplicate preset names", () => {
  it("resolves exactly one preset per name in both configurations", () => {
    for (const keys of [WITH_CODEGRAPH, WITHOUT_CODEGRAPH]) {
      const resolved = resolvePresets(STATIC_PRESETS, buildCompositePresets(keys));
      const names = resolved.map((p) => p.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it("offers both structural presets on the same four tools", () => {
    const tools = ["semantic_search", "hybrid_search", "rank_chunks", "find_similar"];
    for (const preset of [new DecompositionCompositePreset(), new GodModuleCompositePreset()]) {
      expect(preset.tools).toEqual(tools);
    }
  });
});
