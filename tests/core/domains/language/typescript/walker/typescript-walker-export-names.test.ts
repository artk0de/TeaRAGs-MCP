/**
 * bd tea-rags-mcp-r8hme.2 — every module reference records the names it takes
 * from the TARGET module's export surface (`importedExportNames`), and every
 * source re-export the names it forwards (`reexportedExportNames`). The
 * leaking-abstraction detector compares the two across a module facade: a deep
 * import of names the facade re-exports is a bypass, one of names it does not
 * is an internal reach.
 *
 * Names are the TARGET's spelling, never the local alias: `import { a as b }`
 * takes `a`. `default` is the default export, `*` the whole module.
 */
import Parser from "tree-sitter";
import TsLang from "tree-sitter-typescript";
import { describe, expect, it } from "vitest";

import { extractFromTypescriptFile } from "../../../../../../src/core/domains/language/typescript/walker/walker.js";

function importsOf(code: string) {
  const parser = new Parser();
  parser.setLanguage((TsLang as { typescript: Parser.Language }).typescript);
  return extractFromTypescriptFile({
    tree: parser.parse(code),
    code,
    relPath: "src/a.ts",
    language: "typescript",
    chunks: [],
  }).imports;
}

function refFor(code: string, importText: string) {
  return importsOf(code).find((i) => i.importText === importText);
}

describe("extractFromTypescriptFile — importedExportNames", () => {
  it("records the exported name of each named specifier, not its local alias", () => {
    const ref = refFor(`import { create as createAction, destroy } from "./repo";\n`, "./repo");
    expect(ref?.importedExportNames).toEqual(["create", "destroy"]);
    expect(ref?.reexportedExportNames).toBeUndefined();
  });

  it("records `default` for a default import and `*` for a namespace import", () => {
    expect(refFor(`import Foo from "./foo";\n`, "./foo")?.importedExportNames).toEqual(["default"]);
    expect(refFor(`import * as ns from "./ns";\n`, "./ns")?.importedExportNames).toEqual(["*"]);
    expect(refFor(`import Foo, { bar } from "./mix";\n`, "./mix")?.importedExportNames).toEqual(["default", "bar"]);
  });

  it("records nothing for a bare side-effect import", () => {
    expect(refFor(`import "./polyfill";\n`, "./polyfill")?.importedExportNames).toBeUndefined();
  });

  it("records destructured members of a require, and `*` for a whole-module require", () => {
    expect(refFor(`const { a, b: local } = require("./cjs");\n`, "./cjs")?.importedExportNames).toEqual(["a", "b"]);
    expect(refFor(`const mod = require("./whole");\n`, "./whole")?.importedExportNames).toEqual(["*"]);
    expect(refFor(`require("./side");\n`, "./side")?.importedExportNames).toBeUndefined();
  });

  it("records destructured members of a dynamic import", () => {
    const code = `async function f() {\n  const { parse } = await import("./cfg");\n}\n`;
    expect(refFor(code, "./cfg")?.importedExportNames).toEqual(["parse"]);
  });
});

describe("extractFromTypescriptFile — reexportedExportNames", () => {
  it("records the source-side names of `export { … } from`", () => {
    const ref = refFor(`export { a, b as c, default as D } from "./x";\n`, "./x");
    expect(ref?.reexportedExportNames).toEqual(["a", "b", "default"]);
    expect(ref?.importedExportNames).toBeUndefined();
  });

  it("records `*` for `export * from` and `export * as ns from`", () => {
    expect(refFor(`export * from "./all";\n`, "./all")?.reexportedExportNames).toEqual(["*"]);
    expect(refFor(`export * as ns from "./nsx";\n`, "./nsx")?.reexportedExportNames).toEqual(["*"]);
  });

  it("still introduces no local binding for a re-export", () => {
    const ref = refFor(`export { a } from "./x";\n`, "./x");
    expect(ref?.importedNames).toBeUndefined();
    expect(ref?.importedBindings).toBeUndefined();
  });
});

/**
 * bd tea-rags-mcp-zl3so — an aliased re-export records the IMPORTER-FACING
 * name beside the source one: `reexportedExportBindings` maps every name the
 * file exports to the target name it forwards. Present only when some
 * forwarded name is renamed, and then complete (identity entries included);
 * an unaliased re-export records no table.
 */
describe("extractFromTypescriptFile — reexportedExportBindings (bd tea-rags-mcp-zl3so)", () => {
  function typeOnlyRefFor(code: string, importText: string) {
    const parser = new Parser();
    parser.setLanguage((TsLang as { typescript: Parser.Language }).typescript);
    return extractFromTypescriptFile({
      tree: parser.parse(code),
      code,
      relPath: "src/a.ts",
      language: "typescript",
      chunks: [],
    }).typeOnlyImports?.find((i) => i.importText === importText);
  }

  it("`export { a as b } from` maps the exported name to the source name, identity entries included", () => {
    const ref = refFor(`export { a as b, c, default as D } from "./x";\n`, "./x");
    expect(ref?.reexportedExportNames).toEqual(["a", "c", "default"]);
    expect(ref?.reexportedExportBindings).toEqual({ b: "a", c: "c", D: "default" });
  });

  it("`export * as ns from` maps the namespace name to the whole module", () => {
    const ref = refFor(`export * as ns from "./nsx";\n`, "./nsx");
    expect(ref?.reexportedExportNames).toEqual(["*"]);
    expect(ref?.reexportedExportBindings).toEqual({ ns: "*" });
  });

  it("`export type { A as B } from` records the alias on the type-only reference", () => {
    const ref = typeOnlyRefFor(`export type { A as B } from "./t";\n`, "./t");
    expect(ref?.reexportedExportNames).toEqual(["A"]);
    expect(ref?.reexportedExportBindings).toEqual({ B: "A" });
  });

  it("`import { a } from; export { a as b }` forwards `a` out of the import's target as `b`", () => {
    const ref = refFor(`import { a, other } from "./x";\nexport { a as b };\n`, "./x");
    expect(ref?.importedExportNames).toEqual(["a", "other"]);
    expect(ref?.reexportedExportNames).toEqual(["a"]);
    expect(ref?.reexportedExportBindings).toEqual({ b: "a" });
  });

  it("a local re-export follows the import alias back to the target's name", () => {
    const ref = refFor(`import { a as local } from "./x";\nexport { local as b };\n`, "./x");
    expect(ref?.reexportedExportNames).toEqual(["a"]);
    expect(ref?.reexportedExportBindings).toEqual({ b: "a" });
  });

  it("`import type { A }; export type { A as B }` records the alias on the type-only reference", () => {
    const ref = typeOnlyRefFor(`import type { A } from "./t";\nexport type { A as B };\n`, "./t");
    expect(ref?.reexportedExportNames).toEqual(["A"]);
    expect(ref?.reexportedExportBindings).toEqual({ B: "A" });
  });

  it("an unaliased re-export records no bindings table", () => {
    expect(refFor(`export { a, b } from "./x";\n`, "./x")?.reexportedExportBindings).toBeUndefined();
    expect(refFor(`export * from "./all";\n`, "./all")?.reexportedExportBindings).toBeUndefined();
    const local = refFor(`import { a } from "./x";\nexport { a };\n`, "./x");
    expect(local?.reexportedExportNames).toEqual(["a"]);
    expect(local?.reexportedExportBindings).toBeUndefined();
  });

  it("an export of a local declaration is not a re-export of any import", () => {
    const ref = refFor(`import { a } from "./x";\nconst b = 1;\nexport { b as c };\n`, "./x");
    expect(ref?.reexportedExportNames).toBeUndefined();
  });
});
