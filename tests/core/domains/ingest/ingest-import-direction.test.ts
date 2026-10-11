/**
 * Import-direction pins for the ingest domain (bd tea-rags-mcp-g7w8f, item 1).
 *
 * The ingest root is the stable sink of the domain: pipeline, sync, operations
 * and infra import `errors.ts`, so the root may not import back into any of
 * them. Each assertion below pins one edge group that used to close the ingest
 * knot. `import type` counts: the architecture detector judges type edges too.
 */
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../../../../");
const INGEST_DIR = join(ROOT, "src/core/domains/ingest");

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
const isUnder = (abs: string, dir: string): boolean => abs.startsWith(dir + sep);

describe("ingest root never imports into its children", () => {
  it("ingest/errors.ts imports no file under an ingest child directory (DeletionOutcome is a contract)", () => {
    const errorsFile = join(INGEST_DIR, "errors.ts");
    const offenders = relativeTargets(errorsFile)
      .filter((target) => isUnder(target, INGEST_DIR) && dirname(target) !== INGEST_DIR)
      .map((target) => `${rel(errorsFile)} -> ${rel(target)}`);
    expect(offenders).toEqual([]);
  });
});
