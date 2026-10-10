/**
 * Import-direction pin for explore/chunk-grouping (bd tea-rags-mcp-0qaht.37, U4).
 *
 * Chunk grouping is a leaf below the explore root: the root and `strategies/`
 * consume the grouping rules, so nothing under `chunk-grouping/` may import a
 * file directly in `explore/` — `import type` included. The `#partN` fragment
 * parser (`split-fragment.ts`) lives here for that reason.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../../../../../");
const EXPLORE_DIR = join(ROOT, "src/core/domains/explore");
const GROUPING_DIR = join(EXPLORE_DIR, "chunk-grouping");

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

describe("explore/chunk-grouping never imports explore-root files", () => {
  it("has chunk-grouping populated", () => {
    expect(tsFilesUnder(GROUPING_DIR).length).toBeGreaterThan(0);
  });

  it("no file under chunk-grouping/ imports a file directly in explore/", () => {
    const offenders: string[] = [];
    for (const file of tsFilesUnder(GROUPING_DIR)) {
      for (const target of relativeTargets(file)) {
        if (dirname(target) === EXPLORE_DIR) offenders.push(`${rel(file)} -> ${rel(target)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
