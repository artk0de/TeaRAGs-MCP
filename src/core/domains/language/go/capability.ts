import type { LanguageCapability } from "../../../contracts/types/language.js";

export const capability: LanguageCapability = {
  language: "go",
  ast: {
    tier: "full",
    engine: "tree-sitter",
    grammarPackage: "tree-sitter-go",
    hooks: [{ name: "GoChunkClassifier", short: "func/type split" }],
  },
  tests: { tier: "medium", detection: "*_test.go", tech: "generic AST" },
  codegraph: {
    tier: "moderate",
    summary:
      "7-pass chain + scope-aware typed locals + struct-field chains + embedding promotion + go.mod module-path imports; no interface dispatch",
    tech: "7-pass chain (localBinding, returnTypeBinding, receiverChain, importMatch, receiverDrop, genericInstantiation, globalShortName) + typed locals under Go's scope rules (a statement-declared local is in scope after its statement, block locals end with their block, function-literal parameters with the literal; a local named like an import or a called package-level function is a value, never the package or the function) + call-bound locals and bare call-result heads typed through declared return types (functions and package-level func-valued vars, `sync.OnceValue` included) behind a known-type gate + dotted receivers typed hop by hop through struct fields + methods and fields promoted through struct embedding (shallowest depth wins; an opaque or namesake type blocks the walk) + go.mod module-path import mapping (nested modules by longest prefix; the standard library and dependencies map to no project package) + bare calls scoped to the caller's package and dot-imports + build-tag twins (one name declared per `//go:build` / GOOS-GOARCH file variant) narrowed to the file the default build compiles, the indexing host's GOOS/GOARCH standing in for the platform + explicit generic instantiation + Go-only symbol lookups in polyglot repositories. Interfaces are not dispatched (no CHA cone), a method call's result types nothing, and type lookup is package-blind",
  },
  // codegraphSchema 2: bd tea-rags-mcp-ex28m — see typescript/capability.ts.
  // walker 2: bd tea-rags-mcp-e6xx — struct-field facet + method promotion
  // through embedding; indexed Go projects need `--force-enrichments codegraph`.
  versions: { chunking: 1, walker: 2, codegraphSchema: 2 },
};
