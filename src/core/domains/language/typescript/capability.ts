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
    summary:
      "14-strategy chain (10 tree-sitter + 4 ts.Program/typeChecker) + cone dispatch + typeChecker-backed union-receiver fan-out",
    tech: "14-strategy chain (10 tree-sitter + 4 ts.Program/typeChecker: JSX component resolution, cross-call return-type inference, generics/overload getResolvedSignature, structural typing + interface declaration merging) + ConeDispatch + typeChecker-backed union-receiver fan-out + checker-typed interface receivers dispatched to their implementers through the cone, never matched by short-name uniqueness + out-of-project-receiver precision guards (pre-resolution short-name match, checker-backed declaration-site test covering builtins, default-lib and dependency types, and imported-constant container members on the import-mapping fallback) + local-callee guard (bare calls whose callee is a destructured prop / hook binding) + named function-valued declarators addressable at any scope depth (module-level and nested closures alike, composed under their declaring symbol) + class-property arrows addressable as class members (`request = async () => {}` composing `#` instance / `.` static like a method) + edges restricted to project sources + tsx/tsconfig-paths-aware import mapping",
  },
  // walker 2: the TS-resolver oracle wave. Every index built before it carries
  // old-resolver edges, and no payload KEY moved, so `SchemaDriftMonitor` sees
  // nothing — this bump is what makes the hint fire on those indexes.
  // codegraphSchema 2: bd tea-rags-mcp-ex28m. The method-edge primary key was
  // missing `source_rel_path`, so two namesake files calling the same target
  // through the same expression collapsed to ONE row under `INSERT OR IGNORE`.
  // Migration 020 widens the key, but the rows it already discarded are not on
  // disk — only re-extraction regenerates them.
  // walker 5: bd tea-rags-mcp-hwwtw. Interface-typed receivers the walker binds
  // no type to now dispatch through the CHA cone off the checker's declared
  // interface, and `globalShortName` no longer answers them by name uniqueness.
  // walker 6: bd tea-rags-mcp-x9qsh. `.mts` / `.cts` specifiers map to the file
  // as written and `.mjs` / `.cjs` to their `.mts` / `.cts` source, where both
  // used to get `.ts` appended and land on a path no file row matches; under
  // `allowJs` a `.js`-family specifier with no TypeScript source falls back to
  // the JavaScript file the probe confirms, and so does an extensionless
  // specifier (`./legacy` → `legacy.js`, `./widgets` → `widgets/index.js`);
  // import basename matching strips `.mts` / `.cts` and their declarations.
  // Same bump, bd tea-rags-mcp-unt4v: an ASSET import — the as-written path is
  // an existing file no source candidate named (a CSS module, an image, a JSON
  // module) — maps to nothing instead of `<asset>.ts`, so it has no file edge
  // and a call on its binding is external; a JSON module the probe cannot find
  // maps as written. Also bd
  // tea-rags-mcp-t5cji (same unreleased bump): every symbol-table lookup is
  // restricted to TypeScript / JavaScript files, so no edge lands on a Ruby or
  // Python namesake, a foreign namesake no longer suppresses a TS answer (super,
  // cone, barrel hop, cardinality gates), and a bare call whose only namesake is
  // foreign counts as `noInProjectDef`. And (same bump) a member call on a
  // receiver the walker did not type (`this` included) is committed by
  // `globalShortName` / `importNarrowedFallback` only when the checker's
  // declaration of the member is the candidate's own or a supertype's — with no
  // Program, only when an import binding's module declares it, or for `this`
  // when its nearest definer up the file-anchored `extends` chain does — never
  // by a unique short name alone. And an unresolved `super`
  // call whose base the checker declares outside the project (`extends Error`,
  // a dependency's class) counts as `externalSkipped`, not a miss.
  versions: { chunking: 1, walker: 6, codegraphSchema: 2 },
};
