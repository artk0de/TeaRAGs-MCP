/**
 * Import-direction pin for the architecture-report detector family
 * (bd tea-rags-mcp-t80p0).
 *
 * `api/internal/ops/` has no facade, so its loose files belong to the `api`
 * component, and `architecture-report-ops.ts` composes the
 * `ops/architecture-report/` child. The child importing a loose ops file back
 * closes an `api <-> ops/architecture-report` composition cycle in the
 * architecture report. Shared shaping the child needs (the grouped
 * silent-coupling finding) lives in a leaf component with its own facade.
 * `import type` counts: the architecture detector judges type edges too.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../../../");
const OPS_DIR = join(ROOT, "src/core/api/internal/ops");
const ARCHITECTURE_REPORT_DIR = join(OPS_DIR, "architecture-report");

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

describe("ops/architecture-report never imports back into the api component", () => {
  it("no file under ops/architecture-report/ imports a loose api/internal/ops file", () => {
    const offenders: string[] = [];
    for (const file of tsFilesUnder(ARCHITECTURE_REPORT_DIR)) {
      for (const target of relativeTargets(file)) {
        if (dirname(target) === OPS_DIR) offenders.push(`${rel(file)} -> ${rel(target)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
