/**
 * Import-direction pin for the codegraph trajectory (bd tea-rags-mcp-t80p0).
 *
 * The codegraph root (`index.ts`, `factory.ts`) composes the symbols child, so
 * the child may not import a loose file of the root back: every such edge closes
 * a `codegraph <-> codegraph/symbols` composition cycle in the architecture
 * report. What the child needs from the codegraph level (the type hierarchy
 * view, the exclusion filter) lives in leaf components with their own facade.
 * `import type` counts: the architecture detector judges type edges too.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../../../../../");
const CODEGRAPH_DIR = join(ROOT, "src/core/domains/trajectory/codegraph");
const SYMBOLS_DIR = join(CODEGRAPH_DIR, "symbols");

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

describe("codegraph/symbols never imports back into the codegraph root", () => {
  it("no file under symbols/ imports a loose root-level codegraph file", () => {
    const offenders: string[] = [];
    for (const file of tsFilesUnder(SYMBOLS_DIR)) {
      for (const target of relativeTargets(file)) {
        if (dirname(target) === CODEGRAPH_DIR && !target.startsWith(SYMBOLS_DIR + sep)) {
          offenders.push(`${rel(file)} -> ${rel(target)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
