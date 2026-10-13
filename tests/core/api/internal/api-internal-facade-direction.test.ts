/**
 * Import-direction pin for api/internal consumers of the component facades
 * (bd tea-rags-mcp-89k7k.35 C4).
 *
 * `api/internal/` is the core composition root: it assembles domain modules,
 * but a component's public surface is its barrel. When a consumer reaches past
 * `registry/index.ts`, `drift/index.ts`, `ingest/infra/index.ts`,
 * `symbols/index.ts` or `static/index.ts` into a module file beneath it, the
 * barrel no longer vouches for the surface and the component's internals
 * become de-facto API. Any import — `import type` included, per the strict
 * import-direction model (`domain-boundaries.md`) — targeting one of these
 * five components MUST resolve to the component's own `index.js`.
 *
 * Components owned by other commits (explore, language, migration, pipeline)
 * are out of scope here. Source-level scan shaped after the chunk-grouping
 * direction pin (`tests/core/domains/explore/chunk-grouping/`).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../../../..");
const API_INTERNAL_DIR = join(ROOT, "src/core/api/internal");

/** The five C4 component roots and the barrel that vouches for them. */
const COMPONENT_BARRELS = [
  "src/core/domains/maintenance/registry/index.ts",
  "src/core/domains/maintenance/drift/index.ts",
  "src/core/domains/ingest/infra/index.ts",
  "src/core/domains/trajectory/codegraph/symbols/index.ts",
  "src/core/domains/trajectory/static/index.ts",
] as const;

const CONSUMER_DIRS = ["", "facades", "infra", "ops"] as const;

function consumerFiles(): string[] {
  const files: string[] = [];
  for (const dir of CONSUMER_DIRS) {
    const abs = join(API_INTERNAL_DIR, dir);
    for (const entry of readdirSync(abs)) {
      const entryAbs = join(abs, entry);
      if (statSync(entryAbs).isFile() && entry.endsWith(".ts")) files.push(entryAbs);
    }
  }
  return files;
}

/** Resolved absolute targets of every relative module specifier in a file (static, re-export, dynamic, type). */
function relativeTargets(file: string): string[] {
  const text = readFileSync(file, "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const targets: string[] = [];
  const pattern = /(?:from\s*|import\s*\(\s*|import\s+)"(\.{1,2}\/[^"]+)"/g;
  for (const match of text.matchAll(pattern)) {
    targets.push(resolve(dirname(file), match[1]).replace(/\.js$/, ".ts"));
  }
  return targets;
}

const rel = (abs: string): string => relative(ROOT, abs);

describe("api/internal consumers import the C4 components through their barrels", () => {
  it("has consumers to judge", () => {
    expect(consumerFiles().length).toBeGreaterThan(0);
  });

  it("no consumer imports a file past a component barrel", () => {
    const offenders: string[] = [];
    for (const file of consumerFiles()) {
      for (const target of relativeTargets(file)) {
        for (const barrel of COMPONENT_BARRELS) {
          const barrelAbs = join(ROOT, barrel);
          const componentDir = dirname(barrelAbs);
          const inside = target.startsWith(`${componentDir}/`) || dirname(target) === componentDir;
          if (inside && target !== barrelAbs) {
            offenders.push(`${rel(file)} -> ${rel(target)}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the barrels export the names the consumers need", async () => {
    const registry = await import("../../../../src/core/domains/maintenance/registry/index.js");
    const drift = await import("../../../../src/core/domains/maintenance/drift/index.js");
    const ingestInfra = await import("../../../../src/core/domains/ingest/infra/index.js");
    const symbols = await import("../../../../src/core/domains/trajectory/codegraph/symbols/index.js");
    const staticTrajectory = await import("../../../../src/core/domains/trajectory/static/index.js");
    expect(registry.entriesSharingRepo).toBeTypeOf("function");
    expect(registry.REGISTRY_ENV_GROUPS).toBeDefined();
    expect(registry.resolveRegistryQdrantBackend).toBeTypeOf("function");
    expect(registry.CollectionRegistry).toBeTypeOf("function");
    expect(drift.LanguageVersionDriftMonitor).toBeTypeOf("function");
    expect(drift.checkSchemaDrift).toBeTypeOf("function");
    expect(ingestInfra.isCollectionBuildInFlight).toBeTypeOf("function");
    expect(ingestInfra.computeCollectionStats).toBeTypeOf("function");
    expect(ingestInfra.validateSignalDependencies).toBeTypeOf("function");
    expect(symbols.settleCodegraphChunkSignals).toBeTypeOf("function");
    expect(symbols.CodegraphChunkSettlementTally).toBeTypeOf("function");
    expect(symbols.CODEGRAPH_SYMBOLS_DERIVED_SIGNALS).toBeDefined();
    expect(staticTrajectory.staticStatsAccumulators).toBeDefined();
  });
});
