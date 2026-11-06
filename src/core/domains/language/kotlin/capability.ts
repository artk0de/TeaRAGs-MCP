import type { LanguageCapability } from "../../../contracts/types/language.js";
import { testFiles } from "./test-files.js";

export const capability: LanguageCapability = {
  language: "kotlin",
  languageVersion: {
    policy: "grammar-bounded",
    evidence: "tests/core/domains/language/capability/version-policy.test.ts",
    limitations:
      "Installed grammar and project fixtures bound Kotlin syntax; no Kotlin release range or compiler conformance certified",
  },
  ast: { tier: "full", engine: "tree-sitter", grammarPackage: "@tree-sitter-grammars/tree-sitter-kotlin" },
  tests: {
    tier: "medium",
    detection: "*Test.kt",
    tech: "generic AST",
  },
  testFiles,
  codegraph: {
    tier: "moderate",
    tech: "same-file chain and import file edges; no global short-name or extension-receiver resolution",
    symbolKindRoles: {
      callee: new Set(["function", "method"]),
      receiver: new Set(["class", "interface", "enum", "function", "method"]),
    },
  },
  versions: { chunking: 1, walker: 1, codegraphSchema: 2 },
  naming: {
    casing: {
      type: ["pascal"],
      module: ["snake"],
      method: ["camel"],
      param: ["camel"],
      local: ["camel"],
      field: ["camel"],
      constant: ["screamingSnake"],
    },
    implicitSelf: true,
    nonConceptTypes: [
      "String",
      "Int",
      "Long",
      "Short",
      "Byte",
      "Char",
      "Float",
      "Double",
      "Boolean",
      "Unit",
      "Any",
      "Nothing",
      "List",
      "Set",
      "Map",
      "MutableList",
      "MutableSet",
      "MutableMap",
      "Array",
    ],
  },
};
