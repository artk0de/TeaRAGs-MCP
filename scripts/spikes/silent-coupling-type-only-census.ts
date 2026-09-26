/**
 * silent-coupling-type-only-census.ts (bd tea-rags-mcp-r8hme.12 follow-up)
 *
 * What removing the silent-coupling no-symbol-endpoint exclusion changed. The
 * exclusion dropped every co-change pair with a walked endpoint that defines no
 * symbol, on the premise that such a module's dependencies are `import type`
 * and so invisible to the file graph. r8hme.12 made them visible
 * (`cg_symbols_edges_file_type_only`), which voided the premise, and the
 * exclusion was removed. The production detector no longer has it, so the
 * spike EMULATES it by dropping those pairs from the graph before detection
 * (an excluded pair was never a candidate, so the threshold population is
 * identical).
 *
 * It works on a COPY of a codegraph DuckDB file that predates r8hme.12:
 *   1. read the production file graph and the co-change graph, run the detector
 *      with the emulated exclusion (baseline — the type-only table is empty);
 *   2. walk the corpus's type-only-capable files with the production walkers +
 *      `CallEdgeResolutionRunner` and insert every
 *      `GraphEdges.typeOnlyFileEdges` row into the copy;
 *   3. re-read the co-change graph (production `readGraph` UNION) and run the
 *      detector with the emulated exclusion and as production runs it.
 *
 * Usage (the copy is MUTATED — never point it at ~/.tea-rags/codegraph):
 *   env -u NODE_OPTIONS npx tsx scripts/spikes/silent-coupling-type-only-census.ts \
 *     --db $TMPDIR/copy.duckdb --corpus <abs repo root> [--json out.json]
 */

import { writeFileSync } from "node:fs";
import { extname, resolve } from "node:path";

import { DuckDbGraphClient } from "../../src/core/adapters/duckdb/client.js";
import type {
  FileExtraction,
  RelPath,
  TemporalCochangeEdgeWithLinkage,
  TemporalCochangeGraph,
} from "../../src/core/contracts/types/codegraph.js";
import { DOCUMENTATION_LANGUAGES, LANGUAGE_MAP } from "../../src/core/domains/ingest/pipeline/chunker/config.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../../src/core/domains/language/index.js";
import { SQL_037_CG_TYPE_ONLY_FILE_EDGES } from "../../src/core/domains/maintenance/migration/database/migrations/037-cg-type-only-file-edges.js";
import { collectSchemaColumnSources } from "../../src/core/domains/trajectory/codegraph/exclusion.js";
import { excludeNonProductionFiles } from "../../src/core/domains/trajectory/codegraph/symbols/boundary-diagnostics/production-graph.js";
import { absorbPass1FileState } from "../../src/core/domains/trajectory/codegraph/symbols/extraction-sink.js";
import { CODEGRAPH_LANGUAGES } from "../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { CallEdgeResolutionRunner } from "../../src/core/domains/trajectory/codegraph/symbols/resolution-runner.js";
import { CodegraphRunState } from "../../src/core/domains/trajectory/codegraph/symbols/run-state.js";
import { InMemoryGlobalSymbolTable } from "../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import {
  cochangeStrength,
  detectSilentCoupling,
} from "../../src/core/domains/trajectory/codegraph/temporal/boundary-diagnostics/silent-coupling.js";
import type { SilentCouplingReport } from "../../src/core/domains/trajectory/codegraph/temporal/boundary-diagnostics/types.js";
import { collectDependencyManifestSources } from "../../src/core/infra/dependency-manifests.js";
import { buildNonProductionPathFilter, classify } from "../../src/core/infra/file-classification/index.js";
import {
  buildCorpusExclusionFilter,
  buildSymbolDefs,
  collectSourceFiles,
  extractFile,
} from "../ts-codegraph-typechecker-oracle.js";

/** Languages whose walker records type-only imports (r8hme.12). */
const TYPE_ONLY_CHANNEL_LANGUAGES = new Set(["typescript", "python"]);

/**
 * Extensions walked for type-only edges: the channel's languages plus
 * JavaScript, whose modules a TypeScript import may name. Nothing else can
 * emit a type-only edge, and skipping it keeps a large polyglot corpus
 * (a Rails monolith) walkable in one process.
 */
const TYPE_ONLY_WALK_EXTENSIONS = Object.entries(CODEGRAPH_LANGUAGES)
  .filter(([, config]) => TYPE_ONLY_CHANNEL_LANGUAGES.has(config.language) || config.language === "javascript")
  .map(([ext]) => ext);

/** The removed exclusion, emulated: drop every pair with a walked no-symbol endpoint. */
function withNoSymbolExclusion(graph: TemporalCochangeGraph, symbolCounts: ReadonlyMap<RelPath, number>) {
  return { ...graph, edges: graph.edges.filter((e) => !hasNoSymbolEndpoint(e, symbolCounts)) };
}

function hasNoSymbolEndpoint(
  edge: Pick<TemporalCochangeEdgeWithLinkage, "relPathA" | "relPathB">,
  symbolCounts: ReadonlyMap<RelPath, number>,
): boolean {
  return [edge.relPathA, edge.relPathB].some((p) => symbolCounts.get(p) === 0);
}

function isDocumentationPath(relPath: RelPath): boolean {
  const language = LANGUAGE_MAP[extname(relPath).toLowerCase()];
  return language !== undefined && DOCUMENTATION_LANGUAGES.has(language);
}

function parseArgs(argv: readonly string[]): { db: string; corpus: string; json: string | null } {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const db = get("--db");
  const corpus = get("--corpus");
  if (!db || !corpus) throw new Error("usage: --db <copy.duckdb> --corpus <repo root> [--json out]");
  if (resolve(db).includes("/.tea-rags/codegraph/")) throw new Error("refusing to mutate a live codegraph file");
  return { db: resolve(db), corpus: resolve(corpus), json: get("--json") ?? null };
}

async function computeTypeOnlyEdges(
  root: string,
): Promise<{ source: RelPath; target: RelPath; importText: string | null }[]> {
  const factory = new LanguageFactory({ repoRoot: root });
  const composer = new DefaultSymbolIdComposer();
  const runState = new CodegraphRunState(
    collectSchemaColumnSources(factory),
    collectDependencyManifestSources(factory),
  );
  runState.bindProjectRoot(root);
  runState.loadGemfile(root);
  runState.loadDeclaredDependencies(root);
  runState.loadSchemaSnapshots(root);
  const symbolTable = new InMemoryGlobalSymbolTable();
  const selection = await collectSourceFiles(
    root,
    root,
    await buildCorpusExclusionFilter(root, factory),
    TYPE_ONLY_WALK_EXTENSIONS,
  );
  const extractions: FileExtraction[] = [];
  for (const relPath of selection.kept) {
    const extraction = extractFile(root, relPath, composer, factory, runState.declaredDependencies);
    if (extraction === null) continue;
    absorbPass1FileState(runState, symbolTable, extraction, buildSymbolDefs(extraction), "own");
    extractions.push(extraction);
  }
  await runState.seal(async () => symbolTable);
  const runner = new CallEdgeResolutionRunner(factory, runState);
  runner.prepareResolvePass();
  const rows: { source: RelPath; target: RelPath; importText: string | null }[] = [];
  for (const extraction of extractions) {
    const edges = runner.resolve(extraction, symbolTable);
    for (const e of edges.typeOnlyFileEdges ?? []) {
      rows.push({ source: extraction.relPath, target: e.targetRelPath, importText: e.importText });
    }
  }
  process.stderr.write(`walked ${extractions.length} files, ${rows.length} type-only file edges\n`);
  return rows;
}

function summaryLine(label: string, r: SilentCouplingReport): string {
  const s = r.summary;
  return (
    `${label}: pairs=${s.pairCount} candidates=${s.candidateCount} strong=${s.strongCount} ` +
    `strongLinked=${s.strongLinkedCount} violations=${s.violationCount} rootCauses=${s.rootCauseCount} ` +
    `threshold=${s.strengthThreshold.toFixed(4)} (${s.strengthThresholdMethod}) ` +
    `excluded.nonPositiveLift=${s.excluded.nonPositiveLift}`
  );
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** Why a no-symbol endpoint's language/shape leaves it without a type-only channel. */
function endpointKind(relPath: RelPath, language: string | undefined): string {
  if (relPath.endsWith(".d.ts")) return "typescript .d.ts";
  if (language && TYPE_ONLY_CHANNEL_LANGUAGES.has(language)) return `${language} (has type-only channel)`;
  return `${language ?? "unknown"} (${extname(relPath) || "no ext"})`;
}

async function main(): Promise<void> {
  const { db, corpus, json } = parseArgs(process.argv.slice(2));
  const client = new DuckDbGraphClient({ path: db });
  await client.init();
  try {
    await client.exec(SQL_037_CG_TYPE_ONLY_FILE_EDGES);
    const preexisting = await client.queryAll<{ n: bigint }>(
      "SELECT count(*) AS n FROM cg_symbols_edges_file_type_only",
    );
    process.stderr.write(`type-only rows already in copy (replaced by the walk): ${Number(preexisting[0]?.n ?? 0)}\n`);
    await client.exec("DELETE FROM cg_symbols_edges_file_type_only");

    const nonProduction = buildNonProductionPathFilter();
    const {
      graph: { files },
    } = excludeNonProductionFiles(await client.readFileDependencyGraph(), nonProduction);
    const byPath = new Map(files.map((f) => [f.relPath, f]));
    const symbolCounts = new Map(files.map((f) => [f.relPath, f.symbolCount]));
    const opts = { isDocumentation: isDocumentationPath };

    const graphBefore = await client.readTemporalCochangeGraph();
    const before = detectSilentCoupling(withNoSymbolExclusion(graphBefore, symbolCounts), files, opts);

    const typeOnly = await computeTypeOnlyEdges(corpus);
    for (const row of typeOnly) {
      await client.run(
        "INSERT OR IGNORE INTO cg_symbols_edges_file_type_only (source_rel_path, target_rel_path, import_text) VALUES (?, ?, ?)",
        [row.source, row.target, row.importText],
      );
    }

    const graphAfter = await client.readTemporalCochangeGraph();
    const after = detectSilentCoupling(withNoSymbolExclusion(graphAfter, symbolCounts), files, opts);
    // Production: the exclusion is gone.
    const removed = detectSilentCoupling(graphAfter, files, opts);

    // Pair-level census of the pairs the exclusion used to drop (after-state linkage).
    const beforeLinked = new Map(graphBefore.edges.map((e) => [`${e.relPathA}\0${e.relPathB}`, e.structurallyLinked]));
    const excludedPairs: (TemporalCochangeEdgeWithLinkage & { linkedBefore: boolean })[] = [];
    for (const e of graphAfter.edges) {
      const eps = [e.relPathA, e.relPathB];
      const classes = eps.map((p) => classify(p));
      if (classes.some((c) => c.isTest || c.isGenerated)) continue;
      if (eps.some(isDocumentationPath)) continue;
      if (!hasNoSymbolEndpoint(e, symbolCounts)) continue;
      excludedPairs.push({ ...e, linkedBefore: beforeLinked.get(`${e.relPathA}\0${e.relPathB}`) ?? false });
    }
    let linkedBefore = 0;
    let linkedAfter = 0;
    let newlyLinked = 0;
    const unlinkedKinds = new Map<string, number>();
    const newlyLinkedKinds = new Map<string, number>();
    let unlinkedPositiveLift = 0;
    let unlinkedAboveThreshold = 0;
    const unlinkedStrongSamples: string[] = [];
    for (const p of excludedPairs) {
      if (p.linkedBefore) linkedBefore++;
      if (p.structurallyLinked) linkedAfter++;
      const noSym = [p.relPathA, p.relPathB].filter((x) => symbolCounts.get(x) === 0);
      const kinds = [...new Set(noSym.map((x) => endpointKind(x, byPath.get(x)?.language)))].sort().join(" + ");
      if (p.structurallyLinked && !p.linkedBefore) {
        newlyLinked++;
        bump(newlyLinkedKinds, kinds);
      }
      if (!p.structurallyLinked) {
        bump(unlinkedKinds, kinds);
        if (p.lift > 1) {
          unlinkedPositiveLift++;
          const strength = cochangeStrength(p);
          if (strength > removed.summary.strengthThreshold && strength > 0.5) {
            unlinkedAboveThreshold++;
            if (unlinkedStrongSamples.length < 25) {
              unlinkedStrongSamples.push(`${strength.toFixed(3)} ${p.relPathA} <-> ${p.relPathB} [${kinds}]`);
            }
          }
        }
      }
    }

    const noSymbolFileKinds = new Map<string, number>();
    for (const f of files) if (f.symbolCount === 0) bump(noSymbolFileKinds, endpointKind(f.relPath, f.language));

    const out = [
      summaryLine("exclusion, type-only table empty   ", before),
      summaryLine("exclusion, type-only edges         ", after),
      summaryLine("production (no exclusion, type-only)", removed),
      "",
      `no-symbol-endpoint pairs (formerly excluded): ${excludedPairs.length}`,
      `  structurally linked before type-only: ${linkedBefore}`,
      `  structurally linked after  type-only: ${linkedAfter} (newly linked: ${newlyLinked})`,
      `  still unlinked: ${excludedPairs.length - linkedAfter} (lift>1: ${unlinkedPositiveLift}, strong under the removed-exclusion threshold: ${unlinkedAboveThreshold})`,
      "  newly linked, by no-symbol endpoint kind:",
      ...[...newlyLinkedKinds].sort((a, b) => b[1] - a[1]).map(([k, n]) => `    ${n}\t${k}`),
      "  still unlinked, by no-symbol endpoint kind:",
      ...[...unlinkedKinds].sort((a, b) => b[1] - a[1]).map(([k, n]) => `    ${n}\t${k}`),
      "no-symbol walked files, by kind:",
      ...[...noSymbolFileKinds].sort((a, b) => b[1] - a[1]).map(([k, n]) => `    ${n}\t${k}`),
      "strong still-unlinked samples:",
      ...unlinkedStrongSamples.map((s) => `    ${s}`),
      "",
      "violations only without the exclusion (top 40):",
      ...removed.violations
        .filter((v) => !after.violations.some((a) => a.relPathA === v.relPathA && a.relPathB === v.relPathB))
        .slice(0, 40)
        .map((v) => `    ${v.strength.toFixed(3)} ${v.relPathA} <-> ${v.relPathB} (support ${v.support})`),
    ];
    process.stdout.write(`${out.join("\n")}\n`);
    if (json) {
      writeFileSync(
        json,
        JSON.stringify({ before: before.summary, after: after.summary, production: removed.summary }, null, 2),
      );
    }
  } finally {
    await client.close();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
