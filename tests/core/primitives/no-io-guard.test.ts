/**
 * `src/core/primitives/` is the I/O-free foundation layer (bd tea-rags-mcp-2wu2h,
 * `.claude/rules/domain-boundaries.md`). The eslint zone forbids static imports
 * of I/O modules and upward layer edges, but `no-restricted-imports` cannot see
 * a dynamic `import()`, a `require()`, a `fetch()` or a `process.stdout` write,
 * and it cannot express "type-only" for the `contracts` edge. This guard reads
 * the source with the TypeScript compiler and pins all of those.
 *
 * `process.env` / `process.cwd()` reads are NOT checked here yet: two
 * pre-existing reads in the file classifier move into primitives in a later
 * wave, and the guard takes no allowlist. Lifting them into bootstrap config is
 * the follow-up that adds that clause.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const PRIMITIVES_DIR = "src/core/primitives";

const FIX_HINT =
  "primitives are I/O-free; move to adapters/<system> behind a port or to the owning domain (domain-boundaries.md)";

const IO_NODE_MODULES = new Set([
  "fs",
  "fs/promises",
  "child_process",
  "net",
  "http",
  "https",
  "http2",
  "dgram",
  "dns",
  "tls",
  "worker_threads",
  "cluster",
  "readline",
  "os",
  "process",
  "inspector",
  "v8",
]);

const IO_PACKAGES = new Set(["es-git", "ollama", "undici", "node-fetch", "simple-git"]);
const IO_PACKAGE_PREFIXES = ["@qdrant/", "@duckdb/", "duckdb"];

/** Repo-relative directories a primitive may never resolve into. */
const FORBIDDEN_LAYER_DIRS = [
  "src/core/adapters",
  "src/core/domains",
  "src/core/api",
  "src/bootstrap",
  "src/mcp",
  "src/cli",
];
const CONTRACTS_DIR = "src/core/contracts";

const FORBIDDEN_GLOBAL_CALLS = new Set(["fetch", "require"]);
const FORBIDDEN_PROCESS_STREAMS = new Set(["stdout", "stderr"]);

interface PrimitiveViolation {
  file: string;
  line: number;
  what: string;
}

function isIoModule(specifier: string): boolean {
  const bare = specifier.startsWith("node:") ? specifier.slice("node:".length) : specifier;
  if (IO_NODE_MODULES.has(bare) || IO_PACKAGES.has(specifier)) return true;
  return IO_PACKAGE_PREFIXES.some((prefix) => specifier.startsWith(prefix));
}

function isWithin(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}

/** Every module reference: static import/export, `import()`, `require()`. */
interface ModuleReference {
  specifier: string;
  typeOnly: boolean;
  node: ts.Node;
}

function isTypeOnlyImport(node: ts.ImportDeclaration): boolean {
  return node.importClause?.isTypeOnly === true;
}

function collectModuleReferences(source: ts.SourceFile): ModuleReference[] {
  const refs: ModuleReference[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      refs.push({ specifier: node.moduleSpecifier.text, typeOnly: isTypeOnlyImport(node), node });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      refs.push({ specifier: node.moduleSpecifier.text, typeOnly: node.isTypeOnly, node });
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      const [arg] = node.arguments;
      if (arg !== undefined && ts.isStringLiteralLike(arg)) refs.push({ specifier: arg.text, typeOnly: false, node });
    }
    node.forEachChild(visit);
  };
  visit(source);
  return refs;
}

/** The I/O-free contract over one primitives source file (repo-relative path). */
function findPrimitiveViolations(file: string, text: string): PrimitiveViolation[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const lineOf = (node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const violations: PrimitiveViolation[] = [];

  for (const ref of collectModuleReferences(source)) {
    if (isIoModule(ref.specifier)) {
      violations.push({ file, line: lineOf(ref.node), what: `imports I/O module "${ref.specifier}"` });
      continue;
    }
    if (!ref.specifier.startsWith(".")) continue;
    const target = relative(ROOT, resolve(ROOT, dirname(file), ref.specifier));
    const layer = FORBIDDEN_LAYER_DIRS.find((dir) => isWithin(target, dir));
    if (layer !== undefined) {
      violations.push({ file, line: lineOf(ref.node), what: `imports "${ref.specifier}" from ${layer}` });
    } else if (isWithin(target, CONTRACTS_DIR) && !ref.typeOnly) {
      violations.push({ file, line: lineOf(ref.node), what: `runtime-imports "${ref.specifier}" from contracts` });
    }
  }

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      if (FORBIDDEN_GLOBAL_CALLS.has(name)) violations.push({ file, line: lineOf(node), what: `calls ${name}()` });
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "process" &&
      FORBIDDEN_PROCESS_STREAMS.has(node.name.text)
    ) {
      violations.push({ file, line: lineOf(node), what: `touches process.${node.name.text}` });
    }
    node.forEachChild(visit);
  };
  visit(source);
  return violations;
}

function describeViolation(v: PrimitiveViolation): string {
  return `${v.file}:${v.line} ${v.what} — ${FIX_HINT}`;
}

/**
 * Floor for the scan, so an emptied or mis-rooted directory cannot pass
 * vacuously. Raise it as later waves move more modules in; never lower it.
 */
const MIN_PRIMITIVE_FILES = 20;

function listPrimitiveFiles(): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) visit(rel);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) out.push(rel);
    }
  };
  visit(PRIMITIVES_DIR);
  return out;
}

describe("primitives I/O-free guard — src/core/primitives", () => {
  const files = listPrimitiveFiles();

  it(`scans at least ${MIN_PRIMITIVE_FILES} primitives source files`, () => {
    expect(files.length).toBeGreaterThanOrEqual(MIN_PRIMITIVE_FILES);
  });

  it("holds no I/O module, no upward layer edge, no runtime contracts edge, no I/O global", () => {
    const violations = files.flatMap((file) =>
      findPrimitiveViolations(file, readFileSync(join(ROOT, file), "utf8")).map(describeViolation),
    );
    expect(violations).toEqual([]);
  });
});

const FIXTURE_FILE = `${PRIMITIVES_DIR}/math/__fixture__.ts`;

function violationsIn(text: string): string[] {
  return findPrimitiveViolations(FIXTURE_FILE, text).map((v) => v.what);
}

describe("primitives I/O-free guard — detector", () => {
  it.each([
    ['import { readFileSync } from "node:fs";', 'imports I/O module "node:fs"'],
    ['import { readFile } from "fs/promises";', 'imports I/O module "fs/promises"'],
    ['import { execFile } from "node:child_process";', 'imports I/O module "node:child_process"'],
    ['import os from "os";', 'imports I/O module "os"'],
    ['import { QdrantClient } from "@qdrant/js-client-rest";', 'imports I/O module "@qdrant/js-client-rest"'],
    ['import { DuckDBInstance } from "@duckdb/node-api";', 'imports I/O module "@duckdb/node-api"'],
    ['export { x } from "undici";', 'imports I/O module "undici"'],
    ['const m = await import("node:fs");', 'imports I/O module "node:fs"'],
    ['const m = require("child_process");', 'imports I/O module "child_process"'],
    ['import "../../adapters/qdrant/client.js";', 'imports "../../adapters/qdrant/client.js" from src/core/adapters'],
    [
      'import { Reranker } from "../../domains/explore/reranker.js";',
      'imports "../../domains/explore/reranker.js" from src/core/domains',
    ],
    ['import type { App } from "../../api/public/app.js";', 'imports "../../api/public/app.js" from src/core/api'],
    ['import "../../../bootstrap/config/index.js";', 'imports "../../../bootstrap/config/index.js" from src/bootstrap'],
    [
      'import { normalize } from "../../contracts/signal-utils.js";',
      'runtime-imports "../../contracts/signal-utils.js" from contracts',
    ],
    [
      'import { type AstNode } from "../../contracts/types/ast.js";',
      'runtime-imports "../../contracts/types/ast.js" from contracts',
    ],
    ['export const get = () => fetch("http://x");', "calls fetch()"],
    ['process.stdout.write("x");', "touches process.stdout"],
    ['process.stderr.write("x");', "touches process.stderr"],
  ])("flags %s", (source, expected) => {
    expect(violationsIn(source)).toContain(expected);
  });

  it.each([
    'import type { AstNode } from "../../contracts/types/ast.js";',
    'export type { AstNode } from "../../contracts/types/ast.js";',
    'import { cosine } from "./vector-math.js";',
    'import { tarjanScc } from "../graph/index.js";',
    'import { resolve } from "node:path";',
    'import { createHash } from "node:crypto";',
    'import picomatch from "picomatch";',
    'import ignore from "ignore";',
    "export const seeded = (seed: number) => seed + 1;",
  ])("allows %s", (source) => {
    expect(violationsIn(source)).toEqual([]);
  });

  it("names the file, the line and the fix in every failure message", () => {
    const [violation] = findPrimitiveViolations(FIXTURE_FILE, '\nimport { readFileSync } from "node:fs";\n');
    if (violation === undefined) throw new Error("detector missed node:fs");
    expect(describeViolation(violation)).toBe(`${FIXTURE_FILE}:2 imports I/O module "node:fs" — ${FIX_HINT}`);
  });
});
