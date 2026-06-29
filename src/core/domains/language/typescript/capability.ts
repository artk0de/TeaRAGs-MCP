import type { LanguageCapability } from "../../../contracts/types/language.js";

export const capability: LanguageCapability = {
  language: "typescript",
  ast: { tier: "full", engine: "tree-sitter", hooks: ["commentCapture", "bodyChunker", "testScopeChunker"] },
  tests: { tier: "high", detection: "*.test.ts / *.spec.ts", tech: "testScopeChunker (describe/it scopes)" },
  codegraph: { tier: "high", tech: "8-strategy chain + ConeDispatch" },
};
