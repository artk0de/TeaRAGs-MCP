/**
 * Consumer import-direction guard for the trajectory barrels (bd
 * tea-rags-mcp-0qaht.28).
 *
 * `bootstrap/` and `api/internal/` consume trajectory capabilities through the
 * owning barrel (`trajectory/index.ts`, `static/index.ts`, `codegraph/index.ts`),
 * never through a provider / payload-signals / filter-presets file beneath it:
 * the barrel vouches for a surface the consumer would otherwise bypass.
 *
 * Source-level scan of runtime named import statements; `import type` clauses
 * are erased at compile time and stay legal.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

const DEEP_SPECIFIER =
  /trajectory\/(?:static\/provider|codegraph\/symbols\/payload-signals|(?:static|composite|codegraph\/symbols)\/filter-presets\/index)\.js$/;

const CONSUMERS = [
  "src/bootstrap/factory.ts",
  "src/core/api/internal/facades/ingest-facade.ts",
  "src/core/api/internal/infra/working-tree-delta-signals.ts",
  "src/core/api/internal/infra/codegraph-payload-heal-runner.ts",
  "src/core/api/internal/composition.ts",
] as const;

function runtimeSpecifiers(text: string): string[] {
  const specifiers: string[] = [];
  for (const match of text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*"([^"]+)"/g)) {
    if (match[0].startsWith("import type")) continue;
    const names = match[1]
      .split(",")
      .map((c) => c.trim())
      .filter((c) => c && !c.startsWith("type "));
    if (names.length > 0) specifiers.push(match[2]);
  }
  return specifiers;
}

describe("trajectory consumers import through the owning barrel", () => {
  it("no consumer runtime-imports a provider / payload-signals / filter-presets file past its barrel", () => {
    const offenders: string[] = [];
    for (const file of CONSUMERS) {
      for (const specifier of runtimeSpecifiers(readFileSync(join(ROOT, file), "utf-8"))) {
        if (DEEP_SPECIFIER.test(specifier)) offenders.push(`${file}: ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the barrels export the names the consumers need", async () => {
    const staticBarrel = await import("../../../../src/core/domains/trajectory/static/index.js");
    const trajectoryBarrel = await import("../../../../src/core/domains/trajectory/index.js");
    const codegraphBarrel = await import("../../../../src/core/domains/trajectory/codegraph/index.js");
    expect(staticBarrel.StaticPayloadBuilder).toBeTypeOf("function");
    expect(staticBarrel.STATIC_FILTER_PRESETS).toBeDefined();
    expect(trajectoryBarrel.buildCompositeFilterPresets).toBeTypeOf("function");
    expect(trajectoryBarrel.ALL_COMPOSITE_FILTER_PRESETS).toBeDefined();
    expect(codegraphBarrel.CODEGRAPH_FILTER_PRESETS).toBeDefined();
    expect(codegraphBarrel.buildCodegraphFileSignals).toBeTypeOf("function");
  });
});
