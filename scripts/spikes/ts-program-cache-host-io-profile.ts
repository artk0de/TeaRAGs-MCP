/**
 * Profile the filesystem probing `TSProgramCache`'s shared `ts.CompilerHost`
 * performs, per distinct path and in total (bd tea-rags-mcp-e6yad).
 *
 * `buildHost` memoizes `getSourceFile` and nothing else, so `fileExists`,
 * `directoryExists` and `realpath` fall through to `ts.sys` — real
 * `fs.statSync` / `fs.realpathSync` calls. TypeScript's module resolution runs
 * those three BEFORE `getSourceFile`, once per candidate path it tries
 * (`.ts`, `.tsx`, `.d.ts`, `/index.ts`, each `node_modules` ancestor), and it
 * re-runs the whole search on every `ts.createProgram` — of which this cache
 * makes one per entry file.
 *
 * So the question is not whether the probing repeats (it must) but by how much,
 * and over how many DISTINCT paths — the first number sizes the win from
 * memoizing, the second sizes what memoizing would retain. Both come off the
 * same run, because a redundancy factor without the distinct-path count cannot
 * tell a cheap cache from an unbounded one.
 *
 * The workload mirrors production, and mirrors the sibling scan profile: ONE
 * cache, `acquire` once per source file in directory order, which is what
 * `CallEdgeResolutionRunner` does as it walks files.
 *
 * Usage:
 *   npx tsx scripts/spikes/ts-program-cache-host-io-profile.ts [options]
 *
 *   --repo-root <dir>  project root holding tsconfig.json (default: cwd)
 *   --target <dir>     directory to walk, relative to repo root (default: src)
 *   --limit <n>        stop after N files (smoke runs)
 *   --json <path>      write the tally as JSON
 */

import { readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve as resolvePath, sep } from "node:path";

import ts from "typescript";

import type { RelPath } from "../../src/core/contracts/types/codegraph.js";
import { loadTsConfig } from "../../src/core/domains/language/typescript/resolver/ts-config-loader.js";
import { TSProgramCache } from "../../src/core/domains/language/typescript/resolver/ts-program-cache.js";

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];
const SKIP_DIRS = new Set(["node_modules", "build", "dist", ".git", "coverage"]);

function collectSourceFiles(repoRoot: string, targetDir: string): RelPath[] {
  const out: RelPath[] = [];
  const walk = (absolute: string): void => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(join(absolute, entry.name));
        continue;
      }
      if (!SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) continue;
      if (entry.name.endsWith(".d.ts")) continue;
      const rel = relative(repoRoot, join(absolute, entry.name));
      out.push(sep === "/" ? rel : rel.split(sep).join("/"));
    }
  };
  walk(resolvePath(repoRoot, targetDir));
  return out.sort();
}

interface ProbeTally {
  calls: number;
  distinct: number;
  /** calls / distinct — 1.0 means a memo would save nothing. */
  redundancy: number;
  /** Sum of key lengths, the floor on what memoizing these paths retains. */
  keyBytes: number;
}

interface HostIoProfile {
  files: number;
  acquired: number;
  totalWallMs: number;
  fileExists: ProbeTally;
  directoryExists: ProbeTally;
  realpath: ProbeTally;
  totalCalls: number;
  totalDistinct: number;
  totalKeyBytes: number;
}

/** Counting wrapper around one `ts.sys` method, keyed by its path argument. */
class ProbeCounter {
  calls = 0;
  readonly seen = new Set<string>();

  record(path: string): void {
    this.calls++;
    this.seen.add(path);
  }

  tally(): ProbeTally {
    let keyBytes = 0;
    for (const key of this.seen) keyBytes += Buffer.byteLength(key, "utf8");
    return {
      calls: this.calls,
      distinct: this.seen.size,
      redundancy: this.seen.size === 0 ? 0 : this.calls / this.seen.size,
      keyBytes,
    };
  }
}

function profile(repoRoot: string, targetDir: string, limit: number): HostIoProfile {
  const fileExists = new ProbeCounter();
  const directoryExists = new ProbeCounter();
  const realpath = new ProbeCounter();

  // `ts.createCompilerHost` exposes `fileExists`/`directoryExists`/`realpath`
  // as `(p) => system.fileExists(p)` — the lookup on `ts.sys` happens per call,
  // so wrapping the system object counts exactly the calls the host forwards.
  const originalFileExists = ts.sys.fileExists.bind(ts.sys);
  const originalDirectoryExists = ts.sys.directoryExists.bind(ts.sys);
  const originalRealpath = ts.sys.realpath?.bind(ts.sys);
  ts.sys.fileExists = (path: string): boolean => {
    fileExists.record(path);
    return originalFileExists(path);
  };
  ts.sys.directoryExists = (path: string): boolean => {
    directoryExists.record(path);
    return originalDirectoryExists(path);
  };
  if (originalRealpath) {
    ts.sys.realpath = (path: string): string => {
      realpath.record(path);
      return originalRealpath(path);
    };
  }

  try {
    const tsOptions = loadTsConfig(repoRoot);
    // Same construction TSCallResolver uses: default bounds, default probe.
    const cache = new TSProgramCache({ repoRoot, tsOptions });
    const files = collectSourceFiles(repoRoot, targetDir).slice(0, limit);
    let acquired = 0;

    const started = process.hrtime.bigint();
    for (const relPath of files) {
      if (cache.acquire(relPath) !== null) acquired++;
    }
    const totalNs = process.hrtime.bigint() - started;

    const tallies = {
      fileExists: fileExists.tally(),
      directoryExists: directoryExists.tally(),
      realpath: realpath.tally(),
    };
    return {
      files: files.length,
      acquired,
      totalWallMs: Number(totalNs) / 1e6,
      ...tallies,
      totalCalls: tallies.fileExists.calls + tallies.directoryExists.calls + tallies.realpath.calls,
      totalDistinct: tallies.fileExists.distinct + tallies.directoryExists.distinct + tallies.realpath.distinct,
      totalKeyBytes: tallies.fileExists.keyBytes + tallies.directoryExists.keyBytes + tallies.realpath.keyBytes,
    };
  } finally {
    ts.sys.fileExists = originalFileExists;
    ts.sys.directoryExists = originalDirectoryExists;
    if (originalRealpath) ts.sys.realpath = originalRealpath;
  }
}

function parseArgs(argv: readonly string[]): { repoRoot: string; target: string; limit: number; json?: string } {
  let repoRoot = process.cwd();
  let target = "src";
  let limit = Number.POSITIVE_INFINITY;
  let json: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const next = argv[i + 1];
    if (argv[i] === "--repo-root" && next) repoRoot = resolvePath(next);
    else if (argv[i] === "--target" && next) target = next;
    else if (argv[i] === "--limit" && next) limit = Number(next);
    else if (argv[i] === "--json" && next) json = next;
  }
  return { repoRoot, target, limit, ...(json !== undefined && { json }) };
}

function formatTally(name: string, tally: ProbeTally): string {
  return (
    `${name.padEnd(16)} ${String(tally.calls).padStart(9)} calls  ` +
    `${String(tally.distinct).padStart(8)} distinct  ` +
    `${tally.redundancy.toFixed(1).padStart(7)}x  ` +
    `${(tally.keyBytes / 1024).toFixed(0).padStart(6)} KiB of keys`
  );
}

function main(): void {
  const { repoRoot, target, limit, json } = parseArgs(process.argv.slice(2));
  const result = profile(repoRoot, target, limit);

  const lines = [
    `repo root            ${repoRoot}`,
    `target               ${target}`,
    `files acquired       ${result.acquired}/${result.files}`,
    `total acquire wall   ${result.totalWallMs.toFixed(1)} ms`,
    ``,
    formatTally("fileExists", result.fileExists),
    formatTally("directoryExists", result.directoryExists),
    formatTally("realpath", result.realpath),
    ``,
    `total                ${result.totalCalls} calls over ${result.totalDistinct} distinct paths`,
    `memo key floor       ${(result.totalKeyBytes / 1024 / 1024).toFixed(2)} MiB`,
  ];
  process.stdout.write(`${lines.join("\n")}\n`);

  if (json !== undefined) writeFileSync(json, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

main();
