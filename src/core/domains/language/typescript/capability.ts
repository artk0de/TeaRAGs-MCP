import type { LanguageCapability } from "../../../contracts/types/language.js";
import { testFiles } from "./test-files.js";

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
  tests: {
    tier: "high",
    detection: "*.test.ts / *.spec.ts",
    tech: "testScopeChunker (describe/it scopes, one addressable chunk per example)",
  },
  testFiles,
  codegraph: {
    tier: "high",
    summary:
      "14-strategy chain (10 tree-sitter + 4 ts.Program/typeChecker) + cone dispatch + typeChecker-backed union-receiver fan-out",
    tech: "14-strategy chain (10 tree-sitter + 4 ts.Program/typeChecker: JSX component resolution, cross-call return-type inference, generics/overload getResolvedSignature, structural typing + interface declaration merging) + ConeDispatch + typeChecker-backed union-receiver fan-out + checker-typed interface receivers dispatched to their implementers through the cone, never matched by short-name uniqueness + every receiver-bearing call the chain declined reaches the typeCheckerFallback regardless of namesake count (bd tea-rags-mcp-05uhs; bare calls still need explicit type arguments or two-plus project namesakes) + out-of-project-receiver precision guards (pre-resolution short-name match, checker-backed declaration-site test covering builtins, default-lib and dependency types, and imported-constant container members on the import-mapping fallback) + local-callee guard (bare calls whose callee is a destructured prop / hook binding) + named function-valued declarators addressable at any scope depth (module-level and nested closures alike, composed under their declaring symbol) + class-property arrows addressable as class members (`request = async () => {}` composing `#` instance / `.` static like a method) + edges restricted to project sources + tsx/tsconfig-paths-aware import mapping",
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
  // a dependency's class) counts as `externalSkipped`, not a miss — and so does
  // an unresolved `this.m()` whose member it declares only there (React's
  // `setState`, the default lib's `hasOwnProperty`).
  // walker 7: bd tea-rags-mcp-05uhs. Every receiver-bearing call the chain
  // declined reaches the `typeCheckerFallback` regardless of namesake count —
  // the t5cji namesake-count gate left single-definition members (and
  // object-literal members with zero namesakes) with no checker answer at all
  // (taxdome A/B: 203 file-only edges + 37 symbol-precise edges recovered).
  // Bare calls still need explicit type arguments or two-plus project
  // namesakes to earn a check.
  // walker 8: bd tea-rags-mcp-nj8i6. The same-file fallbacks are owner-ruled,
  // protecting the receiver traffic 05uhs widened: `typeCheckerReturnType`'s
  // short-name narrowing filters candidates through the evidence guard's
  // owner rule (a same-file type-literal receiver's member no longer lands on
  // an unrelated same-file class's method), `thisMember`'s same-file fallback
  // accepts only the enclosing class or a file-anchored `extends` ancestor
  // (`Form`'s `this.setState` no longer lands on `Panel#setState`), and
  // `thisMember` reads a class-body chunk's `callerSymbolId` so an ambiguous
  // member on `this` in a field initializer resolves to the class's own
  // method.
  // walker 9: bd tea-rags-mcp-pv7ul. The evidence guard gains a POSITIVE
  // structural arm for receivers that construct or produce their type —
  // `new ImportedClass().m()` and a `createX()` factory call whose name embeds
  // the type. Checker-off (no Program) those sites were all declines; the
  // candidate is accepted only when the type's own file-anchored definer walk
  // owns it, so the nj8i6 owner-rule corrections hold.
  // walker 10: bd tea-rags-mcp-wr3n4. The owner rule's containment arm extends
  // to the candidate's OWNER: an ownerless declaration (a factory's returned
  // object literal) accounts for a same-file candidate whose enclosing named
  // declaration encloses it, recovering the factory/hook-idiom pins the
  // candidate-lines-only containment downgraded to file-only (33 taxdome + 5
  // self-index sites), while the C12 correction holds — evidence under a
  // different named declaration still declines.
  // walker 11: bd tea-rags-mcp-4pa9o. `importNarrowedFallback` narrows through
  // a barrel: when the call's receiver head is a name an import binds, the
  // binding's re-export origin joins the candidate-file set, so constructed
  // receivers imported via `sync/index.js`-style barrels no longer sit in
  // `dynamic:missWithInProjectDef`. The hop is the shared
  // `reexportOriginFile` with its own ambiguity bounds; receivers no import
  // binds are unchanged, as are `selectTableDef`, `resolveCandidateName`,
  // `receiverSymbol` and the cone locator's import narrowing.
  // walker 12: bd tea-rags-mcp-v0207. The owner rule gains the
  // annotated-factory hop: a member the checker declares on a same-file
  // interface / type alias accounts for a candidate whose owner is a
  // top-level factory annotated to return that type (bare or `Promise<…>`),
  // recovering the `createAppContext(): Promise<AppContext>` pins walker 10's
  // containment arm left file-only. Classes, cross-file types and
  // un-annotated factories still decline.
  // walker 14: bd tea-rags-mcp-jwjyr.1. The walker records the DECLARED
  // visibility on `ChunkExtraction.visibility` — a class member's declared access level (`private` / `protected` / `#name`) — persisted in
  // `cg_symbols.visibility`. Needs `--force-enrichments codegraph` to fill.
  // walker 15: bd tea-rags-mcp-g7h1y. A `.call` / `.apply` / `.bind` the walker
  // unwraps carries the literal invoker as `functionInvokerSite`, and the
  // resolver keeps the member edge (`QdrantConnection#call`) when the receiver's
  // declared type declares that member. Function receivers unwrap as before.
  // walker 15: bd tea-rags-mcp-4p3sb.4 — the walker publishes
  // `identifierDeclarations` (params, locals, class fields; annotation and
  // `new X()` types) for the naming lexicon. Rows written by walker 14 carry
  // none, so only the recompute adds them.
  // walker 17: the naming-lexicon branch (4p3sb.4 as 15, 4p3sb.16 as 16 there)
  // merged with g7h1y (15 here); neither parent's index holds both.
  // walker 18: bd tea-rags-mcp-4p3sb.21 — `identifierDeclarations` carries each
  // function's return annotation as a `return` (an async `Promise<T>` as `T`),
  // so a walker-17 index has no return row for call-return to join.
  // walker 16: bd tea-rags-mcp-r8hme.2. Every module reference records the
  // export names it takes (`importedExportNames`) and every source re-export
  // the names it forwards (`reexportedExportNames`), persisted on the file edge
  // (migration 030) for the facade check. No edge moves; the names fill only on
  // `--force-enrichments codegraph`.
  // walker 19: the naming-lexicon branch (walker 18 there) rebased onto
  // integration walker 16; neither side's index holds both extractions.
  // walker 12: release v1.44.2 shipped walker 11 and a release cycle gets ONE
  // walker bump, so every branch-local number above collapses into 12.
  versions: { chunking: 1, walker: 12, codegraphSchema: 2 },
  // Google TypeScript Style Guide: classes, interfaces, types and enums
  // UpperCamelCase; functions, methods, parameters, locals and properties
  // lowerCamelCase; a namespace-like module binding lowerCamelCase or
  // UpperCamelCase; a global constant lowerCamelCase or CONSTANT_CASE.
  naming: {
    casing: {
      type: ["pascal"],
      module: ["camel", "pascal"],
      method: ["camel"],
      param: ["camel"],
      local: ["camel"],
      field: ["camel"],
      constant: ["camel", "screamingSnake"],
    },
    // Primitives, top types, boxed wrappers, and the containers / utility types
    // (`Promise`, `Record`, `Partial` …) that wrap a concept rather than name one.
    nonConceptTypes: [
      "string",
      "number",
      "boolean",
      "bigint",
      "symbol",
      "unknown",
      "any",
      "object",
      "void",
      "never",
      "undefined",
      "null",
      "String",
      "Number",
      "Boolean",
      "Object",
      "Function",
      "Array",
      "ReadonlyArray",
      "Map",
      "Set",
      "Promise",
      "Record",
      "Partial",
      "Required",
      "Readonly",
      "Pick",
      "Omit",
      "ReadonlySet",
      "ReadonlyMap",
      "WeakMap",
      "WeakSet",
      "WeakRef",
      "Iterable",
      "IterableIterator",
      "AsyncIterable",
      "AsyncIterableIterator",
      "Iterator",
      "AsyncIterator",
      "Generator",
      "AsyncGenerator",
      "PromiseLike",
      "ArrayLike",
      "NonNullable",
      "Awaited",
      "ReturnType",
      "Parameters",
      "InstanceType",
      "Exclude",
      "Extract",
    ],
  },
};
