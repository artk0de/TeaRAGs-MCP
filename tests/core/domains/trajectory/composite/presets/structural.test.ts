/**
 * Structural invariant — every preset class file under
 * `domains/trajectory/composite/presets/` MUST export a class implementing
 * `CompositeRerankPreset` with a non-empty `requires` field.
 *
 * Prevents the "I forgot the requires" regression: a composite preset
 * placed in this directory without `requires` would silently bypass the
 * gating mechanism and appear in the MCP preset enum even when its
 * required trajectories are not registered.
 */

import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import * as compositesBarrel from "../../../../../../src/core/domains/trajectory/composite/presets/index.js";

const COMPOSITE_PRESETS_SOURCE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../../src/core/domains/trajectory/composite/presets",
);

function listPresetSourceFiles(): string[] {
  return readdirSync(COMPOSITE_PRESETS_SOURCE_DIR)
    .filter((f) => f.endsWith(".ts"))
    .filter((f) => f !== "index.ts");
}

function getExportedPresetClasses(): (new () => unknown)[] {
  return Object.values(compositesBarrel).filter(
    (v): v is new () => unknown => typeof v === "function" && (v as { name: string }).name.endsWith("Preset"),
  );
}

describe("composite/presets/ structural invariant", () => {
  it("every preset class exported from the barrel declares a non-empty requires", () => {
    const classes = getExportedPresetClasses();
    expect(classes.length).toBeGreaterThan(0);

    for (const Cls of classes) {
      const instance = new Cls() as {
        name?: string;
        tools?: string[];
        weights?: unknown;
        requires?: readonly string[];
      };
      const clsName = (Cls as { name: string }).name;

      expect(instance.name, `${clsName} must declare a string 'name'`).toBeTypeOf("string");
      expect(instance.tools, `${clsName} must declare a non-empty tools[]`).toBeInstanceOf(Array);
      expect((instance.tools as string[]).length).toBeGreaterThan(0);
      expect(instance.weights, `${clsName} must declare 'weights'`).toBeDefined();

      // The key invariant — every composite preset MUST declare requires
      expect(
        instance.requires,
        `${clsName} must declare 'requires' — composite presets MUST implement CompositeRerankPreset`,
      ).toBeDefined();
      expect(Array.isArray(instance.requires)).toBe(true);
      expect((instance.requires as readonly string[]).length).toBeGreaterThan(0);

      // Static is always-on; do not name it in requires
      expect((instance.requires as readonly string[]).includes("static")).toBe(false);
    }
  });

  it("number of preset source files matches number of exported classes (no orphan files / missing barrel exports)", () => {
    const files = listPresetSourceFiles();
    const exportedClasses = getExportedPresetClasses();
    // 1:1 mapping: one preset class per source file
    expect(exportedClasses.length).toBe(files.length);
  });

  it("buildCompositePresets covers every preset class exported from the barrel", () => {
    const { buildCompositePresets } = compositesBarrel;
    // Permissive registered-keys set so every composite is included
    const allKeys = new Set(["codegraph.symbols", "git", "static"]);
    const builtNames = new Set(buildCompositePresets(allKeys).map((p) => p.name));

    for (const Cls of getExportedPresetClasses()) {
      const instance = new Cls() as { name: string };
      expect(
        builtNames,
        `${instance.name} (class ${(Cls as { name: string }).name}) is exported from the barrel but not picked up by buildCompositePresets — likely missing from ALL_COMPOSITE_PRESETS`,
      ).toContain(instance.name);
    }
  });
});
