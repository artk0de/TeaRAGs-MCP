import type { LanguageCapability } from "../../../contracts/types/language.js";
import { testFiles } from "./test-files.js";

export const capability: LanguageCapability = {
  language: "php",
  languageVersion: {
    policy: "grammar-bounded",
    evidence: "tests/core/domains/language/capability/version-policy.test.ts",
    limitations:
      "Installed php_only grammar and project fixtures bound PHP syntax; no PHP release range or runtime conformance certified",
  },
  ast: { tier: "full", engine: "tree-sitter", grammarPackage: "tree-sitter-php" },
  tests: { tier: "medium", detection: "*Test.php", tech: "generic AST" },
  testFiles,
  codegraph: {
    tier: "moderate",
    tech: "same-file $this members, typed locals, same-file and imported scoped calls, same-file functions, unique global functions, use-to-file edges",
    symbolKindRoles: {
      callee: new Set(["function", "method"]),
      receiver: new Set(["class", "interface"]),
    },
  },
  versions: { chunking: 1, walker: 1, codegraphSchema: 2 },
  naming: {
    casing: {
      type: ["pascal"],
      module: ["pascal"],
      method: ["camel"],
      param: ["camel"],
      local: ["camel"],
      field: ["camel"],
      constant: ["screamingSnake"],
    },
    nonConceptTypes: [
      "string",
      "int",
      "float",
      "bool",
      "array",
      "object",
      "mixed",
      "void",
      "null",
      "never",
      "iterable",
      "callable",
      "self",
      "static",
      "parent",
      "true",
      "false",
    ],
  },
};
