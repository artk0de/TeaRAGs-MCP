/**
 * bd tea-rags-mcp-r8hme.2 — the JavaScript walker records the names a module
 * reference takes from its target's export surface, in the same shape as the
 * TypeScript walker: the exported spelling, `default` for a default import,
 * `*` for the whole module.
 */
import Parser from "tree-sitter";
import JsLang from "tree-sitter-javascript";
import { describe, expect, it } from "vitest";

import { extractFromJavascriptFile } from "../../../../../../src/core/domains/language/javascript/walker/walker.js";

function refFor(code: string, importText: string) {
  const parser = new Parser();
  parser.setLanguage(JsLang);
  return extractFromJavascriptFile({
    tree: parser.parse(code),
    code,
    relPath: "src/a.js",
    language: "javascript",
    chunks: [],
  }).imports.find((i) => i.importText === importText);
}

describe("extractFromJavascriptFile — importedExportNames", () => {
  it("records named specifiers by their exported name", () => {
    expect(refFor(`import { a as b, c } from './m';\n`, "./m")?.importedExportNames).toEqual(["a", "c"]);
  });

  it("records `default` and `*` for default and namespace imports", () => {
    expect(refFor(`import D from './d';\n`, "./d")?.importedExportNames).toEqual(["default"]);
    expect(refFor(`import * as ns from './ns';\n`, "./ns")?.importedExportNames).toEqual(["*"]);
  });

  it("records destructured require members and `*` for a whole-module require", () => {
    expect(refFor(`const { x } = require('./cjs');\n`, "./cjs")?.importedExportNames).toEqual(["x"]);
    expect(refFor(`const all = require('./all');\n`, "./all")?.importedExportNames).toEqual(["*"]);
  });

  it("records nothing for a bare side-effect import", () => {
    expect(refFor(`import './side';\n`, "./side")?.importedExportNames).toBeUndefined();
  });
});
