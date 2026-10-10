/**
 * Import-direction pin for the Python resolver (bd tea-rags-mcp-0qaht.37, U2).
 *
 * The resolver root holds only the orchestrator (`python-resolver.ts`), the
 * barrel (`index.ts`) and orchestrator-only helpers. Everything `strategies/`
 * or `dispatch/` consumes lives below the root, in `strategies/` (Rust
 * layout). An upward import from a nested component into a root file closes a
 * cycle with the orchestrator's downward edge, so none may exist — `import
 * type` included.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../../../../../../");
const RESOLVER_DIR = join(ROOT, "src/core/domains/language/python/resolver");
const STRATEGIES_DIR = join(RESOLVER_DIR, "strategies");
const DISPATCH_DIR = join(RESOLVER_DIR, "dispatch");

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
const isDirectChildOf = (dir: string, abs: string): boolean => dirname(abs) === dir;

describe("Python resolver nested components never import the resolver root", () => {
  it("has strategies/ and dispatch/ populated", () => {
    expect(tsFilesUnder(STRATEGIES_DIR).length).toBeGreaterThan(0);
    expect(tsFilesUnder(DISPATCH_DIR).length).toBeGreaterThan(0);
  });

  it("no file under strategies/ or dispatch/ imports a file directly in the resolver root", () => {
    const offenders: string[] = [];
    for (const file of [...tsFilesUnder(STRATEGIES_DIR), ...tsFilesUnder(DISPATCH_DIR)]) {
      for (const target of relativeTargets(file)) {
        if (isDirectChildOf(RESOLVER_DIR, target)) offenders.push(`${rel(file)} -> ${rel(target)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("strategies/ never imports dispatch/ (no sibling cycle)", () => {
    const offenders: string[] = [];
    for (const file of tsFilesUnder(STRATEGIES_DIR)) {
      for (const target of relativeTargets(file)) {
        if (target.startsWith(`${DISPATCH_DIR}/`)) offenders.push(`${rel(file)} -> ${rel(target)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
