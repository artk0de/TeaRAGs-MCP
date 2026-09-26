import type { LanguageCapability } from "../../../contracts/types/language.js";
import { testFiles } from "./test-files.js";

export const capability: LanguageCapability = {
  language: "java",
  ast: { tier: "full", engine: "tree-sitter", grammarPackage: "tree-sitter-java" },
  tests: { tier: "medium", detection: "*Test.java / *IT.java", tech: "generic AST" },
  testFiles,
  codegraph: { tier: "moderate", tech: "6-strategy + java.lang stdlib whitelist + overload disambiguation" },
  // codegraphSchema 2: bd tea-rags-mcp-ex28m — see typescript/capability.ts.
  // walker 2: bd tea-rags-mcp-f11nz — innermost-chunk call attribution. Every
  // in-method call used to be emitted a second time from its enclosing class
  // chunk; commons-lang measured 17,641 sites collapsing to 8,719, so an already
  // indexed Java project carries duplicate call rows until it recomputes.
  // walker 4: bd tea-rags-mcp-jwjyr.1. The walker records the DECLARED
  // visibility on `ChunkExtraction.visibility` — `private` / `protected` / `public` (package-private unrecorded) — persisted in
  // `cg_symbols.visibility`. Needs `--force-enrichments codegraph` to fill.
  // walker 5: bd tea-rags-mcp-ezm9o. The test-file classifier matches
  // `*Test.java` / `*IT.java` case-sensitively, so `Latest.java` / `Audit.java`
  // enter the graph they were excluded from, and lose `skippedAs: "test"`.
  // `payload.isTest` moves too but is chunker-owned static payload, which only
  // `--force` rewrites; not bumping `chunking` for a false-positive repair.
  // walker 6: bd tea-rags-mcp-4p3sb.6 — the walker publishes
  // `identifierDeclarations` (params, locals, fields; annotation and `new X()`
  // types) for the naming lexicon. Rows written by walker 5 carry none, so only
  // the recompute adds them.
  // walker 8: bd tea-rags-mcp-4p3sb.17 — an `identifierDeclarations` annotation
  // of `List / Set / Collection / Iterable / Optional / Stream<T>` names its
  // element, so a walker-7 row types `docs` as `List`.
  // walker 9: bd tea-rags-mcp-4p3sb.21 — `identifierDeclarations` carries each
  // method's declared return type as a `return`, so a walker-8 index has no
  // return row for call-return to join.
  // walker 3: release v1.44.2 shipped walker 2 and a release cycle gets ONE
  // walker bump, so every branch-local number above collapses into 3.
  versions: { chunking: 1, walker: 3, codegraphSchema: 2 },
  // Google Java Style / Oracle conventions: classes and interfaces
  // UpperCamelCase, methods / parameters / locals / non-constant fields
  // lowerCamelCase, `static final` constants CONSTANT_CASE. A package name is
  // all-lowercase dotted words without underscores; `snake` is the nearest
  // casing (a single lowercase word classifies as it).
  naming: {
    casing: {
      type: ["pascal"],
      module: ["snake"],
      method: ["camel"],
      param: ["camel"],
      local: ["camel"],
      field: ["camel"],
      constant: ["screamingSnake"],
    },
    // Primitives, their boxes, `Object`, `var`; maps keep their head through
    // collection unwrapping, so the map heads are listed too.
    nonConceptTypes: [
      "String",
      "int",
      "long",
      "short",
      "byte",
      "char",
      "float",
      "double",
      "boolean",
      "void",
      "var",
      "Object",
      "Integer",
      "Long",
      "Short",
      "Byte",
      "Character",
      "Float",
      "Double",
      "Boolean",
      "Void",
      "Map",
      "HashMap",
    ],
  },
};
