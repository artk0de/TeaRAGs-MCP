import { describe, expect, it } from "vitest";

import {
  deriveTypeRoles,
  expectedRoleFor,
  type TypeNameRow,
} from "../../../../../src/core/domains/explore/naming-lexicon/type-roles.js";

function t(shortName: string, relPath: string, ancestors: string[]): TypeNameRow {
  return { symbolId: shortName, relPath, shortName, symbolKind: "class", ancestors };
}

/** Single-word type names with pairwise distinct heads: they dilute a directory without forming a role. */
const FILLER_HEADS = [
  "Alpha",
  "Bravo",
  "Charlie",
  "Delta",
  "Echo",
  "Foxtrot",
  "Golf",
  "Hotel",
  "India",
  "Juliet",
  "Kilo",
  "Lima",
  "Mike",
  "November",
];

function fillers(dir: string, from: number, count: number): TypeNameRow[] {
  return FILLER_HEADS.slice(from, from + count).map((name) => t(name, `${dir}/${name.toLowerCase()}.ts`, []));
}

describe("deriveTypeRoles / expectedRoleFor", () => {
  it("inheritance family beats directory", () => {
    const rows = [
      t("TsStrategy", "src/a/ts.ts", ["SymbolResolutionStrategy"]),
      t("PyStrategy", "src/b/py.ts", ["SymbolResolutionStrategy"]),
      t("RubyStrategy", "src/c/rb.ts", ["SymbolResolutionStrategy"]),
      t("Helper", "src/a/helper.ts", []),
    ];
    const roles = deriveTypeRoles(rows);
    expect(
      expectedRoleFor(roles, {
        path: "src/z/new.ts",
        extends: "SymbolResolutionStrategy",
      }),
    ).toMatchObject({ role: "strategy", evidence: "inheritance" });
  });

  it("a directory role needs share ≥ 0.2", () => {
    // presets/: 3 of 4 types end in Preset → the directory's role is `preset`.
    const presets = [
      t("TechDebtPreset", "src/presets/tech-debt.ts", []),
      t("HotspotsPreset", "src/presets/hotspots.ts", []),
      t("OwnershipPreset", "src/presets/ownership.ts", []),
      t("PresetRegistry", "src/presets/registry.ts", []),
    ];
    expect(expectedRoleFor(deriveTypeRoles(presets), { path: "src/presets/new.ts" })).toEqual({
      role: "preset",
      evidence: "directory",
      examples: ["HotspotsPreset", "OwnershipPreset", "TechDebtPreset"],
    });

    // 2 of 11 end in Preset: share 0.18 < 0.2 → no directory role.
    const diluted = [
      t("TechDebtPreset", "src/presets/tech-debt.ts", []),
      t("HotspotsPreset", "src/presets/hotspots.ts", []),
      ...fillers("src/presets", 0, 9),
    ];
    expect(expectedRoleFor(deriveTypeRoles(diluted), { path: "src/presets/new.ts" })).toBeUndefined();
  });

  it("a project suffix needs ≥ 3 types in ≥ 2 dirs", () => {
    // Store ×3 across src/a (2, diluted below the directory share) and src/b (1).
    const threeStores = [
      t("SymbolStore", "src/a/symbol-store.ts", []),
      t("EdgeStore", "src/a/edge-store.ts", []),
      ...fillers("src/a", 0, 10),
      t("FileStore", "src/b/file-store.ts", []),
      ...fillers("src/b", 10, 4),
    ];
    const roles = deriveTypeRoles(threeStores);
    expect(roles.filter((r) => r.evidence === "directory")).toEqual([]);
    expect(roles.filter((r) => r.evidence === "projectSuffix")).toEqual([
      {
        symbolId: "EdgeStore",
        relPath: "src/a/edge-store.ts",
        role: "store",
        evidence: "projectSuffix",
        support: 3,
        scope: "",
      },
      {
        symbolId: "FileStore",
        relPath: "src/b/file-store.ts",
        role: "store",
        evidence: "projectSuffix",
        support: 3,
        scope: "",
      },
      {
        symbolId: "SymbolStore",
        relPath: "src/a/symbol-store.ts",
        role: "store",
        evidence: "projectSuffix",
        support: 3,
        scope: "",
      },
    ]);
    expect(expectedRoleFor(roles, { path: "src/b/new.ts" })).toEqual({
      role: "store",
      evidence: "projectSuffix",
      examples: ["EdgeStore", "FileStore", "SymbolStore"],
    });

    // Store ×2 → no role anywhere.
    const twoStores = threeStores.filter((row) => row.shortName !== "EdgeStore");
    const noRoles = deriveTypeRoles(twoStores);
    expect(noRoles.filter((r) => r.role === "store")).toEqual([]);
    expect(expectedRoleFor(noRoles, { path: "src/b/new.ts" })).toBeUndefined();
  });

  it("a family's role is the tail word its members share; support counts them", () => {
    const rows = [
      t("TechDebtPreset", "src/a/x.ts", ["RerankPreset"]),
      t("HotspotsPreset", "src/b/y.ts", ["RerankPreset"]),
      t("Legacy", "src/c/z.ts", ["RerankPreset"]),
    ];
    const family = deriveTypeRoles(rows).filter((r) => r.evidence === "inheritance");
    expect(family.map((r) => [r.symbolId, r.role, r.support, r.scope])).toEqual([
      ["HotspotsPreset", "preset", 2, "RerankPreset"],
      ["TechDebtPreset", "preset", 2, "RerankPreset"],
    ]);
  });

  it("matches the draft's ancestor by its last namespace segment", () => {
    const rows = [
      t("TsStrategy", "src/a/ts.ts", ["Resolution::SymbolResolutionStrategy"]),
      t("PyStrategy", "src/b/py.ts", ["Resolution::SymbolResolutionStrategy"]),
    ];
    expect(
      expectedRoleFor(deriveTypeRoles(rows), { path: "src/z/new.ts", extends: "SymbolResolutionStrategy" }),
    ).toMatchObject({ role: "strategy", evidence: "inheritance", examples: ["PyStrategy", "TsStrategy"] });
  });

  it("falls back to the directory when the ancestor has no family role", () => {
    const rows = [
      t("TechDebtPreset", "src/presets/tech-debt.ts", []),
      t("HotspotsPreset", "src/presets/hotspots.ts", []),
    ];
    expect(expectedRoleFor(deriveTypeRoles(rows), { path: "src/presets/new.ts", extends: "Unknown" })).toMatchObject({
      role: "preset",
      evidence: "directory",
    });
  });

  it("no rows → no roles", () => {
    expect(deriveTypeRoles([])).toEqual([]);
    expect(expectedRoleFor([], { path: "src/a.ts" })).toBeUndefined();
  });
});
