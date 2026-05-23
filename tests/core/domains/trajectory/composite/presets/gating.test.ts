/**
 * Provider-gating tests for composite presets — RFC
 * docs/superpowers/specs/2026-05-21-codegraph-provider-gating-design.md.
 *
 * Composite presets declare a mandatory `requires: readonly string[]` field
 * (trajectory keys they depend on). `buildCompositePresets(registeredKeys)`
 * returns only those whose requires are fully satisfied. When a required
 * trajectory is not registered, the corresponding composite preset is
 * silently dropped — it never reaches the Reranker, the SchemaBuilder, the
 * MCP preset enum, or the custom-weights schema.
 *
 * The previous monolithic `{ codegraph: boolean }` gate is generalised to a
 * per-preset declarative check against `registeredKeys: Set<string>`.
 */

import { describe, expect, it } from "vitest";

import type { CompositeRerankPreset } from "../../../../../../src/core/contracts/types/reranker.js";
import {
  ArchitecturalHubPreset,
  BlastRadiusPreset,
  buildCompositePresets,
  CodeReviewCompositePreset,
  DangerousCompositePreset,
  EntryPointPreset,
  HotspotsCompositePreset,
  OwnershipCompositePreset,
  SecurityAuditCompositePreset,
  TechDebtCompositePreset,
} from "../../../../../../src/core/domains/trajectory/composite/presets/index.js";

describe("CompositeRerankPreset contract", () => {
  it("every composite preset declares mandatory requires[] referencing trajectory keys", () => {
    const composites: CompositeRerankPreset[] = [
      new HotspotsCompositePreset(),
      new TechDebtCompositePreset(),
      new DangerousCompositePreset(),
      new OwnershipCompositePreset(),
      new SecurityAuditCompositePreset(),
      new CodeReviewCompositePreset(),
      new BlastRadiusPreset(),
      new ArchitecturalHubPreset(),
      new EntryPointPreset(),
    ];

    for (const p of composites) {
      expect(p.requires).toBeDefined();
      expect(Array.isArray(p.requires)).toBe(true);
      expect(p.requires.length).toBeGreaterThan(0);
      // No "static" — static is always-on; only declare non-default trajectories
      expect(p.requires).not.toContain("static");
    }
  });

  it("override composites (hotspots, techDebt, dangerous, ownership, securityAudit, codeReview) require codegraph.symbols AND git", () => {
    const overrides: CompositeRerankPreset[] = [
      new HotspotsCompositePreset(),
      new TechDebtCompositePreset(),
      new DangerousCompositePreset(),
      new OwnershipCompositePreset(),
      new SecurityAuditCompositePreset(),
      new CodeReviewCompositePreset(),
    ];
    for (const p of overrides) {
      expect(p.requires).toContain("codegraph.symbols");
      expect(p.requires).toContain("git");
    }
  });

  it("BlastRadius + ArchitecturalHub require codegraph.symbols AND git (mix structural + churn)", () => {
    expect(new BlastRadiusPreset().requires).toEqual(expect.arrayContaining(["codegraph.symbols", "git"]));
    expect(new ArchitecturalHubPreset().requires).toEqual(expect.arrayContaining(["codegraph.symbols", "git"]));
  });

  it("EntryPointPreset requires codegraph.symbols only (no git weights)", () => {
    const preset = new EntryPointPreset();
    expect(preset.requires).toEqual(expect.arrayContaining(["codegraph.symbols"]));
    expect(preset.requires).not.toContain("git");
  });
});

describe("buildCompositePresets — declarative requires gating", () => {
  it("returns empty array when no relevant trajectories are registered", () => {
    const result = buildCompositePresets(new Set<string>());
    expect(result).toEqual([]);
  });

  it("returns empty array when only static is registered (no codegraph, no git)", () => {
    const result = buildCompositePresets(new Set(["static"]));
    expect(result).toEqual([]);
  });

  it("returns empty array when only git is registered (codegraph missing — all composites require codegraph)", () => {
    const result = buildCompositePresets(new Set(["git"]));
    expect(result).toEqual([]);
  });

  it("returns only EntryPointPreset when only codegraph.symbols is registered (no git)", () => {
    const result = buildCompositePresets(new Set(["codegraph.symbols"]));
    expect(result).toHaveLength(1);
    expect(result[0]).toBeInstanceOf(EntryPointPreset);
  });

  it("returns all 9 composites when both codegraph.symbols AND git are registered", () => {
    const result = buildCompositePresets(new Set(["codegraph.symbols", "git"]));
    expect(result).toHaveLength(9);
    const names = result.map((p) => p.name).sort();
    expect(names).toEqual(
      [
        "architecturalHub",
        "blastRadius",
        "codeReview",
        "dangerous",
        "entryPoint",
        "hotspots",
        "ownership",
        "securityAudit",
        "techDebt",
      ].sort(),
    );
  });

  it("ignores unknown registered keys (extra keys do not enable extra presets)", () => {
    const result = buildCompositePresets(new Set(["codegraph.symbols", "git", "future-trajectory"]));
    expect(result).toHaveLength(9);
  });

  it("dropped composites are silently absent, not error", () => {
    expect(() => buildCompositePresets(new Set(["git"]))).not.toThrow();
    expect(() => buildCompositePresets(new Set())).not.toThrow();
  });
});
