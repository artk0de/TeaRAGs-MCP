import type { LanguageCapability } from "../../../contracts/types/language.js";
import { testFiles } from "./test-files.js";

export const capability: LanguageCapability = {
  language: "objc",
  languageVersion: {
    policy: "grammar-bounded",
    evidence: "tests/core/domains/language/capability/version-policy.test.ts",
    limitations:
      "Installed grammar and project fixtures bound Objective-C syntax; no Apple SDK or compiler release range certified. `.h` stays classified as C. Selectors are addressed by their first keyword.",
  },
  ast: { tier: "full", engine: "tree-sitter", grammarPackage: "tree-sitter-objc" },
  tests: { tier: "medium", detection: "*Test.m / *Tests.m", tech: "generic AST" },
  testFiles,
  codegraph: {
    tier: "minimal",
    tech: "same-file [self selector] instance methods; no cross-receiver or class-method resolution",
    symbolKindRoles: {
      callee: new Set(["class", "function", "method"]),
      receiver: new Set(["class", "interface", "function", "method"]),
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
      constant: ["pascal", "screamingSnake"],
    },
    nonConceptTypes: [
      "id",
      "instancetype",
      "Class",
      "SEL",
      "BOOL",
      "void",
      "int",
      "long",
      "short",
      "char",
      "float",
      "double",
      "NSInteger",
      "NSUInteger",
      "CGFloat",
    ],
  },
};
