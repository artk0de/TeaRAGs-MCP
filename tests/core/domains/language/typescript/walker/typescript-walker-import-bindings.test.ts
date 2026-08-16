import Parser from "tree-sitter";
import TsLang from "tree-sitter-typescript";
import { describe, expect, it } from "vitest";

import { extractFromTypescriptFile } from "../../../../../../src/core/domains/language/typescript/walker/walker.js";

function parse(code: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage((TsLang as { typescript: Parser.Language }).typescript);
  return parser.parse(code);
}

function extract(code: string): ReturnType<typeof extractFromTypescriptFile> {
  return extractFromTypescriptFile({
    tree: parse(code),
    code,
    relPath: "src/a.ts",
    language: "typescript",
    chunks: [],
  });
}

/**
 * bd tea-rags-mcp-w65s7 — `importedNames` records only the LOCAL binding, so an
 * aliased specifier lost the name the module actually exports and a bare call
 * on the alias had nothing to look up. `importedBindings` carries the local →
 * exported map the resolver needs, across all three shapes that introduce one.
 */
describe("extractFromTypescriptFile — importedBindings (bd tea-rags-mcp-w65s7)", () => {
  describe("ESM named specifiers", () => {
    it("maps an aliased specifier's LOCAL name to the name the module exports", () => {
      const ref = extract(`import { create as createAction } from "./repo";\n`).imports.find(
        (i) => i.importText === "./repo",
      );
      expect(ref?.importedBindings).toEqual({ createAction: "create" });
    });

    it("maps a plain specifier to itself, so the binding table is complete", () => {
      const ref = extract(`import { create, destroy } from "./repo";\n`).imports.find((i) => i.importText === "./repo");
      expect(ref?.importedBindings).toEqual({ create: "create", destroy: "destroy" });
    });

    it("omits the default and namespace bindings — neither names an exported member", () => {
      const extraction = extract(`import Foo from "./foo";\nimport * as ns from "./ns";\n`);
      expect(extraction.imports.find((i) => i.importText === "./foo")?.importedBindings).toBeUndefined();
      expect(extraction.imports.find((i) => i.importText === "./ns")?.importedBindings).toBeUndefined();
      // The local-name channel is unchanged — only the origin map declines them.
      expect(extraction.imports.find((i) => i.importText === "./foo")?.importedNames).toEqual(["Foo"]);
      expect(extraction.imports.find((i) => i.importText === "./ns")?.importedNames).toEqual(["ns"]);
    });
  });

  describe("dynamic import destructure", () => {
    it("records the awaited dynamic import as a module dependency with its destructured bindings", () => {
      const code = `async function f() {\n  const { parseAppConfig, getZodConfig: gz } = await import("../config/index.js");\n}\n`;
      const ref = extract(code).imports.find((i) => i.importText === "../config/index.js");
      expect(ref?.importedBindings).toEqual({ parseAppConfig: "parseAppConfig", gz: "getZodConfig" });
      expect(ref?.importedNames).toEqual(["parseAppConfig", "gz"]);
    });

    it("records a non-awaited dynamic import the same way", () => {
      const ref = extract(`const { plain } = import("./x.js");\n`).imports.find((i) => i.importText === "./x.js");
      expect(ref?.importedBindings).toEqual({ plain: "plain" });
    });

    it("records a dynamic import bound to a whole-module identifier with no member map", () => {
      const ref = extract(`async function f() {\n  const mod = await import("./y.js");\n}\n`).imports.find(
        (i) => i.importText === "./y.js",
      );
      expect(ref?.importedNames).toEqual(["mod"]);
      expect(ref?.importedBindings).toBeUndefined();
    });

    it("records a bare dynamic import that binds nothing", () => {
      const ref = extract(`async function f() {\n  await import("./side-effect.js");\n}\n`).imports.find(
        (i) => i.importText === "./side-effect.js",
      );
      expect(ref).toBeDefined();
      expect(ref?.importedNames).toBeUndefined();
    });

    it("ignores a dynamic import whose specifier is not a literal", () => {
      const extraction = extract(`async function f(p: string) {\n  const m = await import(p);\n}\n`);
      expect(extraction.imports).toEqual([]);
    });

    // Same erasure rule as `import type { X }` (bd tea-rags-mcp-m19a): the
    // grammar gives a type-position `import()` the same call_expression node,
    // and counting it would inflate fanOut for a module never loaded.
    it("ignores a type-position import() — it is erased, so it loads nothing", () => {
      const code = [
        `let a: import("./ann").Foo;`,
        `type B = Array<import("./args").Bar>;`,
        `type C = typeof import("./query");`,
        `const d = w as import("./cast").T;`,
      ].join("\n");
      expect(extract(code).imports).toEqual([]);
    });

    it("still records a runtime import cast to a type", () => {
      const code = `async function f() {\n  const m = (await import("./real.js")) as Facade;\n}\n`;
      expect(extract(code).imports.map((i) => i.importText)).toEqual(["./real.js"]);
    });
  });

  describe("require destructure", () => {
    it("maps a renamed CJS destructure to the exported name", () => {
      const ref = extract(`const { create: mk } = require("./repo");\n`).imports.find((i) => i.importText === "./repo");
      expect(ref?.importedBindings).toEqual({ mk: "create" });
    });
  });

  describe("namespace member destructure", () => {
    it("attributes a member destructured off an imported namespace to that namespace's module", () => {
      const code = `import { DirectoryHelper } from "./DirectoryHelper";\nconst { pathIds } = DirectoryHelper;\n`;
      const ref = extract(code).imports.find((i) => i.importText === "./DirectoryHelper");
      expect(ref?.importedBindings).toEqual({ DirectoryHelper: "DirectoryHelper", pathIds: "pathIds" });
      // NOT added to importedNames: that channel drives receiver matching and
      // the dispatch-table gate, and a destructured member is neither.
      expect(ref?.importedNames).toEqual(["DirectoryHelper"]);
    });

    it("leaves a destructure off a local object alone", () => {
      const code = `import { Other } from "./other";\nconst local = { pathIds: 1 };\nconst { pathIds } = local;\n`;
      const ref = extract(code).imports.find((i) => i.importText === "./other");
      expect(ref?.importedBindings).toEqual({ Other: "Other" });
    });
  });
});
