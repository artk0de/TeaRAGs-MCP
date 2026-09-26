/**
 * Whole vs closure-batched `ts.Program` parity (bd tea-rags-mcp-vtuu4).
 *
 * The batch design claims that a Program over a root's full forward closure,
 * plus the prelude, types every call site in that root the way the whole
 * project's Program does. These cases hold it to that. Each call site's
 * resolved declaration is read off one `ts.createProgram` over every file and
 * compared with the same read off the production batch path: the Program
 * `TSProgramCache#acquire` serves while the files are visited in
 * `planResolveVisits` order, with a call cap small enough to split the corpus
 * into several batches.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";

import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  TSProgramCache,
  type TSProgramHandle,
} from "../../../../../../src/core/domains/language/typescript/resolver/ts-program-cache.js";

const tsOptions = { baseUrl: ".", paths: {} };

describe("closure-batch Programs resolve like the whole Program (bd tea-rags-mcp-vtuu4)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-program-batch-parity-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function write(relPath: string, content: string): void {
    const abs = join(repoRoot, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }

  /**
   * A multi-root project: a barrel whose members two roots import, a project
   * global script with an overload set, and a file that pulls a lib the
   * default lib lacks through `/// <reference lib>` — which the whole Program
   * then offers to EVERY file, including one that never references it.
   */
  function writeProject(): string[] {
    write(
      "src/globals.d.ts",
      "declare function projectGlobal(x: string): string;\ndeclare function projectGlobal(x: number): number;\n",
    );
    write("src/barrel/index.ts", `export * from "./a";\nexport * from "./b";\n`);
    write("src/barrel/a.ts", "export class A {\n  run(): number {\n    return 1;\n  }\n}\n");
    write("src/barrel/b.ts", `export function makeB(): { go(): string } {\n  return { go: () => "x" };\n}\n`);
    write(
      "src/app1.ts",
      `import { A, makeB } from "./barrel";\n` +
        `export function app1(): void {\n  new A().run();\n  makeB().go();\n  projectGlobal("s");\n}\n`,
    );
    write(
      "src/lib-user.ts",
      `/// <reference lib="es2023.array" />\nexport const last = [1, 2].findLast((x) => x > 1);\n`,
    );
    write("src/app2.ts", "export function app2(): void {\n  projectGlobal(2);\n  [3, 4].findLast((x) => x > 3);\n}\n");
    return [
      "src/app1.ts",
      "src/app2.ts",
      "src/barrel/a.ts",
      "src/barrel/b.ts",
      "src/barrel/index.ts",
      "src/lib-user.ts",
    ];
  }

  /** `file:pos` of the declaration each call site resolves to, keyed by the call's position. */
  function declarationsIn(program: ts.Program, sourceFile: ts.SourceFile): Record<number, string> {
    const checker = program.getTypeChecker();
    const out: Record<number, string> = {};
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const declaration = checker.getResolvedSignature(node)?.declaration;
        if (declaration === undefined) {
          out[node.pos] = "-";
        } else {
          const file = declaration.getSourceFile().fileName;
          const shown = file.startsWith(`${repoRoot}/`) ? relative(repoRoot, file) : basename(file);
          out[node.pos] = `${shown}:${declaration.pos}`;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return out;
  }

  /** Every file's call-site declarations through the production batch path, visited in plan order. */
  function resolveBatched(relPaths: readonly string[]): {
    byFile: Record<string, Record<number, string>>;
    cache: TSProgramCache;
  } {
    const cache = new TSProgramCache({
      repoRoot,
      tsOptions,
      strategy: "whole",
      projectRoots: () => [join(repoRoot, "src/globals.d.ts")],
      // One call site per root against a cap of one: every root that does
      // not fall into another's closure opens its own batch.
      batchCallSites: 1,
    });
    cache.primeForExpectedEntries(relPaths.length, relPaths, new Map(relPaths.map((relPath) => [relPath, 1])));
    const byFile: Record<string, Record<number, string>> = {};
    for (const group of cache.planResolveVisits() ?? []) {
      for (const relPath of group) {
        const handle = cache.acquire(relPath) as TSProgramHandle;
        byFile[relPath] = declarationsIn(handle.program, handle.sourceFile);
      }
      cache.endResolveVisitGroup();
    }
    return { byFile, cache };
  }

  /** The same, off ONE Program over every file, built with the options the batches use. */
  function resolveWhole(
    relPaths: readonly string[],
    options: ts.CompilerOptions,
  ): Record<string, Record<number, string>> {
    const program = ts.createProgram({
      rootNames: [join(repoRoot, "src/globals.d.ts"), ...relPaths.map((relPath) => join(repoRoot, relPath))],
      options,
    });
    const byFile: Record<string, Record<number, string>> = {};
    for (const relPath of relPaths) {
      byFile[relPath] = declarationsIn(program, program.getSourceFile(join(repoRoot, relPath)) as ts.SourceFile);
    }
    return byFile;
  }

  function optionsOf(cache: TSProgramCache, relPath: string): ts.CompilerOptions {
    return (cache.acquire(relPath) as TSProgramHandle).program.getCompilerOptions();
  }

  it("resolves a multi-root project to the same edges whole and batched", () => {
    const relPaths = writeProject();

    const { byFile: batched, cache } = resolveBatched(relPaths);
    const whole = resolveWhole(relPaths, optionsOf(cache, relPaths[0]));

    expect(Number(cache.diagnostics().batches)).toBeGreaterThan(1);
    expect(Object.keys(batched).sort()).toEqual([...relPaths].sort());
    expect(batched).toEqual(whole);
  });

  it("keeps a global overload pick the prelude carries", () => {
    const relPaths = writeProject();

    const { byFile: batched, cache } = resolveBatched(relPaths);
    const whole = resolveWhole(relPaths, optionsOf(cache, relPaths[0]));

    // app2 imports nothing, so neither the project global nor the es2023 lib
    // is in its closure: only the prelude can hand them to its batch.
    const picks = Object.values(batched["src/app2.ts"] ?? {});
    expect(picks.some((pick) => pick.startsWith("src/globals.d.ts:"))).toBe(true);
    expect(picks.some((pick) => pick.startsWith("lib.es2023.array.d.ts:"))).toBe(true);
    expect(batched["src/app2.ts"]).toEqual(whole["src/app2.ts"]);
  });
});
