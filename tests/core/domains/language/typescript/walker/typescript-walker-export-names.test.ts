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
