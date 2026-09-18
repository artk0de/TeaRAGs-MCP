import type { LanguageCapability } from "../../../contracts/types/language.js";

export const capability: LanguageCapability = {
  language: "javascript",
  ast: {
    tier: "full",
    engine: "tree-sitter",
    grammarPackage: "tree-sitter-javascript",
    hooks: [
      { name: "jsAssignmentFilter", short: "assignment chunking" },
      { name: "JsChunkClassifier", short: "module/class split" },
    ],
  },
  tests: { tier: "high", detection: "*.test.js / *.spec.jsx", tech: "testScopeChunker (describe/it scopes)" },
  codegraph: { tier: "high", tech: "6-strategy; CommonJS/ESM require resolution (dynamic gaps)" },
  // codegraphSchema 2: bd tea-rags-mcp-ex28m — see typescript/capability.ts.
  // walker 2: bd tea-rags-mcp-hwwtw — receiver-bearing calls no longer fall
  // through to the global short-name lookup.
  // walker 3: bd tea-rags-mcp-x9qsh — a `.ts` / `.tsx` / `.mts` / `.cts` /
  // `.json` specifier maps to that file instead of `<file>.ts.js`, and file
  // edges come from the import mapper instead of the call path, which dropped
  // every explicit-extension import (`./lib/render-changelog.js`). Also bd
  // tea-rags-mcp-t5cji (same unreleased bump): lookups are restricted to
  // TypeScript / JavaScript files, so the bare-call fallback and `super` no
  // longer land on a Ruby or Python namesake, and such a call counts as
  // `noInProjectDef`.
  versions: { chunking: 1, walker: 3, codegraphSchema: 2 },
};
