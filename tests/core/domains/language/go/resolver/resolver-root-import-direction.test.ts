/**
 * Import-direction pin for the Go resolver (bd tea-rags-mcp-0qaht.37, U4).
 *
 * The resolver root holds only the orchestrator (`go-resolver.ts`) and the
 * barrel (`index.ts`). Every module `strategies/` consumes lives below the
 * root, in `strategies/`. An upward import from there into a root file closes
 * a cycle with the orchestrator's downward edge, so none may exist —
 * `import type` included.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../../../../../../");
const RESOLVER_DIR = join(ROOT, "src/core/domains/language/go/resolver");
const STRATEGIES_DIR = join(RESOLVER_DIR, "strategies");

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
  // Comments quote example imports (`import "./foo"`); only real statements count.
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

describe("Go resolver nested components never import the resolver root", () => {
  it("has strategies/ populated", () => {
    expect(tsFilesUnder(STRATEGIES_DIR).length).toBeGreaterThan(0);
  });

  it("no file under strategies/ imports a file directly in the resolver root", () => {
    const offenders: string[] = [];
    for (const file of tsFilesUnder(STRATEGIES_DIR)) {
      for (const target of relativeTargets(file)) {
        if (dirname(target) === RESOLVER_DIR) offenders.push(`${rel(file)} -> ${rel(target)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
