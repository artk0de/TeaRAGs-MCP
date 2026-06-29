import type { LanguageCapability } from "../../../contracts/types/language.js";

export const capability: LanguageCapability = {
  language: "javascript",
  ast: { tier: "full", engine: "tree-sitter", hooks: ["jsAssignmentFilter", "JsChunkClassifier"] },
  tests: { tier: "high", detection: "*.test.js / *.spec.jsx", tech: "testScopeChunker (describe/it scopes)" },
  codegraph: { tier: "high", tech: "6-strategy; CommonJS/ESM require resolution (dynamic gaps)" },
};
