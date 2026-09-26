/**
 * Rename-only invariant for codegraph database files (bd tea-rags-mcp-r4veq).
 *
 * `GraphDbClientPool` tells a replaced database from the one its client opened
 * by the path's `dev`/`ino` (bd tea-rags-mcp-amh78). A file copied OVER an
 * existing path keeps that path's inode, so the check cannot see it and the
 * cached client keeps writing into a database that is no longer its own. A
 * codegraph database therefore lands at a path only by rename: bytes are copied
 * into a staging file created exclusively (`COPYFILE_EXCL`, a fresh inode), and
 * the staging file is renamed into place.
 *
 * The guard derives its scope from the code rather than a hand list: every
 * source file that can name a codegraph database path — it references the
 * path-layout owner `CodegraphDbFiles`, the pool, the compaction staging name,
 * a `pathFor(...)` call, or a `.duckdb` literal — is scanned, and every fs copy
 * call in it must pass `COPYFILE_EXCL`; `cp`/`cpSync` (recursive copies with
 * overwrite semantics) are refused outright.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "../../../..");
const SRC_DIR = join(REPO_ROOT, "src");

/** Identifiers through which a module reaches a codegraph database path. */
const PATH_OWNER_IDENTIFIERS = new Set(["CodegraphDbFiles", "GraphDbClientPool", "compactionStagingPath"]);
const PATH_RESOLVER_METHODS = new Set(["pathFor", "writablePathFor"]);
const COPY_CALLS = new Set(["copyFile", "copyFileSync"]);
const OVERWRITING_COPY_CALLS = new Set(["cp", "cpSync"]);

interface CopyViolation {
  file: string;
  line: number;
  call: string;
  reason: string;
}

function calleeName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}

function mentionsExclusiveMode(node: ts.Node | undefined): boolean {
  if (!node) return false;
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found) return;
    if (ts.isPropertyAccessExpression(child) && child.name.text === "COPYFILE_EXCL") found = true;
    else if (ts.isIdentifier(child) && child.text === "COPYFILE_EXCL") found = true;
    else ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

/** Whether the module can name a codegraph database path at all. */
function canNameCodegraphDatabasePath(source: ts.SourceFile): boolean {
  let found = false;
  const namesPath = (node: ts.Node): boolean => {
    if (ts.isIdentifier(node)) return PATH_OWNER_IDENTIFIERS.has(node.text);
    if (ts.isCallExpression(node)) return PATH_RESOLVER_METHODS.has(calleeName(node.expression) ?? "");
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text.includes(".duckdb");
    if (ts.isTemplateExpression(node)) return node.getText(source).includes(".duckdb");
    return false;
  };
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (namesPath(node)) found = true;
    else ts.forEachChild(node, visit);
  };
  visit(source);
  return found || source.fileName.endsWith("codegraph-db-files.ts");
}

/** Copy calls in `text` that could put bytes over an existing codegraph database path. */
function findCopyOverViolations(fileName: string, text: string): CopyViolation[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (!canNameCodegraphDatabasePath(source)) return [];
  const violations: CopyViolation[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      if (name && OVERWRITING_COPY_CALLS.has(name)) {
        violations.push({ file: fileName, line, call: name, reason: "recursive copy overwrites in place" });
      } else if (name && COPY_CALLS.has(name) && !mentionsExclusiveMode(node.arguments[2])) {
        violations.push({ file: fileName, line, call: name, reason: "copy without COPYFILE_EXCL keeps the inode" });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
}

/** Copy calls the scan saw in path-aware files, violating or not — proves the guard is not vacuous. */
function countCopyCalls(fileName: string, text: string): number {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (!canNameCodegraphDatabasePath(source)) return 0;
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && COPY_CALLS.has(calleeName(node.expression) ?? "")) count += 1;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return count;
}

function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...listSourceFiles(full));
    else if (full.endsWith(".ts") && !full.endsWith(".d.ts")) files.push(full);
  }
  return files;
}

describe("codegraph database files land at a path only by rename (r4veq)", () => {
  it("catches a synthetic copy over a codegraph database path", () => {
    const synthetic = [
      'import { copyFile } from "node:fs/promises";',
      'import { CodegraphDbFiles } from "./codegraph-db-files.js";',
      "export async function restore(files: CodegraphDbFiles, name: string, backup: string): Promise<void> {",
      "  await copyFile(backup, files.pathFor(name));",
      "}",
    ].join("\n");

    expect(findCopyOverViolations("synthetic.ts", synthetic)).toEqual([
      { file: "synthetic.ts", line: 4, call: "copyFile", reason: "copy without COPYFILE_EXCL keeps the inode" },
    ]);
  });

  it("catches a recursive copy of the codegraph directory", () => {
    const synthetic = [
      'import { cpSync } from "node:fs";',
      "export function seed(from: string, to: string): void {",
      '  cpSync(join(from, "codegraph", "x.duckdb"), to, { recursive: true });',
      "}",
    ].join("\n");

    expect(findCopyOverViolations("synthetic.ts", synthetic).map((v) => v.call)).toEqual(["cpSync"]);
  });

  it("accepts an exclusive copy into staging, and ignores modules that cannot name a database path", () => {
    const exclusive = [
      'import { constants } from "node:fs";',
      'import { copyFile } from "node:fs/promises";',
      'import { CodegraphDbFiles } from "./codegraph-db-files.js";',
      "export async function stage(files: CodegraphDbFiles, name: string, from: string): Promise<void> {",
      '  await copyFile(from, files.pathFor(name) + ".clone-tmp", constants.COPYFILE_EXCL);',
      "}",
    ].join("\n");
    const unrelated = [
      'import { copyFileSync } from "node:fs";',
      "export function backup(a: string, b: string): void {",
      "  copyFileSync(a, b);",
      "}",
    ].join("\n");

    expect(findCopyOverViolations("exclusive.ts", exclusive)).toEqual([]);
    expect(findCopyOverViolations("unrelated.ts", unrelated)).toEqual([]);
  });

  it("no source module copies onto a codegraph database path", () => {
    const violations: CopyViolation[] = [];
    let scannedCopies = 0;
    for (const file of listSourceFiles(SRC_DIR)) {
      const text = readFileSync(file, "utf8");
      const rel = relative(REPO_ROOT, file);
      violations.push(...findCopyOverViolations(rel, text));
      scannedCopies += countCopyCalls(rel, text);
    }

    expect(violations).toEqual([]);
    // The clone path copies into staging; a scan that sees no copy at all has
    // lost its scope and would pass vacuously.
    expect(scannedCopies).toBeGreaterThan(0);
  });
});
