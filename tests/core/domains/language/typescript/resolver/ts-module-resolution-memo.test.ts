/**
 * `TSModuleResolutionMemo` — the lookup-free module-resolution memo the batch
 * Programs and the import-graph walk share (bd tea-rags-mcp-vtuu4).
 *
 * It replaced a shared `ts.ModuleResolutionCache`, which on taxdome retained
 * ~545 MB after the graph walk: every cached resolution carries its
 * `failedLookupLocations`, and the cache lives for the whole run. The memo
 * keeps the resolved module only, so what these cases pin is that the
 * answers stay the compiler's own and that no lookup trail survives.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TSModuleResolutionMemo } from "../../../../../../src/core/domains/language/typescript/resolver/ts-module-resolution-memo.js";

describe("TSModuleResolutionMemo (bd tea-rags-mcp-vtuu4)", () => {
  let repoRoot: string;
  let options: ts.CompilerOptions;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-resolution-memo-")));
    options = {
      allowJs: true,
      noEmit: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      baseUrl: repoRoot,
      paths: { "@app/*": ["src/*"] },
      types: [],
    };
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function write(relPath: string, content: string): void {
    const abs = join(repoRoot, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }

  /** A path alias, a package with `exports`, a `.ts` shadowing its `.d.ts`, and a specifier that resolves nowhere. */
  function writeFixture(): { containingFile: string; specifiers: string[] } {
    write("src/util.ts", "export const util = 1;\n");
    write("src/shadow.ts", "export const shadow = 1;\n");
    write("src/shadow.d.ts", "export declare const shadow: number;\n");
    write(
      "node_modules/pkg/package.json",
      JSON.stringify({
        name: "pkg",
        exports: {
          ".": { types: "./dist/main.d.ts", default: "./dist/main.js" },
          "./sub": { types: "./dist/sub.d.ts" },
        },
      }),
    );
    write("node_modules/pkg/dist/main.d.ts", "export declare const main: number;\n");
    write("node_modules/pkg/dist/sub.d.ts", "export declare const sub: number;\n");
    write("src/entry.ts", "export {};\n");
    return {
      containingFile: join(repoRoot, "src/entry.ts"),
      specifiers: ["@app/util", "./shadow", "pkg", "pkg/sub", "./missing", "absent-package"],
    };
  }

  it("returns the compiler's own resolution for every specifier shape", () => {
    const { containingFile, specifiers } = writeFixture();
    const host = ts.createCompilerHost(options, true);
    const memo = new TSModuleResolutionMemo(options, host);

    for (const specifier of specifiers) {
      const expected = ts.resolveModuleName(specifier, containingFile, options, host).resolvedModule;
      const actual = memo.resolve(specifier, containingFile, undefined).resolvedModule;
      expect(actual, specifier).toEqual(expected === undefined ? undefined : { ...expected });
    }
    // The fixture exercises a hit and a miss of each kind it names.
    expect(memo.resolve("./missing", containingFile, undefined).resolvedModule).toBeUndefined();
    expect(memo.resolve("pkg/sub", containingFile, undefined).resolvedModule?.resolvedFileName).toBe(
      join(repoRoot, "node_modules/pkg/dist/sub.d.ts"),
    );
    expect(memo.resolve("./shadow", containingFile, undefined).resolvedModule?.resolvedFileName).toBe(
      join(repoRoot, "src/shadow.ts"),
    );
  });

  it("retains no failed-lookup or affecting-location arrays", () => {
    const { containingFile, specifiers } = writeFixture();
    const memo = new TSModuleResolutionMemo(options, ts.createCompilerHost(options, true));

    for (const specifier of specifiers) memo.resolve(specifier, containingFile, undefined);
    memo.releaseLookups();

    // A second call is a memo hit: the very object the memo holds.
    for (const specifier of specifiers) {
      const held = memo.resolve(specifier, containingFile, undefined);
      expect(held).toBe(memo.resolve(specifier, containingFile, undefined));
      expect(Object.keys(held)).toEqual(["resolvedModule"]);
    }
    expect(memo.size).toBe(specifiers.length);
  });

  it("answers per containing DIRECTORY and resolution mode", () => {
    const { containingFile } = writeFixture();
    write("src/sibling.ts", "export {};\n");
    write("src/nested/deep.ts", "export {};\n");
    const memo = new TSModuleResolutionMemo(options, ts.createCompilerHost(options, true));

    const first = memo.resolve("./util", containingFile, undefined);
    // Same directory: one entry, whatever file asks.
    expect(memo.resolve("./util", join(repoRoot, "src/sibling.ts"), undefined)).toBe(first);
    // Another directory resolves the relative specifier on its own terms.
    expect(memo.resolve("./util", join(repoRoot, "src/nested/deep.ts"), undefined).resolvedModule).toBeUndefined();
    // Another mode is another key.
    expect(memo.resolve("./util", containingFile, ts.ModuleKind.CommonJS)).not.toBe(first);
  });

  it("forgets everything on clear", () => {
    const { containingFile } = writeFixture();
    const memo = new TSModuleResolutionMemo(options, ts.createCompilerHost(options, true));
    memo.resolve("./util", containingFile, undefined);

    memo.clear();

    expect(memo.size).toBe(0);
  });
});
