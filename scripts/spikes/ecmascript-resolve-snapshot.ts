/**
 * Offline A/B of the TypeScript / JavaScript call-edge resolution a real
 * codegraph pass produces — the edge set and the per-receiver-kind buckets —
 * with no index run and no DuckDB (bd tea-rags-mcp-B12, bd tea-rags-mcp-t5cji).
 *
 *   npx tsx scripts/spikes/ecmascript-resolve-snapshot.ts snapshot --root <repo> --out <file.json>
 *        [--typescript <package dir>] [--ecmascript-only] [--explain <relPath>]
 *   npx tsx scripts/spikes/ecmascript-resolve-snapshot.ts diff <a.json> <b.json> [--limit N]
 *
 * `snapshot` walks what production's `CodegraphFileExtractor#discover` admits
 * (every codegraph extension, both ignore layers, `.d.ts` kept) and mirrors
 * production's pass-1 → barrier → pass-2 for the ECMAScript partition, the shape
 * a language-affinity run gives TypeScript: every file is absorbed into the
 * symbol table and the run-global maps; the TS / JS files are absorbed as `own`
 * and resolved by the real `CallEdgeResolutionRunner`, everything else as
 * `mirror`; `CodegraphRunState#seal` builds the hierarchy between the two. The
 * resolve tally is production's own (`toResolveRunStatsRows`), not a copy.
 *
 * `--typescript <dir>` loads the compiler from ANOTHER `typescript` package —
 * the TS 5.9 vs 6.0 edge-neutrality question (B12). A module-resolution hook is
 * registered before anything that reaches `typescript` is imported, so every
 * `import ts from "typescript"` in the resolver binds to that package; the run
 * then asserts that exactly one compiler was loaded and that it is the one
 * asked for, and records its version and default-lib path in the snapshot.
 * That is why every non-builtin import below is dynamic.
 *
 * `--ecmascript-only` drops every non-TS/JS file from the walk. After t5cji the
 * TS / JS resolvers never read a foreign definition, so a polyglot snapshot and
 * an ECMAScript-only one must be byte-identical — the completeness check for the
 * family filter. Before t5cji the two differ by exactly the cross-language edges.
 *
 * `diff` prints the per-kind delta, the edge-set delta grouped by call site and
 * the per-file bucket rows that moved, and says IDENTICAL when there is none.
 * `--explain <relPath>` then names the CALL behind a moved per-file row: it
 * resolves only that file, one call at a time through the same runner, and
 * prints the bucket each call's tally moved into (no snapshot is written).
 *
 * Divergences from a live run, stated: no DuckDB write; persisted pass-1
 * aggregates are not hydrated (a whole-corpus walk has nothing to hydrate); the
 * symbol definitions are the oracle's `buildSymbolDefs`, which omits the Ruby
 * arity / visibility fields no TS / JS lookup reads.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire, register } from "node:module";
import { dirname, join, relative, resolve as resolvePath } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import type { FileExtraction, GraphEdges, ResolveRunStatsRow } from "../../src/core/contracts/types/codegraph.js";

const ECMASCRIPT_PATH = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

interface ResolveSnapshot {
  meta: {
    root: string;
    typescriptVersion: string;
    /** The compiler's own `lib` directory — evidence of which `lib.dom.d.ts` the checker read. */
    typescriptLibDir: string;
    ecmascriptOnly: boolean;
    ecmascriptFiles: number;
    foreignFiles: number;
    symbols: number;
    pass1Ms: number;
    pass2Ms: number;
    resolverDiagnostics: Record<string, Record<string, unknown>>;
  };
  /** `toResolveRunStatsRows()` for the TS / JS languages. */
  stats: ResolveRunStatsRow[];
  /**
   * `toFileResolveStatsEntries()`, one JSON line per (file, receiver kind) — what
   * names the file behind a bucket move that leaves the edge set alone.
   */
  fileStats: string[];
  /** Method edges whose source is TS / JS and whose target is not. */
  foreignTargetEdges: number;
  /** One line per persisted row, sorted — two runs differ only when resolution does. */
  edges: string[];
}

interface SnapshotOptions {
  root: string;
  /** `null` only with `explain`, which prints instead of writing a snapshot. */
  out: string | null;
  typescriptPackage: string | null;
  ecmascriptOnly: boolean;
  /** Resolve only this file, one call at a time, printing each call's bucket. */
  explain: string | null;
}

function argValue(argv: readonly string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null;
}

/**
 * Route every `import "typescript"` to `packageDir` — registered BEFORE the
 * first dynamic import that can reach the compiler, which is the whole
 * contract: a module already evaluated keeps the binding it got.
 */
function registerTypescriptOverride(packageDir: string): void {
  const entry = pathToFileURL(join(resolvePath(packageDir), "lib", "typescript.js")).href;
  const hook = [
    `const ENTRY = ${JSON.stringify(entry)};`,
    "export async function resolve(specifier, context, nextResolve) {",
    '  if (specifier === "typescript") return { url: ENTRY, format: "commonjs", shortCircuit: true };',
    "  return nextResolve(specifier, context);",
    "}",
  ].join("\n");
  register(`data:text/javascript,${encodeURIComponent(hook)}`);
}

/** Every `lib/typescript.js` in the module cache — the run must have loaded exactly one. */
function loadedCompilers(): string[] {
  const { cache } = createRequire(import.meta.url);
  return Object.keys(cache).filter((path) => path.endsWith(join("typescript", "lib", "typescript.js")));
}

function formatEdges(relPath: string, edges: GraphEdges): string[] {
  const lines: string[] = [];
  for (const edge of edges.fileEdges) lines.push(`F\t${relPath}\t${edge.targetRelPath}\t${edge.importText}`);
  for (const edge of edges.methodEdges) {
    lines.push(
      `M\t${relPath}\t${edge.sourceSymbolId}\t${edge.callExpression}\t${edge.targetRelPath ?? ""}\t${edge.targetSymbolId ?? ""}\t${edge.edgeKind ?? ""}\t${edge.confidence ?? ""}`,
    );
  }
  for (const row of edges.ambiguousFanouts ?? []) lines.push(`A\t${relPath}\t${JSON.stringify(row)}`);
  return lines;
}

async function snapshot(opts: SnapshotOptions): Promise<void> {
  if (opts.typescriptPackage !== null) registerTypescriptOverride(opts.typescriptPackage);
  const ts = (await import("typescript")).default;
  const { DefaultSymbolIdComposer, LanguageFactory } = await import("../../src/core/domains/language/index.js");
  const { collectDependencyManifestSources } = await import("../../src/core/infra/dependency-manifests.js");
  const { collectSchemaColumnSources } = await import("../../src/core/domains/trajectory/codegraph/exclusion.js");
  const { CODEGRAPH_SUPPORTED_EXTENSIONS, extensionOf } =
    await import("../../src/core/domains/trajectory/codegraph/symbols/file-extractor.js");
  const { normalizeInheritanceEdges } =
    await import("../../src/core/domains/trajectory/codegraph/symbols/inheritance-edges.js");
  const { CallEdgeResolutionRunner } =
    await import("../../src/core/domains/trajectory/codegraph/symbols/resolution-runner.js");
  const { CodegraphRunState } = await import("../../src/core/domains/trajectory/codegraph/symbols/run-state.js");
  const { extractSelfDispatchMethods } =
    await import("../../src/core/domains/trajectory/codegraph/symbols/self-dispatch-discovery.js");
  const { InMemoryGlobalSymbolTable } =
    await import("../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js");
  const { buildCorpusExclusionFilter, buildSymbolDefs, extractFile } =
    await import("../ts-codegraph-typechecker-oracle.js");

  const root = resolvePath(opts.root);
  const factory = new LanguageFactory({ repoRoot: root });
  const composer = new DefaultSymbolIdComposer();
  const filters = await buildCorpusExclusionFilter(root, factory);

  // Discovery — `CodegraphFileExtractor#discover`: dotfiles pruned (bar
  // `.claude-plugin`), directories pruned on either layer, every codegraph
  // extension, `.d.ts` kept.
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") && entry.name !== ".claude-plugin") continue;
      const full = join(dir, entry.name);
      const relPath = relative(root, full).split("\\").join("/");
      if (entry.isDirectory()) {
        if (filters.ingest.ignores(`${relPath}/`) || filters.codegraph.ignores(`${relPath}/`)) continue;
        walk(full);
        continue;
      }
      if (!entry.isFile() || !CODEGRAPH_SUPPORTED_EXTENSIONS.has(extensionOf(entry.name))) continue;
      if (filters.ingest.ignores(relPath) || filters.codegraph.ignores(relPath)) continue;
      if (opts.ecmascriptOnly && !ECMASCRIPT_PATH.test(relPath)) continue;
      files.push(relPath);
    }
  };
  walk(root);
  files.sort();

  const runState = new CodegraphRunState(
    collectSchemaColumnSources(factory),
    collectDependencyManifestSources(factory),
  );
  runState.bindProjectRoot(root);
  runState.loadGemfile(root);
  runState.loadDeclaredDependencies(root);
  runState.loadSchemaSnapshots(root);
  const symbolTable = new InMemoryGlobalSymbolTable();

  // Pass 1 — the provider's `absorbPass1State`, per file, in walk order.
  const pass1Started = performance.now();
  const owned: FileExtraction[] = [];
  let foreignFiles = 0;
  for (const relPath of files) {
    const extraction = extractFile(root, relPath, composer, factory, runState.declaredDependencies);
    if (extraction === null) continue;
    const own = ECMASCRIPT_PATH.test(relPath);
    symbolTable.upsertFile(relPath, buildSymbolDefs(extraction));
    runState.absorb(
      extraction,
      extraction.language === "ruby" ? extractSelfDispatchMethods(extraction.chunks) : [],
      own ? "own" : "mirror",
    );
    runState.inheritanceRows.push(...normalizeInheritanceEdges(extraction, () => null));
    if (own) owned.push(extraction);
    else foreignFiles += 1;
  }
  const pass1Ms = performance.now() - pass1Started;

  // Barrier, then pass 2 over the owned partition only.
  await runState.seal(async () => symbolTable);
  const runner = new CallEdgeResolutionRunner(factory, runState);
  runner.prepareResolvePass();

  if (opts.explain !== null) {
    // One call at a time through the production runner, reading which bucket
    // its per-file tally moved — the classification is the runner's, not a copy.
    const target = owned.find((extraction) => extraction.relPath === opts.explain);
    if (target === undefined) throw new Error(`--explain: ${opts.explain} is not an owned TS / JS file`);
    const tallyOf = (): Map<string, string> =>
      new Map(
        runState
          .toFileResolveStatsEntries()
          .filter((entry) => entry.relPath === target.relPath)
          .flatMap((entry) => entry.rows.map((row) => [row.receiverKind, JSON.stringify(row)] as const)),
      );
    for (const chunk of target.chunks) {
      for (const call of chunk.calls) {
        const before = tallyOf();
        const graph = runner.resolve({ ...target, chunks: [{ ...chunk, calls: [call] }] }, symbolTable);
        const after = tallyOf();
        const moved = [...after]
          .filter(([kind, row]) => before.get(kind) !== row)
          .map(([kind, row]) => {
            const was = JSON.parse(before.get(kind) ?? "{}") as Record<string, unknown>;
            const now = JSON.parse(row) as Record<string, unknown>;
            const buckets = Object.keys(now).filter(
              (k) => k !== "attempted" && typeof now[k] === "number" && now[k] !== (was[k] ?? 0),
            );
            return `${kind}:${buckets.join("+") || "missWithInProjectDef"}`;
          });
        const targets = graph.methodEdges.map((edge) => `${edge.targetRelPath}::${edge.targetSymbolId ?? ""}`);
        process.stdout.write(
          `${call.startLine}\t${moved.join(",")}\t${call.callText.replace(/\s+/g, " ").slice(0, 100)}\t${targets.join(" | ")}\n`,
        );
      }
    }
    return;
  }

  const pass2Started = performance.now();
  const edges: string[] = [];
  let foreignTargetEdges = 0;
  for (const [index, extraction] of owned.entries()) {
    const graph = runner.resolve(extraction, symbolTable);
    edges.push(...formatEdges(extraction.relPath, graph));
    for (const edge of graph.methodEdges) {
      if (edge.targetRelPath !== undefined && !ECMASCRIPT_PATH.test(edge.targetRelPath)) foreignTargetEdges += 1;
    }
    if ((index + 1) % 1000 === 0) process.stderr.write(`pass-2 ${index + 1}/${owned.length}\n`);
  }
  const pass2Ms = performance.now() - pass2Started;
  edges.sort();

  const compilers = loadedCompilers();
  if (compilers.length !== 1) throw new Error(`expected one loaded compiler, found: ${compilers.join(", ")}`);
  if (opts.typescriptPackage !== null && !compilers[0].startsWith(resolvePath(opts.typescriptPackage))) {
    throw new Error(`override ignored: loaded ${compilers[0]}, asked for ${opts.typescriptPackage}`);
  }

  const result: ResolveSnapshot = {
    meta: {
      root,
      typescriptVersion: ts.version,
      typescriptLibDir: dirname(ts.getDefaultLibFilePath({})),
      ecmascriptOnly: opts.ecmascriptOnly,
      ecmascriptFiles: owned.length,
      foreignFiles,
      symbols: symbolTable.size(),
      pass1Ms: Math.round(pass1Ms),
      pass2Ms: Math.round(pass2Ms),
      resolverDiagnostics: runner.resolverDiagnostics(),
    },
    stats: runState
      .toResolveRunStatsRows()
      .filter((row) => (row.language === "typescript" || row.language === "javascript") && row.attempted > 0),
    fileStats: runState
      .toFileResolveStatsEntries()
      .flatMap((entry) => entry.rows.map((row) => JSON.stringify({ relPath: entry.relPath, ...row })))
      .sort(),
    foreignTargetEdges,
    edges,
  };
  if (opts.out === null) throw new Error("snapshot needs --out unless --explain is given");
  writeFileSync(opts.out, JSON.stringify(result));
  process.stdout.write(
    `${JSON.stringify({ ...result.meta, foreignTargetEdges, edges: edges.length, compiler: compilers[0] }, null, 2)}\n`,
  );
}

/** The charged residual — everything attempted that no bucket excludes and nothing resolved. */
function residualOf(row: ResolveRunStatsRow): number {
  return (
    row.attempted -
    row.resolved -
    row.externalSkipped -
    (row.noInProjectDef ?? 0) -
    (row.unresolvable ?? 0) -
    (row.coreAmbiguous ?? 0) -
    (row.ambiguousFanout ?? 0)
  );
}

function rateOf(row: ResolveRunStatsRow): number {
  const denominator = row.resolved + residualOf(row);
  return denominator === 0 ? 0 : row.resolved / denominator;
}

/** `M` lines keyed by call site (file, source symbol, call expression) → sorted target list. */
function targetsByCallSite(edges: readonly string[]): Map<string, string[]> {
  const sites = new Map<string, string[]>();
  for (const line of edges) {
    const parts = line.split("\t");
    if (parts[0] !== "M") continue;
    const key = `${parts[1]} ${parts[2]} ${parts[3]}`;
    const target = `${parts[4]}::${parts[5]}${parts[6] ? ` [${parts[6]} ${parts[7]}]` : ""}`;
    sites.set(key, [...(sites.get(key) ?? []), target].sort());
  }
  return sites;
}

function diff(aPath: string, bPath: string, limit: number): void {
  const a = JSON.parse(readFileSync(aPath, "utf8")) as ResolveSnapshot;
  const b = JSON.parse(readFileSync(bPath, "utf8")) as ResolveSnapshot;
  const out: string[] = [];
  out.push(
    `A: ${aPath} — typescript ${a.meta.typescriptVersion}, ${a.meta.ecmascriptFiles} TS/JS + ${a.meta.foreignFiles} other files, ${a.edges.length} rows, ${a.foreignTargetEdges} foreign-target`,
  );
  out.push(
    `B: ${bPath} — typescript ${b.meta.typescriptVersion}, ${b.meta.ecmascriptFiles} TS/JS + ${b.meta.foreignFiles} other files, ${b.edges.length} rows, ${b.foreignTargetEdges} foreign-target`,
  );

  out.push("", "language   kind        attempted  resolved(A→B)  extSkip(A→B)  noDef(A→B)  residual(A→B)  rate(A→B)");
  const key = (row: ResolveRunStatsRow): string => `${row.language}/${row.receiverKind}`;
  const bRows = new Map(b.stats.map((row) => [key(row), row]));
  const aRows = new Map(a.stats.map((row) => [key(row), row]));
  let statsEqual = a.stats.length === b.stats.length;
  for (const k of [...new Set([...aRows.keys(), ...bRows.keys()])].sort()) {
    const ra = aRows.get(k);
    const rb = bRows.get(k);
    if (ra === undefined || rb === undefined || JSON.stringify(ra) !== JSON.stringify(rb)) statsEqual = false;
    const zero = {
      attempted: 0,
      resolved: 0,
      externalSkipped: 0,
      noInProjectDef: 0,
      unresolvable: 0,
      coreAmbiguous: 0,
      ambiguousFanout: 0,
    } as ResolveRunStatsRow;
    const x = ra ?? zero;
    const y = rb ?? zero;
    const [language, kind] = k.split("/");
    out.push(
      `${language.padEnd(10)} ${kind.padEnd(11)} ${`${x.attempted}→${y.attempted}`.padStart(9)}  ` +
        `${`${x.resolved}→${y.resolved}`.padStart(13)}  ${`${x.externalSkipped}→${y.externalSkipped}`.padStart(12)}  ` +
        `${`${x.noInProjectDef}→${y.noInProjectDef}`.padStart(10)}  ${`${residualOf(x)}→${residualOf(y)}`.padStart(13)}  ` +
        `${rateOf(x).toFixed(4)}→${rateOf(y).toFixed(4)}`,
    );
  }

  const aSet = new Set(a.edges);
  const bSet = new Set(b.edges);
  const onlyA = a.edges.filter((line) => !bSet.has(line));
  const onlyB = b.edges.filter((line) => !aSet.has(line));
  out.push("", `rows only in A: ${onlyA.length} · only in B: ${onlyB.length}`);

  const aSites = targetsByCallSite(a.edges);
  const bSites = targetsByCallSite(b.edges);
  const moved = [...new Set([...aSites.keys(), ...bSites.keys()])]
    .filter((site) => JSON.stringify(aSites.get(site) ?? []) !== JSON.stringify(bSites.get(site) ?? []))
    .sort();
  out.push(`call sites whose method targets differ: ${moved.length}`);
  for (const site of moved.slice(0, limit)) {
    out.push(`  ${site}`, `    A: ${(aSites.get(site) ?? []).join(" | ") || "—"}`);
    out.push(`    B: ${(bSites.get(site) ?? []).join(" | ") || "—"}`);
  }
  const otherOnlyA = onlyA.filter((line) => !line.startsWith("M\t"));
  const otherOnlyB = onlyB.filter((line) => !line.startsWith("M\t"));
  for (const line of otherOnlyA.slice(0, limit)) out.push(`  -${line}`);
  for (const line of otherOnlyB.slice(0, limit)) out.push(`  +${line}`);

  // Per-file bucket rows — absent from snapshots taken before the field existed.
  const aFiles = new Set(a.fileStats ?? []);
  const bFiles = new Set(b.fileStats ?? []);
  const fileRowsOnlyA = (a.fileStats ?? []).filter((line) => !bFiles.has(line));
  const fileRowsOnlyB = (b.fileStats ?? []).filter((line) => !aFiles.has(line));
  out.push("", `per-file bucket rows only in A: ${fileRowsOnlyA.length} · only in B: ${fileRowsOnlyB.length}`);
  for (const line of fileRowsOnlyA.slice(0, limit)) out.push(`  -${line}`);
  for (const line of fileRowsOnlyB.slice(0, limit)) out.push(`  +${line}`);

  const identical =
    onlyA.length === 0 && onlyB.length === 0 && statsEqual && fileRowsOnlyA.length === 0 && fileRowsOnlyB.length === 0;
  out.push("", identical ? "IDENTICAL" : "DIFFERENT");
  process.stdout.write(`${out.join("\n")}\n`);
}

async function main(): Promise<void> {
  const [mode, ...argv] = process.argv.slice(2);
  if (mode === "snapshot") {
    const root = argValue(argv, "--root");
    const out = argValue(argv, "--out");
    const explain = argValue(argv, "--explain");
    if (root === null || (out === null && explain === null)) {
      throw new Error("snapshot needs --root and one of --out / --explain");
    }
    await snapshot({
      root,
      out,
      typescriptPackage: argValue(argv, "--typescript"),
      ecmascriptOnly: argv.includes("--ecmascript-only"),
      explain,
    });
    // A whole-corpus run leaves handles alive (measured on taxdome: the snapshot
    // was written and the process never exited), and nothing is pending once
    // the file is on disk.
    process.exit(0);
  }
  if (mode === "diff" && argv.length >= 2) {
    diff(argv[0], argv[1], Number(argValue(argv, "--limit") ?? "40"));
    return;
  }
  throw new Error(
    "usage: snapshot --root <repo> (--out <file> | --explain <relPath>) [--typescript <dir>] [--ecmascript-only] | diff <a> <b>",
  );
}

void main();
