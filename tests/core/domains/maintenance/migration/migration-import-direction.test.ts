/**
 * Import-direction pin for maintenance/migration (bd tea-rags-mcp-k7kmu C9, S4b).
 *
 * The migration framework CONSUMES drift judgements but owns no drift axis: the
 * shared stats-contract judgement lives in `contracts/stats-contract.ts`, so the
 * adapter's dependency resolves to contracts, not to the drift component. An
 * edge `migration/** -> drift/**` (facade included, `import type` included)
 * makes the migration framework unstable alongside the reporters it merely
 * reads — the SDP violation the move removed.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../../../../../");
const MAINTENANCE_DIR = join(ROOT, "src/core/domains/maintenance");
const MIGRATION_DIR = join(MAINTENANCE_DIR, "migration");
const DRIFT_DIR = join(MAINTENANCE_DIR, "drift");

function tsFilesUnder(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) tsFilesUnder(abs, acc);
    else if (entry.endsWith(".ts")) acc.push(abs);
  }
  return acc;
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

function isWithin(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}

describe("maintenance/migration never imports maintenance/drift", () => {
  it("has migration populated", () => {
    expect(tsFilesUnder(MIGRATION_DIR).length).toBeGreaterThan(0);
  });

  it("has drift populated", () => {
    expect(tsFilesUnder(DRIFT_DIR).length).toBeGreaterThan(0);
  });

  it("no file under migration/ imports a file under drift/", () => {
    const offenders: string[] = [];
    for (const file of tsFilesUnder(MIGRATION_DIR)) {
      for (const target of relativeTargets(file)) {
        if (isWithin(target, DRIFT_DIR)) offenders.push(`${rel(file)} -> ${rel(target)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
