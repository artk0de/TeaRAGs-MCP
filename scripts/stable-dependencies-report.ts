/**
 * stable-dependencies-report.ts (bd tea-rags-mcp-thc7s)
 *
 * Premise validation for the boundary-diagnostics line (epic r8hme): run the
 * Stable Dependencies Principle detector against a codegraph DuckDB file and
 * print what it flags, so an architect can judge whether the violations are
 * real defects or noise BEFORE the remaining detectors are built.
 *
 * Reads a COPY of the graph file, never the live one. The live file belongs to
 * the machine-wide codegraph daemon, which holds its write lock; opening it
 * from here would either fail on the lock or, from a build other than the
 * daemon's, trigger the build handshake that drains the daemon other sessions
 * depend on. So: copy `<data dir>/codegraph/<physical collection>.duckdb` (and
 * its `.wal`, if any) somewhere else and point `--db` at the copy — the script
 * refuses a path under the live codegraph directory. Resolve the PHYSICAL
 * versioned name (`code_x_v62`), not the alias; the alias names no file.
 *
 * Usage:
 *   npx tsx scripts/stable-dependencies-report.ts --db <copy.duckdb> \
 *     [--tolerance 0.2] [--min-connection-count 5] [--top 20] [--json out.json]
 *
 * `--tolerance` and `--min-connection-count` default to the detector's own
 * defaults (`DEFAULT_SDP_TOLERANCE`, `DEFAULT_SDP_MIN_CONNECTION_COUNT`); leave
 * them off to measure what the shipped detector reports.
 */

import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

import { DuckDbGraphClient } from "../src/core/adapters/duckdb/client.js";
import type { FileDependencyGraph } from "../src/core/contracts/types/codegraph.js";
import {
  detectStableDependencyViolations,
  NO_SYMBOL_ENDPOINT_REASON,
  type DependencyDirectoryRelation,
  type NoSymbolEndpointFile,
  type StableDependenciesOptions,
  type StableDependenciesReport,
  type StableDependencyViolation,
} from "../src/core/domains/trajectory/codegraph/symbols/boundary-diagnostics/index.js";

export interface StableDependenciesReportArgs {
  dbPath: string;
  tolerance?: number;
  minConnectionCount?: number;
  top: number;
  jsonOut?: string;
}

const DEFAULT_TOP = 20;

const DIRECTORY_RELATIONS: readonly DependencyDirectoryRelation[] = ["same", "descendant", "ancestor", "disjoint"];

export function parseArgs(argv: readonly string[]): StableDependenciesReportArgs {
  let dbPath: string | undefined;
  const args: Omit<StableDependenciesReportArgs, "dbPath"> = { top: DEFAULT_TOP };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--db":
        dbPath = requireValue(flag, value);
        break;
      case "--tolerance": {
        const tolerance = Number(requireValue(flag, value));
        if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance >= 1) {
          throw new Error(`--tolerance must be a number in [0, 1), got "${value}"`);
        }
        args.tolerance = tolerance;
        break;
      }
      case "--min-connection-count":
        args.minConnectionCount = nonNegativeInteger(flag, value);
        break;
      case "--top": {
        const top = nonNegativeInteger(flag, value);
        if (top === 0) throw new Error(`--top must be at least 1, got "${value}"`);
        args.top = top;
        break;
      }
      case "--json":
        args.jsonOut = requireValue(flag, value);
        break;
      default:
        throw new Error(`unknown argument "${flag}"`);
    }
    i++;
  }
  if (dbPath === undefined) throw new Error("--db <copy of a codegraph .duckdb file> is required");
  return { dbPath, ...args };
}

function requireValue(flag: string, value: string | undefined): string {
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
  return value;
}

function nonNegativeInteger(flag: string, value: string | undefined): number {
  const n = Number(requireValue(flag, value));
  if (!Number.isInteger(n) || n < 0) throw new Error(`${flag} must be a non-negative integer, got "${value}"`);
  return n;
}

/** Same rule every CLI command uses (`resolveDataDir` in `src/cli/commands/*`). */
function resolveDataDir(): string {
  return process.env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags");
}

/** Refuse a graph file under the live codegraph directory — see the header. */
export function assertNotLiveCodegraphDatabase(dbPath: string, dataDir: string): void {
  const liveDir = resolve(dataDir, "codegraph");
  const target = resolve(dbPath);
  if (target === liveDir || target.startsWith(`${liveDir}${sep}`)) {
    throw new Error(
      `${target} is a live codegraph database (owned by the codegraph daemon). ` +
        "Copy the .duckdb (and its .wal) elsewhere and pass the copy to --db.",
    );
  }
}

/** Open the graph file READ_ONLY, read the whole dependency graph, judge it. */
export async function collectStableDependencies(
  dbPath: string,
  options: StableDependenciesOptions,
): Promise<{ graph: FileDependencyGraph; report: StableDependenciesReport }> {
  if (!existsSync(dbPath)) throw new Error(`no such graph file: ${dbPath}`);
  const client = new DuckDbGraphClient({ path: dbPath, accessMode: "READ_ONLY" });
  await client.init();
  let graph: FileDependencyGraph;
  try {
    graph = await client.readFileDependencyGraph();
  } finally {
    await client.close();
  }
  return { graph, report: detectStableDependencyViolations(graph, options) };
}

function countBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(keyOf(item), (counts.get(keyOf(item)) ?? 0) + 1);
  return counts;
}

function languageIndex(graph: FileDependencyGraph): Map<string, string> {
  return new Map(graph.files.map((f) => [f.relPath, f.language]));
}

function formatViolation(v: StableDependencyViolation): string {
  const instabilities = `${v.sourceInstability.toFixed(3)} → ${v.targetInstability.toFixed(3)}`;
  const support = `${v.sourceConnectionCount}/${v.targetConnectionCount}`;
  return (
    `  ${v.instabilityDelta.toFixed(3)}  ${instabilities.padEnd(15)}  ${support.padStart(9)}  ` +
    `${v.callWeight.toFixed(2).padStart(7)}  ${v.directoryRelation.padEnd(10)}  ` +
    `${v.sourceRelPath} -> ${v.targetRelPath}`
  );
}

const VIOLATION_HEADER = `  delta  I(src) → I(tgt)    cc src/tgt    calls  relation    source -> target`;

export function renderStableDependenciesReport(
  report: StableDependenciesReport,
  graph: FileDependencyGraph,
  top: number,
): string {
  const { summary, violations } = report;
  const languages = languageIndex(graph);
  const lines: string[] = [
    `Stable Dependencies Principle — tolerance ${summary.tolerance} · minConnectionCount ${summary.minConnectionCount}`,
    "",
    `  files               ${graph.files.length}`,
    `  edges read          ${summary.edgeCount}`,
    `    self-edges          ${summary.excluded.selfEdges}`,
    `    unwalked endpoint   ${summary.excluded.unwalkedEndpoints}`,
    `    no-symbol endpoint  ${summary.excluded.noSymbolEndpoints}`,
    `    low connectionCount ${summary.excluded.lowConnectionCount}`,
    `  edges judged        ${summary.consideredEdgeCount}`,
    `  violations          ${summary.violationCount}`,
    "",
    NO_SYMBOL_ENDPOINT_REASON,
    `  files excluded      ${report.noSymbolEndpointFiles.length}`,
    `  top ${top} by edges excluded`,
  ];
  for (const { relPath, excludedEdgeCount } of report.noSymbolEndpointFiles.slice(0, top)) {
    lines.push(`  ${String(excludedEdgeCount).padStart(6)}  ${relPath}`);
  }
  lines.push("", "by directory relation");
  const byRelation = countBy(violations, (v) => v.directoryRelation);
  for (const relation of DIRECTORY_RELATIONS) {
    lines.push(`  ${relation.padEnd(12)} ${byRelation.get(relation) ?? 0}`);
  }
  lines.push("", "by source language");
  const byLanguage = countBy(violations, (v) => languages.get(v.sourceRelPath) ?? "?");
  for (const [language, count] of [...byLanguage].sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${language.padEnd(12)} ${count}`);
  }
  lines.push("", `top ${top} violations`, VIOLATION_HEADER);
  for (const v of violations.slice(0, top)) lines.push(formatViolation(v));
  const crossModule = violations.filter((v) => v.directoryRelation === "disjoint");
  lines.push("", `top ${top} cross-module (disjoint) violations`, VIOLATION_HEADER);
  for (const v of crossModule.slice(0, top)) lines.push(formatViolation(v));
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  assertNotLiveCodegraphDatabase(args.dbPath, resolveDataDir());
  const options: StableDependenciesOptions = {};
  if (args.tolerance !== undefined) options.tolerance = args.tolerance;
  if (args.minConnectionCount !== undefined) options.minConnectionCount = args.minConnectionCount;
  const { graph, report } = await collectStableDependencies(args.dbPath, options);
  process.stdout.write(renderStableDependenciesReport(report, graph, args.top));
  if (args.jsonOut) {
    const json = buildStableDependenciesJson(report, graph, args.dbPath, args.top);
    writeFileSync(args.jsonOut, `${JSON.stringify(json, null, 2)}\n`);
  }
}

/** The `--json` document: the text report's facts, violations in full, the no-symbol sample capped at `top`. */
export function buildStableDependenciesJson(
  report: StableDependenciesReport,
  graph: FileDependencyGraph,
  dbPath: string,
  top: number,
): {
  dbPath: string;
  summary: StableDependenciesReport["summary"];
  noSymbolEndpointFiles: { reason: string; count: number; sample: NoSymbolEndpointFile[] };
  byDirectoryRelation: Record<string, number>;
  violations: (StableDependencyViolation & { sourceLanguage?: string; targetLanguage?: string })[];
} {
  const languages = languageIndex(graph);
  return {
    dbPath: resolve(dbPath),
    summary: report.summary,
    noSymbolEndpointFiles: {
      reason: NO_SYMBOL_ENDPOINT_REASON,
      count: report.noSymbolEndpointFiles.length,
      sample: report.noSymbolEndpointFiles.slice(0, top),
    },
    byDirectoryRelation: Object.fromEntries(countBy(report.violations, (v) => v.directoryRelation)),
    violations: report.violations.map((v) => ({
      ...v,
      sourceLanguage: languages.get(v.sourceRelPath),
      targetLanguage: languages.get(v.targetRelPath),
    })),
  };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split(sep).pop() ?? "")) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
