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
    tech: "7-pass chain (localBinding, returnTypeBinding, receiverChain, importMatch, receiverDrop, genericInstantiation, globalShortName) + typed locals under Go's scope rules (a statement-declared local is in scope after its statement, block locals end with their block, function-literal parameters with the literal; a local named like an import or a called package-level function is a value, never the package or the function) + call-bound locals and bare call-result heads typed through declared return types (functions and package-level func-valued vars, `sync.OnceValue` included) behind a known-type gate (a package-qualified return type or callee counts only when its import path maps to a project package that declares it; an unqualified return type is placed in its callee's package when that package declares it, and in a file with a dot import types nothing otherwise; a callee qualifier that is neither an import nor a local in scope, a package-level var included, types nothing) + dotted receivers typed hop by hop through struct fields + methods and fields promoted through struct embedding (shallowest depth wins; an opaque or namesake type blocks the walk) + go.mod module-path import mapping (nested modules by longest prefix; the standard library and dependencies map to no project package; an import binds its alias, else a project package's own `package` clause, else the name Go assumes from the path, `/vN` dropped and `go-` and `.vN` cut; cross-package typing needs a go.mod module root, without which an import path is read as a repository directory) + bare calls scoped to the caller's package and dot-imports + build-tag twins (one name declared per `//go:build` / GOOS-GOARCH file variant) narrowed to the file the default build compiles, the indexing host's GOOS/GOARCH standing in for the platform + explicit generic instantiation + Go-only symbol lookups in polyglot repositories. Interfaces are not dispatched (no CHA cone); a method's result types only a call-bound local (`x := v.M()`, read by the method's name alone), never a chained call (`v.M().X()`); a placed return type's members are looked up in its own package alone (a project alias of an external type has none), every other type's package-blind",
  },
  // codegraphSchema 2: bd tea-rags-mcp-ex28m — see typescript/capability.ts.
  // walker 2: bd tea-rags-mcp-e6xx — struct-field facet + method promotion
  // through embedding; indexed Go projects need `--force-enrichments codegraph`.
  versions: { chunking: 1, walker: 2, codegraphSchema: 2 },
};
