import type { LanguageCapability } from "../../../contracts/types/language.js";

export const capability: LanguageCapability = {
  language: "typescript",
  ast: {
    tier: "full",
    engine: "tree-sitter",
    grammarPackage: "tree-sitter-typescript",
    hooks: [
      { name: "commentCapture", short: "comment attachment" },
      { name: "bodyChunker", short: "method-body splitting" },
      { name: "testScopeChunker", short: "describe/it scopes" },
    ],
  },
  tests: { tier: "high", detection: "*.test.ts / *.spec.ts", tech: "testScopeChunker (describe/it scopes)" },
  codegraph: {
    tier: "high",
    tech: "14-strategy chain (10 tree-sitter + 4 ts.Program/typeChecker: JSX component resolution, cross-call return-type inference, generics/overload getResolvedSignature, structural typing + interface declaration merging) + ConeDispatch + typeChecker-backed union-receiver fan-out + out-of-project-receiver precision guards (pre-resolution short-name match, checker-backed declaration-site test covering builtins, default-lib and dependency types, and imported-constant container members on the import-mapping fallback) + local-callee guard (bare calls whose callee is a destructured prop / hook binding) + named function-valued declarators addressable at any scope depth (module-level and nested closures alike, composed under their declaring symbol) + class-property arrows addressable as class members (`request = async () => {}` composing `#` instance / `.` static like a method) + edges restricted to project sources + tsx/tsconfig-paths-aware import mapping",
  },
  // walker 2: the TS-resolver oracle wave. Every index built before it carries
  // old-resolver edges, and no payload KEY moved, so `SchemaDriftMonitor` sees
  // nothing — this bump is what makes the hint fire on those indexes.
  versions: { chunking: 1, walker: 2, codegraphSchema: 1 },
};
