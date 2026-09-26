/**
 * The import graph the batch planner packs over, built the way the compiler
 * would walk it (bd tea-rags-mcp-vtuu4): `ts.preProcessFile` for the
 * specifiers, `ts.resolveModuleName` over the shared resolution cache for the
 * targets. It also picks the prelude — the files whose declarations the whole
 * Program would see as GLOBALS, which a batch must carry whatever its roots.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildTSProgramImportGraph,
  type TSProgramImportGraph,
} from "../../../../../../src/core/domains/language/typescript/resolver/ts-program-import-graph.js";

const compilerOptions: ts.CompilerOptions = {
  allowJs: true,
  noEmit: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.Preserve,
  types: [],
};

describe("buildTSProgramImportGraph (bd tea-rags-mcp-vtuu4)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-import-graph-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function write(relPath: string, content: string): string {
    const abs = join(repoRoot, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
    return abs;
  }

  function build(rootNames: readonly string[]): TSProgramImportGraph {
    const host = ts.createCompilerHost(compilerOptions, true);
    return buildTSProgramImportGraph({
      rootNames,
      compilerOptions,
      host,
      moduleResolutionCache: ts.createModuleResolutionCache(repoRoot, (name) => name, compilerOptions),
    });
  }

  function importsOf(graph: TSProgramImportGraph, fileName: string): string[] {
    const node = graph.nodes.find((candidate) => candidate.fileName === fileName);
    if (node === undefined) throw new Error(`${fileName} is not in the graph`);
    return node.imports.map((index) => graph.nodes[index].fileName).sort();
  }

  function preludeNames(graph: TSProgramImportGraph): string[] {
    return graph.preludeSeeds.map((index) => graph.nodes[index].fileName);
  }

  it("follows imports, export-from, require in JS, reference paths and type references", () => {
    const entry = write(
      "src/entry.ts",
      [
        `/// <reference path="./referenced.d.ts" />`,
        `/// <reference types="typed" />`,
        `import { a } from "./a";`,
        `export { b } from "./b";`,
        `a();`,
      ].join("\n"),
    );
    const a = write("src/a.ts", `export function a(): void {}\n`);
    const b = write("src/b.ts", `export function b(): void {}\n`);
    const referenced = write("src/referenced.d.ts", `declare const referenced: number;\n`);
    const typed = write("node_modules/@types/typed/index.d.ts", `declare const typed: number;\n`);
    const script = write("src/legacy.js", `const helper = require("./helper");\nmodule.exports = helper;\n`);
    const helper = write("src/helper.js", `module.exports = function helper() {};\n`);

    const graph = build([entry, script]);

    expect(importsOf(graph, entry)).toEqual([a, b, referenced, typed].sort());
    expect(importsOf(graph, script)).toEqual([helper]);
  });

  it("records each file's text size", () => {
    const text = `export const answer = 42;\n`;
    const entry = write("src/entry.ts", text);

    const graph = build([entry]);

    expect(graph.nodes.find((node) => node.fileName === entry)?.textBytes).toBe(text.length);
  });

  it("marks project declaration files that are global scripts, augment globals or declare ambient modules", () => {
    const script = write("src/globals.d.ts", `declare function projectGlobal(): void;\n`);
    const augmenting = write(
      "src/augment.d.ts",
      `export {};\ndeclare global {\n  interface Window { flag: boolean }\n}\n`,
    );
    const ambient = write(
      "src/shims.d.ts",
      `declare module "*.svg" {\n  const src: string;\n  export default src;\n}\n`,
    );
    const plainModule = write("src/plain.ts", `export const plain = 1;\n`);
    const commonJs = write("src/common.js", `module.exports = { common: 1 };\n`);

    const graph = build([script, augmenting, ambient, plainModule, commonJs]);
    const prelude = preludeNames(graph);

    expect(prelude).toEqual(expect.arrayContaining([script, augmenting, ambient]));
    expect(prelude).not.toContain(plainModule);
    expect(prelude).not.toContain(commonJs);
  });

  it("leaves project SOURCE files out of the prelude, whatever they declare", () => {
    // The prelude's project half is declaration files only (spec §2): a
    // `declare global` in a spec file or a source script stays with its batch.
    const augmentingSource = write(
      "src/augment.ts",
      `export {};\ndeclare global {\n  interface Window { flag: boolean }\n}\n`,
    );
    const sourceScript = write("src/legacy-script.ts", `function legacyGlobal(): void {}\n`);

    const prelude = preludeNames(build([augmentingSource, sourceScript]));

    expect(prelude).not.toContain(augmentingSource);
    expect(prelude).not.toContain(sourceScript);
  });

  it("collects lib reference directives as prelude libs", () => {
    const worker = write("src/worker.ts", `/// <reference lib="webworker" />\nexport const worker = 1;\n`);

    const graph = build([worker]);
    const libs = preludeNames(graph).map((fileName) => basename(fileName));

    expect(libs).toContain("lib.webworker.d.ts");
    // The default lib is part of every Program; the prelude names it too, so
    // its text is charged to every batch.
    expect(libs).toContain(basename(ts.getDefaultLibFilePath(compilerOptions)));
  });

  it("selects dependency global scripts for the prelude but not dependency modules", () => {
    write("node_modules/@types/nodeish/package.json", `{ "name": "@types/nodeish", "types": "index.d.ts" }\n`);
    const globalScript = write(
      "node_modules/@types/nodeish/index.d.ts",
      `declare function setTimeout(handler: () => void): NodeishTimer;\ninterface NodeishTimer { ref(): void }\n`,
    );
    write("node_modules/modish/package.json", `{ "name": "modish", "types": "index.d.ts" }\n`);
    const dependencyModule = write("node_modules/modish/index.d.ts", `export declare function modish(): void;\n`);
    const entry = write(
      "src/entry.ts",
      `/// <reference types="nodeish" />\nimport { modish } from "modish";\nmodish();\n`,
    );

    const graph = build([entry]);
    const prelude = preludeNames(graph);

    expect(prelude).toContain(globalScript);
    expect(prelude).not.toContain(dependencyModule);
    expect(prelude).not.toContain(entry);
  });

  it("takes a dependency's global augmentation but not its ambient module declarations", () => {
    // Spec §2: only dependency declarations the whole Program sees as GLOBALS.
    // An ambient `declare module "x"` shapes imports of "x" — which the
    // importing file's own closure reaches — not global overloads.
    write("node_modules/globby/package.json", `{ "name": "globby", "types": "index.d.ts" }\n`);
    const augmenting = write(
      "node_modules/globby/index.d.ts",
      `export declare function globby(): void;\ndeclare global {\n  interface Array<T> { globby(): T }\n}\n`,
    );
    write("node_modules/ambi/package.json", `{ "name": "ambi", "types": "index.d.ts" }\n`);
    const ambient = write(
      "node_modules/ambi/index.d.ts",
      `declare module "ambi-extra" {\n  export function extra(): void;\n}\nexport declare function ambi(): void;\n`,
    );
    const entry = write(
      "src/entry.ts",
      `import { globby } from "globby";\nimport { ambi } from "ambi";\nglobby();\nambi();\n`,
    );

    const prelude = preludeNames(build([entry]));

    expect(prelude).toContain(augmenting);
    expect(prelude).not.toContain(ambient);
  });
});
