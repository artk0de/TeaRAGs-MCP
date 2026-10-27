import type { LanguageCapability } from "../../../contracts/types/language.js";

export const capability: LanguageCapability = {
  language: "yaml",
  languageVersion: {
    policy: "unversioned",
    evidence: "tests/core/domains/language/capability/version-policy.test.ts",
    limitations:
      "the `yaml` package's YAML 1.2 parser; files that are not one mapping document are cut into line windows",
  },
  ast: { tier: "full", engine: "YAML key-path sections" },
  tests: { tier: "na", detection: "doc-only", tech: "—" },
  codegraph: {
    tier: "none",
    tech: "no call graph",
    symbolKindRoles: {
      callee: new Set([]),
      receiver: new Set([]),
    },
  },
  // No grammarPackage: the `yaml` package parses without a tree-sitter grammar.
  // `walker` / `codegraphSchema` are declared and never move — same reason as
  // markdown's capability.
  versions: { chunking: 1, walker: 1, codegraphSchema: 1 },
  notes:
    "Doc-only: config YAML cut along key paths (top-level keys, then second-level keys of an oversized map), each section a navigable doc id. Only config/ and .github/ YAML is indexed by default; locales stay ignored. No code symbols, so no call graph.",
};
