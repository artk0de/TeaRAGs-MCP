/**
 * TypeScript and JavaScript resolve only into their OWN language family (bd
 * tea-rags-mcp-t5cji).
 *
 * One symbol table is built per run over every codegraph extension, and a
 * `SymbolDefinition` carries no `language` field, so a lookup the TS / JS
 * resolvers do not filter answers with whatever file in the repo spells the
 * name. On a Rails + React or a Django + React corpus that is a Ruby or Python
 * namesake, and it goes wrong three ways, each pinned here on the real
 * pipeline — `LanguageFactory` walkers and resolvers, the provider's sink and
 * barrier, `CallEdgeResolutionRunner`:
 *
 *  - PICK — a bare `perform()` the TypeScript project never declares lands on
 *    Ruby's `Worker#perform`; the JavaScript global fallback does the same;
 *  - SUPPRESSION — a Ruby `Base#save` makes TypeScript's `super.save()`
 *    ambiguous, and Ruby `Circle` / `Square` classes blind the CHA cone to the
 *    TypeScript implementers of `Shape#area`;
 *  - MIS-COUNT — a bare call whose only namesake is foreign has no in-project
 *    definition a TS / JS edge could point at, so it belongs in
 *    `no_in_project_def`, not in the residual the resolve rate charges.
 *
 * TS and JS resolving into EACH OTHER is legitimate (`allowJs`, a JS entry
 * point loading TS source) and must survive.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTestCodegraphDeps } from "../__helpers__/language-factory.js";
import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";
import { CodegraphEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIG_DIR = resolvePath(__dirname, "../../../../../../src/core/domains/maintenance/migration/database/migrations");

const POLYGLOT_CORPUS: Readonly<Record<string, string>> = {
  "web/app.ts": [
    'import { legacyInit } from "./legacy.js";',
    "export class Base {",
    "  save(): number {",
    "    return 1;",
    "  }",
    "}",
    "export class Child extends Base {",
    "  save(): number {",
    "    return super.save();",
    "  }",
    "}",
    "export function main(): number {",
    "  legacyInit();",
    "  perform();",
    "  normalize();",
    "  return 0;",
    "}",
    "",
  ].join("\n"),
  "web/shapes.ts": [
    "export interface Shape {",
    "  area(): number;",
    "}",
    "export class Circle implements Shape {",
    "  area(): number {",
    "    return 3;",
    "  }",
    "}",
    "export class Square implements Shape {",
    "  area(): number {",
    "    return 4;",
    "  }",
    "}",
    "export function totalArea(shape: Shape): number {",
    "  return shape.area();",
    "}",
    "",
  ].join("\n"),
  "web/format.ts": ["export function formatLabel(): string {", '  return "x";', "}", ""].join("\n"),
  "web/legacy.js": [
    "export function legacyInit() {",
    "  ping();",
    "  tokenize();",
    "  return formatLabel();",
    "}",
    "",
  ].join("\n"),
  "app/models/base.rb": ["class Base", "  def save", "    true", "  end", "end", ""].join("\n"),
  "app/models/shapes.rb": [
    "class Circle",
    "  def area",
    "    3",
    "  end",
    "end",
    "",
    "class Square",
    "  def area",
    "    4",
    "  end",
    "end",
    "",
  ].join("\n"),
  "app/workers/worker.rb": [
    "class Worker",
    "  def perform",
    "    ping",
    "  end",
    "",
    "  def ping",
    "    true",
    "  end",
    "end",
    "",
  ].join("\n"),
  "lib/text.py": [
    "def normalize(value):",
    "    return value",
    "",
    "",
    "def tokenize(value):",
    "    return [value]",
    "",
  ].join("\n"),
};

const ECMASCRIPT_PATH = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

interface MethodEdgeRow {
  source_symbol_id: string;
  source_rel_path: string;
  target_symbol_id: string | null;
  target_rel_path: string;
  edge_kind: string;
}

interface RunStatsRow {
  language: string;
  receiver_kind: string;
  attempted: number;
  resolved: number;
  no_in_project_def: number;
  external_skipped: number;
  unresolvable: number;
  ambiguous_fanout: number;
  core_ambiguous: number;
}

describe("TS / JS resolution stays inside the ECMAScript family (bd tea-rags-mcp-t5cji)", () => {
  let tmp: string;
  let root: string;
  let client: DuckDbGraphClient;
  let provider: CodegraphEnrichmentProvider;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-ecmascript-family-db-"));
    root = mkdtempSync(join(tmpdir(), "cg-ecmascript-family-repo-"));
    for (const [relPath, source] of Object.entries(POLYGLOT_CORPUS)) {
      mkdirSync(dirname(join(root, relPath)), { recursive: true });
      writeFileSync(join(root, relPath), source);
    }
    client = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
    await client.init();
    await runMigrations(client, MIG_DIR);
    provider = new CodegraphEnrichmentProvider({
      graphDb: client,
      symbolTable: new InMemoryGlobalSymbolTable(),
      ...buildTestCodegraphDeps(),
      composer: new DefaultSymbolIdComposer(),
      collectSymbols,
    });
    // The ingest pipeline's own sequence: extract, absorb (pass-1 + barrier
    // inputs), finalize (pass-2 through CallEdgeResolutionRunner, then the
    // resolve tally into `cg_run_stats`).
    const batch = await provider.extractFileBatch(root, Object.keys(POLYGLOT_CORPUS).sort());
    await provider.absorbExtractedFiles(root, batch.extractions);
    await provider.finalizeSignals(root);
  });

  afterEach(async () => {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  const methodEdges = async (): Promise<MethodEdgeRow[]> =>
    client.queryAll<MethodEdgeRow>(
      "SELECT source_symbol_id, source_rel_path, target_symbol_id, target_rel_path, edge_kind FROM cg_symbols_edges_method",
    );

  const targetsOf = (edges: MethodEdgeRow[], source: string): string[] =>
    edges
      .filter((edge) => edge.source_symbol_id === source)
      .map((edge) => `${edge.target_rel_path}::${edge.target_symbol_id ?? ""}`)
      .sort();

  it("never persists an edge from a TS / JS caller onto a Ruby or Python definition", async () => {
    const foreign = (await methodEdges()).filter(
      (edge) => ECMASCRIPT_PATH.test(edge.source_rel_path) && !ECMASCRIPT_PATH.test(edge.target_rel_path),
    );
    expect(foreign).toEqual([]);
  });

  it("keeps a TS ↔ JS edge in both directions", async () => {
    const edges = await methodEdges();
    expect(targetsOf(edges, "main")).toContain("web/legacy.js::legacyInit");
    expect(targetsOf(edges, "legacyInit")).toEqual(["web/format.ts::formatLabel"]);
  });

  it("pins `super.save()` to the TypeScript parent despite a Ruby `Base#save`", async () => {
    expect(targetsOf(await methodEdges(), "Child#save")).toEqual(["web/app.ts::Base#save"]);
  });

  it("fans the interface call out to the TypeScript implementers despite Ruby namesake classes", async () => {
    expect(targetsOf(await methodEdges(), "totalArea")).toEqual([
      "web/shapes.ts::Circle#area",
      "web/shapes.ts::Square#area",
    ]);
  });

  it("counts a bare call whose only namesake is foreign as having no in-project definition", async () => {
    const rows = await client.queryAll<RunStatsRow>(
      "SELECT * FROM cg_run_stats WHERE receiver_kind = 'bareCall' AND language IN ('typescript', 'javascript') ORDER BY language",
    );
    const summary = rows.map((row) => ({
      language: row.language,
      attempted: Number(row.attempted),
      resolved: Number(row.resolved),
      noInProjectDef: Number(row.no_in_project_def),
      missWithInProjectDef:
        Number(row.attempted) -
        Number(row.resolved) -
        Number(row.no_in_project_def) -
        Number(row.external_skipped) -
        Number(row.unresolvable) -
        Number(row.ambiguous_fanout) -
        Number(row.core_ambiguous),
    }));
    // TS: `legacyInit()` resolves, `perform()` / `normalize()` have no TS / JS
    // definition. JS: `formatLabel()` resolves, `ping()` / `tokenize()` don't.
    expect(summary).toEqual([
      { language: "javascript", attempted: 3, resolved: 1, noInProjectDef: 2, missWithInProjectDef: 0 },
      { language: "typescript", attempted: 3, resolved: 1, noInProjectDef: 2, missWithInProjectDef: 0 },
    ]);
  });
});
