/**
 * Profile the parse-cache overflow scan in `TSProgramCache` (bd tea-rags-mcp-ajvnq).
 *
 * `evictParsedOverflow` runs on every `getSourceFile` MISS, and it reads
 * `parsedProjectFileCount`, which walks the entire shared parse map calling
 * `isProjectSourceFile` (a `node:path.relative` plus segment checks) per entry.
 * Cost per parse is therefore O(map size), and after bd tea-rags-mcp-qb2s3 the
 * map retains the whole parsed dependency set rather than staying near the
 * project-source bound — so the scan grows with `node_modules`, on the hot path.
 *
 * The question this answers is NOT "is the scan O(n)" (it is, by inspection)
 * but "does it cost anything next to `ts.createProgram`". So both are timed
 * against the same run, with the timer overhead the instrumentation itself adds
 * measured and reported rather than assumed away.
 *
 * The workload mirrors production: ONE cache, `acquire` once per source file,
 * in directory order — which is what `CallEdgeResolutionRunner` does as it
 * walks files. The cache is built exactly as `TSCallResolver` builds its own
 * (default bounds), so the parse map grows the way it grows in a real run.
 *
 * Usage:
 *   npx tsx scripts/spikes/ts-program-cache-scan-profile.ts [options]
 *
 *   --repo-root <dir>  project root holding tsconfig.json (default: cwd)
 *   --target <dir>     directory to walk, relative to repo root (default: src)
 *   --limit <n>        stop after N files (smoke runs)
 *   --json <path>      write the tally as JSON
 */

import { readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve as resolvePath, sep } from "node:path";

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

/**
 * Cost of one `process.hrtime.bigint()` PAIR, measured on this machine right
 * now. Every wrapped call pays it, so the scan total is overstated by exactly
 * `calls * overhead` and the correction belongs in the output, not in a
 * caveat sentence.
 */
function calibrateTimerOverhead(samples: number): number {
  const started = process.hrtime.bigint();
  for (let i = 0; i < samples; i++) {
    const a = process.hrtime.bigint();
    const b = process.hrtime.bigint();
    if (b < a) throw new Error("clock went backwards");
  }
  const elapsed = process.hrtime.bigint() - started;
  return Number(elapsed) / samples;
}

interface ScanProfile {
  files: number;
  acquired: number;
  totalWallMs: number;
  scanWallMs: number;
  scanCalls: number;
  scanSharePct: number;
  timerOverheadMs: number;
  correctedScanWallMs: number;
  correctedScanSharePct: number;
  avgScanUs: number;
  parsedTotal: number;
  parsedProject: number;
  parsedDependency: number;
}

type PrivateCacheShape = {
  evictParsedOverflow: () => void;
  sourceFiles: Map<string, unknown>;
};

function profile(repoRoot: string, targetDir: string, limit: number): ScanProfile {
  const tsOptions = loadTsConfig(repoRoot);
  // Same construction TSCallResolver uses: default bounds, default probe.
  const cache = new TSProgramCache({ repoRoot, tsOptions });

  const proto = TSProgramCache.prototype as unknown as PrivateCacheShape;
  const original = proto.evictParsedOverflow;
  let scanNs = 0n;
  let scanCalls = 0;
  proto.evictParsedOverflow = function wrapped(this: PrivateCacheShape): void {
    const started = process.hrtime.bigint();
    original.call(this);
    scanNs += process.hrtime.bigint() - started;
    scanCalls++;
  };

  const files = collectSourceFiles(repoRoot, targetDir).slice(0, limit);
  let acquired = 0;

  const runStarted = process.hrtime.bigint();
  for (const relPath of files) {
    if (cache.acquire(relPath) !== null) acquired++;
  }
  const totalNs = process.hrtime.bigint() - runStarted;

  proto.evictParsedOverflow = original;

  const perTimerPairNs = calibrateTimerOverhead(200_000);
  const timerOverheadNs = perTimerPairNs * scanCalls;
  const correctedScanNs = Math.max(0, Number(scanNs) - timerOverheadNs);

  const parsedTotal = (cache as unknown as PrivateCacheShape).sourceFiles.size;
  const parsedProject = cache.parsedProjectFileCount;

  return {
    files: files.length,
    acquired,
    totalWallMs: Number(totalNs) / 1e6,
    scanWallMs: Number(scanNs) / 1e6,
    scanCalls,
    scanSharePct: (Number(scanNs) / Number(totalNs)) * 100,
    timerOverheadMs: timerOverheadNs / 1e6,
    correctedScanWallMs: correctedScanNs / 1e6,
    correctedScanSharePct: (correctedScanNs / Number(totalNs)) * 100,
    avgScanUs: scanCalls === 0 ? 0 : correctedScanNs / scanCalls / 1000,
    parsedTotal,
    parsedProject,
    parsedDependency: parsedTotal - parsedProject,
  };
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

function main(): void {
  const { repoRoot, target, limit, json } = parseArgs(process.argv.slice(2));
  const result = profile(repoRoot, target, limit);

  const lines = [
    `repo root            ${repoRoot}`,
    `target               ${target}`,
    `files acquired       ${result.acquired}/${result.files}`,
    ``,
    `total acquire wall   ${result.totalWallMs.toFixed(1)} ms`,
    `scan wall (raw)      ${result.scanWallMs.toFixed(1)} ms  (${result.scanSharePct.toFixed(2)}%)`,
    `  timer overhead     ${result.timerOverheadMs.toFixed(1)} ms over ${result.scanCalls} calls`,
    `scan wall (corrected)${result.correctedScanWallMs.toFixed(1)} ms  (${result.correctedScanSharePct.toFixed(2)}%)`,
    `avg per scan call    ${result.avgScanUs.toFixed(2)} us`,
    ``,
    `parse map total      ${result.parsedTotal}`,
    `  project sources    ${result.parsedProject}`,
    `  dependencies+lib   ${result.parsedDependency}`,
  ];
  process.stdout.write(`${lines.join("\n")}\n`);

  if (json !== undefined) writeFileSync(json, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

main();
