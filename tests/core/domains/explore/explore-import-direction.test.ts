/**
 * Import-direction pins for the explore root (bd tea-rags-mcp-g7w8f-2, X1).
 *
 * The explore root hands the overlay view down to `working-tree/`, so the one
 * thing that must never come back is an import from a `working-tree/` file
 * into an explore root file — that single back edge closes the
 * root <-> working-tree composition cycle. The error vocabulary is a leaf
 * component (`errors/`) below the root for the same reason: it is imported by
 * the root, strategies, queries and `working-tree/dense-floor.ts`, and it must
 * stay importable from all of them without importing any of them back.
 * `import type` counts: the architecture detector judges type edges too.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../../../../");
const EXPLORE_DIR = join(ROOT, "src/core/domains/explore");
const WORKING_TREE_DIR = join(EXPLORE_DIR, "working-tree");
const ERRORS_DIR = join(EXPLORE_DIR, "errors");

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

describe("working-tree never imports explore-root files", () => {
  it("no file under working-tree/ imports a file directly in explore/ (the error vocabulary lives in errors/)", () => {
    const offenders: string[] = [];
    for (const file of tsFilesUnder(WORKING_TREE_DIR)) {
      for (const target of relativeTargets(file)) {
        if (dirname(target) === EXPLORE_DIR) offenders.push(`${rel(file)} -> ${rel(target)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("explore/errors is a leaf component", () => {
  it("has errors populated", () => {
    expect(tsFilesUnder(ERRORS_DIR).length).toBeGreaterThan(0);
  });

  it("no file under errors/ imports a file directly in explore/", () => {
    const offenders: string[] = [];
    for (const file of tsFilesUnder(ERRORS_DIR)) {
      for (const target of relativeTargets(file)) {
        if (dirname(target) === EXPLORE_DIR) offenders.push(`${rel(file)} -> ${rel(target)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("explore children reach the error vocabulary only through errors/index.js", () => {
  it("no file outside errors/ imports a file under errors/ other than its index", () => {
    const barrel = join(ERRORS_DIR, "index.ts");
    const offenders: string[] = [];
    for (const file of tsFilesUnder(EXPLORE_DIR)) {
      if (file.startsWith(`${ERRORS_DIR}/`)) continue;
      for (const target of relativeTargets(file)) {
        if (target.startsWith(`${ERRORS_DIR}/`) && target !== barrel) offenders.push(`${rel(file)} -> ${rel(target)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
