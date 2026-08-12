/**
 * Whole-run profile of the production TypeScript resolve path over the
 * synthetic corpus (bd tea-rags-mcp-d77bl).
 *
 * `ts-program-cache-run-profile.ts` measures the Program cache in isolation,
 * which answers what a build costs but not how often the run asks for one. This
 * driver runs the real `CallEdgeResolutionRunner` — the same class
 * `GraphBuildFinalizer#resolveAndUpsert` drives, minus the DuckDB write — so the
 * numbers it reports are attempt counts and edge sets a production run would
 * produce.
 *
 * Two outputs, and the second is the one that matters for a scheduling change:
 * a summary (attempts, resolve outcomes, checker-fallback trigger rate, wall
 * clock) and, under `--dump`, the full edge set in a stable order. A change that
 * only alters WHICH Program answers a query must leave that dump byte-identical.
 *
 *   npx tsx scripts/spikes/ts-resolve-path-profile.ts [--features N] [--no-barrels] [--dump FILE]
 */

import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import type { FileExtraction, GraphEdges } from "../../src/core/contracts/types/codegraph.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../../src/core/domains/language/index.js";
import type { TSProgramCache } from "../../src/core/domains/language/typescript/resolver/ts-program-cache.js";
import { CallEdgeResolutionRunner } from "../../src/core/domains/trajectory/codegraph/symbols/resolution-runner.js";
import { CodegraphRunState } from "../../src/core/domains/trajectory/codegraph/symbols/run-state.js";
import { InMemoryGlobalSymbolTable } from "../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { buildSymbolDefs, extractFile } from "../ts-codegraph-typechecker-oracle.js";
import { collectProjectFiles, FIXTURE_ROOT, parseShapeArgs } from "./ts-fixture-corpus.js";
import { DEFAULT_SHAPE, generateFixture, type FixtureShape } from "./ts-fixture-gen.js";

/**
 * Reach the `TSProgramCache` the runner will actually use.
 *
 * `TypeScriptLanguage` builds its resolver lazily on the first resolve, keyed by
 * the root the context carries, so the cache does not exist until something has
 * resolved. Rather than duplicate that binding rule here — where a copy would
 * drift from `resolverFor` and silently profile a DIFFERENT cache than the run
 * used — the instrumentation is attached after the first file resolves.
 */
function programCacheOf(language: unknown): TSProgramCache | null {
  const { bound } = language as { bound?: { resolver?: { programCache?: TSProgramCache | null } } };
  return bound?.resolver?.programCache ?? null;
}

/** Edges in a stable order, so two runs differ only when resolution differs. */
function formatEdges(relPath: string, edges: GraphEdges): string[] {
  const lines: string[] = [];
  for (const edge of edges.fileEdges) lines.push(`F\t${relPath}\t${edge.targetRelPath}\t${edge.importText}`);
  for (const edge of edges.methodEdges) {
    lines.push(
      `M\t${relPath}\t${edge.sourceSymbolId}\t${edge.targetSymbolId ?? ""}\t${edge.targetRelPath ?? ""}\t${edge.callExpression}\t${edge.edgeKind ?? ""}\t${edge.confidence ?? ""}`,
    );
  }
  for (const row of edges.inheritance ?? []) lines.push(`I\t${relPath}\t${JSON.stringify(row)}`);
  for (const row of edges.ambiguousFanouts ?? []) lines.push(`A\t${relPath}\t${JSON.stringify(row)}`);
  return lines.sort();
}

function run(shape: FixtureShape, dumpPath: string | null): void {
  generateFixture(FIXTURE_ROOT, shape);
  const files = collectProjectFiles(FIXTURE_ROOT);

  const composer = new DefaultSymbolIdComposer();
  const factory = new LanguageFactory({ repoRoot: FIXTURE_ROOT });
  const language = factory.create("typescript");
  const symbolTable = new InMemoryGlobalSymbolTable();

  // Pass 1 — the symbol table must be complete before the first resolve, or a
  // cross-file target simply is not there to be found.
  const extractStarted = performance.now();
  const extractions: FileExtraction[] = [];
  for (const relPath of files) {
    const extraction = extractFile(FIXTURE_ROOT, relPath, composer, factory);
    if (extraction === null) continue;
    symbolTable.upsertFile(relPath, buildSymbolDefs(extraction));
    extractions.push(extraction);
  }
  const extractMs = performance.now() - extractStarted;

  const runState = new CodegraphRunState();
  runState.bindProjectRoot(FIXTURE_ROOT);
  const runner = new CallEdgeResolutionRunner(factory, runState);

  const dump: string[] = [];
  let acquireCalls = 0;
  let programBuilds = 0;
  let instrumented = false;

  const resolveStarted = performance.now();
  for (const extraction of extractions) {
    const edges = runner.resolve(extraction, symbolTable);
    if (dumpPath !== null) dump.push(...formatEdges(extraction.relPath, edges));

    if (!instrumented) {
      // First file resolved ⇒ the lazy resolver (and its cache) now exists.
      const cache = programCacheOf(language);
      if (cache) {
        const realAcquire = cache.acquire.bind(cache);
        const seen = new Set<string>();
        cache.acquire = (relPath): ReturnType<typeof realAcquire> => {
          acquireCalls += 1;
          if (!seen.has(relPath)) {
            seen.add(relPath);
            programBuilds += 1;
          }
          return realAcquire(relPath);
        };
      }
      instrumented = true;
    }
  }
  const resolveMs = performance.now() - resolveStarted;

  const { stats } = runState;
  const attempted = stats.callsAttempted;
  console.log(
    JSON.stringify(
      {
        corpusFiles: files.length,
        barrels: shape.useBarrels,
        extractMs: Math.round(extractMs),
        resolveMs: Math.round(resolveMs),
        resolveFilesPerSec: +(extractions.length / (resolveMs / 1000)).toFixed(2),
        calls: {
          attempted,
          resolved: stats.callsResolved,
          externalSkipped: stats.callsExternalSkipped,
          noInProjectDef: stats.callsNoInProjectDef,
          unresolvable: stats.callsUnresolvable,
          ambiguousFanout: stats.callsAmbiguousFanout,
        },
        edges: { file: stats.fileEdgeCount, method: stats.methodEdgeCount },
        typeCheckerFallback: {
          // Counted from the second file onward — instrumentation attaches after
          // the first resolve, which is what creates the cache to instrument.
          acquireCalls,
          distinctEntriesAcquired: programBuilds,
          acquiresPerCall: attempted > 0 ? +(acquireCalls / attempted).toFixed(3) : 0,
        },
        rssMb: +(process.memoryUsage().rss / 1024 / 1024).toFixed(1),
      },
      null,
      2,
    ),
  );

  if (dumpPath !== null) {
    writeFileSync(dumpPath, `${dump.sort().join("\n")}\n`, "utf8");
    console.log(`edge dump: ${dump.length} rows -> ${dumpPath}`);
  }
}

const argv = process.argv.slice(2);
const dumpIndex = argv.indexOf("--dump");
const dumpPath = dumpIndex >= 0 ? (argv[dumpIndex + 1] ?? null) : null;
const args = parseShapeArgs(argv, DEFAULT_SHAPE);
run(args.shape, dumpPath);
