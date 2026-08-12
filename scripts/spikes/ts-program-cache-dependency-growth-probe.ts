/**
 * Does the coverage-keyed TSProgramCache stay bounded against a REAL-shaped
 * `node_modules`? (bd tea-rags-mcp-4m2vb regression, 2026-08-12)
 *
 * The fixture that validated bd 4m2vb had NO `node_modules` and 10-25-line
 * files. The first live run against a dependency-laden React codebase climbed
 * past 3.9GB RSS with no plateau. This probe reproduces that shape offline:
 *
 * - A synthetic `node_modules` whose packages form a DEEP re-export chain
 *   (`uikit` → `@fixture/base` → `@fixture/prims`), each package a single-file
 *   re-export chain internally, so importing any entry pulls the package's
 *   whole declaration surface — the way real react/@mui/@types graphs behave.
 * - An ambient `globals.d.ts` reached by triple-slash reference, and a
 *   near-circular type reference (`@fixture/prims` imports a type back from
 *   `uikit`).
 * - Project sources arranged in DISJOINT islands, each importing `uikit`, so
 *   multiple entries build Programs that all pull the same dependency closure.
 *
 * Run under a hard heap ceiling — a probe of a memory bug must OOM itself,
 * never the host:
 *
 *   NODE_OPTIONS="--max-old-space-size=1024 --expose-gc" npx tsx \
 *     scripts/spikes/ts-program-cache-dependency-growth-probe.ts \
 *     [--islands N] [--features N] [--dep-modules N] [--no-deps] \
 *     [--no-checker] [--max-dep-files N] [--entries N]
 *
 * What it measures, per build and per 20-entry sample:
 * - Program composition: project vs node_modules vs default-lib file counts
 *   and text bytes — the retained-size proxy a fix would bound.
 * - Builds vs coverage hits (the bd 4m2vb win that must survive a fix).
 * - `heapUsed` after an explicit gc, and how many built Programs are still
 *   ALIVE (WeakRef), which separates "the LRU dropped it" from "it is pinned".
 * - Shared parse-cache churn: `parsedDependencyFileCount` against the
 *   dependency surface, to show whether bd 8qf86's bound frees anything while
 *   Programs pin the ASTs.
 */

import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import ts from "typescript";

import { loadTsConfig } from "../../src/core/domains/language/typescript/resolver/ts-config-loader.js";
import { TSProgramCache } from "../../src/core/domains/language/typescript/resolver/ts-program-cache.js";

// realpath'd lazily after generation: `TSProgramCache.repoRoot` documents a
// realpath-normalized root, and macOS's `/tmp` is a symlink into `/private` —
// exactly the mismatch that would silently blind an in-root membership test.
const FIXTURE_ROOT = "/tmp/tea-rags-ts-dependency-fixture";

interface ProbeShape {
  /** Disjoint project islands — each forces its own Program build. */
  islands: number;
  /** Feature files per island. */
  featuresPerIsland: number;
  /** Declaration modules per dependency package. */
  depModulesPerPackage: number;
  /** Interfaces + functions per declaration module. */
  depDeclsPerModule: number;
  /** Write the dependency tree and import from it. */
  withDeps: boolean;
  /** Exercise the checker per acquired file, as the resolver strategies do. */
  withChecker: boolean;
  /** Override for TSProgramCacheOptions.maxDependencyFiles. */
  maxDependencyFiles: number | undefined;
  /** Override for TSProgramCacheOptions.maxRetainedSourceTextBytes. */
  maxRetainedSourceTextBytes: number | undefined;
  /** Cap on entries swept, for quick runs. */
  entryLimit: number | null;
}

const DEFAULT_PROBE_SHAPE: ProbeShape = {
  islands: 12,
  featuresPerIsland: 24,
  depModulesPerPackage: 260,
  depDeclsPerModule: 12,
  withDeps: true,
  withChecker: true,
  maxDependencyFiles: undefined,
  maxRetainedSourceTextBytes: undefined,
  entryLimit: null,
};

function write(relPath: string, content: string): void {
  const abs = join(FIXTURE_ROOT, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

/**
 * One declaration module of a package: `declsPerModule` generic interfaces and
 * factory signatures, re-exporting the NEXT module so the package is one deep
 * chain — entry pulls everything, the shape barrels give real packages.
 */
function depModule(pkgVar: string, index: number, count: number, declsPerModule: number, tail: string): string {
  const lines: string[] = [];
  if (index + 1 < count) lines.push(`export * from "./m${index + 1}.js";`);
  else if (tail.length > 0) lines.push(tail);
  for (let d = 0; d < declsPerModule; d++) {
    const name = `${pkgVar}M${index}T${d}`;
    lines.push(
      `export interface ${name}<T> {`,
      `  readonly id: string;`,
      `  readonly payload: T;`,
      `  map<U>(fn: (value: T) => U): ${name}<U>;`,
      `  merge(other: ${name}<T>): ${name}<T>;`,
      `}`,
      `export declare function make${name}<T>(seed: T): ${name}<T>;`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function writeDepPackage(name: string, pkgVar: string, shape: ProbeShape, tail: string): void {
  write(`node_modules/${name}/package.json`, `{ "name": "${name}", "types": "index.d.ts" }\n`);
  write(`node_modules/${name}/index.d.ts`, `export * from "./lib/m0.js";\n`);
  for (let m = 0; m < shape.depModulesPerPackage; m++) {
    write(
      `node_modules/${name}/lib/m${m}.d.ts`,
      depModule(
        pkgVar,
        m,
        shape.depModulesPerPackage,
        shape.depDeclsPerModule,
        m + 1 < shape.depModulesPerPackage ? "" : tail,
      ),
    );
  }
}

/** The three-package chain, ambient globals, and the near-circular back-edge. */
function writeNodeModules(shape: ProbeShape): void {
  // uikit → @fixture/base → @fixture/prims; prims closes the cycle with a
  // type-only import back from uikit.
  writeDepPackage(
    "@fixture/prims",
    "Prims",
    shape,
    `import type { UiHandle } from "uikit";\nexport declare function fromUi(handle: UiHandle<unknown>): void;`,
  );
  writeDepPackage("@fixture/base", "Base", shape, `export * from "@fixture/prims";`);
  writeDepPackage("uikit", "Ui", shape, `export * from "@fixture/base";`);
  write(
    "node_modules/uikit/globals.d.ts",
    [
      "declare global {",
      "  interface UikitGlobalRegistry {",
      "    readonly entries: ReadonlyArray<string>;",
      "  }",
      "}",
      "export {};",
      "",
    ].join("\n"),
  );
  write(
    "node_modules/uikit/index.d.ts",
    [
      `/// <reference path="./globals.d.ts" />`,
      `export * from "./lib/m0.js";`,
      `export interface UiHandle<T> {`,
      `  readonly current: T;`,
      `  render(): string;`,
      `}`,
      `export declare function createUi<T>(factory: () => T): UiHandle<T>;`,
      "",
    ].join("\n"),
  );
}

/**
 * One island: every file imports the island BARREL (the React-app shape that
 * made bd 4m2vb's Programs balloon to the whole corpus — a barrel import drags
 * every sibling in), plus `uikit` the way every real component imports react.
 * Islands never import each other, so each island's first entry misses
 * coverage and builds; every later entry of the island should be a coverage
 * hit, reproducing the bd 4m2vb reuse pattern per island.
 */
function writeIsland(index: number, shape: ProbeShape): void {
  const island = `i${String(index).padStart(2, "0")}`;
  for (let f = 0; f < shape.featuresPerIsland; f++) {
    const dep = shape.withDeps ? `import { createUi } from "uikit";\n` : "";
    const use = shape.withDeps
      ? `  const handle = createUi(() => ({ id, at: Date.now() }));\n  void handle.current;\n`
      : "";
    // The barrel self-import cycle is the ordinary React feature-directory
    // shape; TypeScript resolves it without complaint.
    const neighbour = f > 0 ? `import { fn${island}x0 } from "./index.js";\n` : "";
    const call = f > 0 ? `  void fn${island}x0(id);\n` : "";
    write(
      `src/${island}/f${f}.ts`,
      [
        dep,
        neighbour,
        `export function fn${island}x${f}(id: string): string {`,
        use,
        call,
        `  return id;`,
        `}`,
        "",
      ].join(""),
    );
  }
  write(
    `src/${island}/index.ts`,
    `${Array.from({ length: shape.featuresPerIsland }, (_, f) => `export * from "./f${f}.js";`).join("\n")}\n`,
  );
}

function generate(shape: ProbeShape): string[] {
  rmSync(FIXTURE_ROOT, { recursive: true, force: true });
  mkdirSync(FIXTURE_ROOT, { recursive: true });
  if (shape.withDeps) writeNodeModules(shape);
  for (let i = 0; i < shape.islands; i++) writeIsland(i, shape);
  write(
    "tsconfig.json",
    `${JSON.stringify(
      { compilerOptions: { baseUrl: ".", module: "esnext", moduleResolution: "bundler", target: "es2022" } },
      null,
      2,
    )}\n`,
  );
  const files: string[] = [];
  for (let i = 0; i < shape.islands; i++) {
    const island = `i${String(i).padStart(2, "0")}`;
    for (let f = 0; f < shape.featuresPerIsland; f++) files.push(`src/${island}/f${f}.ts`);
    files.push(`src/${island}/index.ts`);
  }
  return files;
}

interface ProgramFootprint {
  projectFiles: number;
  dependencyFiles: number;
  libFiles: number;
  textBytes: number;
}

function footprintOf(program: ts.Program): ProgramFootprint {
  let projectFiles = 0;
  let dependencyFiles = 0;
  let libFiles = 0;
  let textBytes = 0;
  for (const file of program.getSourceFiles()) {
    textBytes += file.text.length;
    if (file.fileName.includes("/typescript/lib/")) libFiles += 1;
    else if (file.fileName.includes("/node_modules/")) dependencyFiles += 1;
    else projectFiles += 1;
  }
  return { projectFiles, dependencyFiles, libFiles, textBytes };
}

/** The checker work the resolver strategies actually do per call site. */
function exerciseChecker(handle: { checker: ts.TypeChecker; sourceFile: ts.SourceFile }): number {
  let visited = 0;
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const type = handle.checker.getTypeAtLocation(node.expression);
      void handle.checker.typeToString(type);
      void handle.checker.getSymbolAtLocation(node.expression);
      visited += 1;
    }
    ts.forEachChild(node, walk);
  };
  walk(handle.sourceFile);
  return visited;
}

function gcNow(): void {
  const { gc } = globalThis as { gc?: () => void };
  if (gc) gc();
}

function mb(bytes: number): number {
  return +(bytes / 1024 / 1024).toFixed(1);
}

function parseArgs(argv: string[]): ProbeShape {
  const shape = { ...DEFAULT_PROBE_SHAPE };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--no-deps") shape.withDeps = false;
    else if (arg === "--no-checker") shape.withChecker = false;
    else if (arg === "--islands") shape.islands = Number(argv[++i]);
    else if (arg === "--features") shape.featuresPerIsland = Number(argv[++i]);
    else if (arg === "--dep-modules") shape.depModulesPerPackage = Number(argv[++i]);
    else if (arg === "--max-dep-files") shape.maxDependencyFiles = Number(argv[++i]);
    else if (arg === "--retained-budget") shape.maxRetainedSourceTextBytes = Number(argv[++i]);
    else if (arg === "--entries") shape.entryLimit = Number(argv[++i]);
  }
  return shape;
}

/**
 * The sweep is async on purpose: a WeakRef target dereferenced (or created)
 * inside a synchronous job is kept alive until that job ends, so a synchronous
 * loop would report every Program ever built as "alive" no matter what the
 * cache dropped. Yielding to the event loop between samples ends the job and
 * lets the gc actually collect what nothing pins.
 */
async function run(shape: ProbeShape): Promise<void> {
  const files = generate(shape);
  const entries = shape.entryLimit === null ? files : files.slice(0, shape.entryLimit);
  const repoRoot = realpathSync(FIXTURE_ROOT);
  const tsOptions = loadTsConfig(repoRoot);
  const cache = new TSProgramCache({
    repoRoot,
    tsOptions,
    ...(shape.maxDependencyFiles === undefined ? {} : { maxDependencyFiles: shape.maxDependencyFiles }),
    ...(shape.maxRetainedSourceTextBytes === undefined
      ? {}
      : { maxRetainedSourceTextBytes: shape.maxRetainedSourceTextBytes }),
  });

  const seen = new WeakSet<ts.Program>();
  const alive: WeakRef<ts.Program>[] = [];
  const builds: ProgramFootprint[] = [];
  let coverageHits = 0;
  let checkerCalls = 0;

  console.log(JSON.stringify({ probe: "start", corpusFiles: files.length, entries: entries.length, shape }));

  for (let index = 0; index < entries.length; index++) {
    const { [index]: relPath } = entries;
    const handle = cache.acquire(relPath as never);
    if (!handle) continue;
    if (!seen.has(handle.program)) {
      seen.add(handle.program);
      alive.push(new WeakRef(handle.program));
      const footprint = footprintOf(handle.program);
      builds.push(footprint);
      console.log(JSON.stringify({ probe: "build", entry: relPath, ...footprint, textMB: mb(footprint.textBytes) }));
    } else {
      coverageHits += 1;
    }
    if (shape.withChecker) checkerCalls += exerciseChecker(handle);

    if ((index + 1) % 20 === 0 || index + 1 === entries.length) {
      // End the synchronous job before sampling, so WeakRef targets are
      // collectable; then gc and read what is genuinely still alive.
      await new Promise((resolveTurn) => setImmediate(resolveTurn));
      gcNow();
      await new Promise((resolveTurn) => setImmediate(resolveTurn));
      gcNow();
      const usage = process.memoryUsage();
      console.log(
        JSON.stringify({
          probe: "sample",
          entriesProcessed: index + 1,
          builds: builds.length,
          coverageHits,
          checkerCalls,
          retainedPrograms: cache.size,
          alivePrograms: alive.filter((ref) => ref.deref() !== undefined).length,
          parsedProjectFiles: cache.parsedProjectFileCount,
          parsedDependencyFiles: cache.parsedDependencyFileCount,
          heapUsedMB: mb(usage.heapUsed),
          rssMB: mb(usage.rss),
        }),
      );
    }
  }

  const totalRetainedText = builds.reduce((sum, b) => sum + b.textBytes, 0);
  console.log(
    JSON.stringify({
      probe: "done",
      builds: builds.length,
      coverageHits,
      medianBuildTextMB: mb(builds.map((b) => b.textBytes).sort((a, b) => a - b)[Math.floor(builds.length / 2)] ?? 0),
      totalBuiltTextMB: mb(totalRetainedText),
    }),
  );
}

await run(parseArgs(process.argv.slice(2)));
