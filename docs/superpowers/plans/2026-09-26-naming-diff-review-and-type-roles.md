# Naming Review over a Diff, Type Roles and Term Alignment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use dinopowers:executing-plans
> (wraps superpowers:executing-plans) to implement this plan task-by-task. Steps
> use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `get_naming_lexicon` judges type, module and constant names by the
project's roles and terms, and reviews the declarations a diff introduces.

**Architecture:** Walkers tag each chunk with a symbol kind that is persisted in
`cg_symbols.symbol_kind`. Type roles and the modifier vocabulary are derived at
read time from `cg_symbols` + `cg_symbols_inheritance` through one daemon op,
and judged by pure functions in `domains/explore/naming-lexicon`. Diff mode
extracts drafts from changed files in memory and judges them with the same
functions, with the changed files excluded from every evidence read.

**Tech Stack:** TypeScript, tree-sitter walkers, DuckDB (daemon ops), Vitest,
zod MCP schemas, git CLI adapter.

**Spec:**
`docs/superpowers/specs/2026-09-26-naming-diff-review-and-type-roles-design.md`
(beads `tea-rags-mcp-vi0wx`, `tea-rags-mcp-fdef2`).

## Global Constraints

- TDD: every behavioural change starts with a failing test.
- Business-logic test expectations are immutable. An intentional invariant
  change goes red-first and names its reason in the commit body.
- No `eslint-disable`, never lower a coverage or schema-byte budget.
- Walker axes are already above `main` for every language this release cycle. Do
  not bump; run `npm run pin:lang-versions` when the pin test demands it.
- Symbol kind values:
  `class | module | interface | enum | type_alias | constant | function | method`.
  `NULL` on pre-migration rows = unknown, excluded from type-name judgement.
- Role evidence order: inheritance family > directory (share ≥ 0.2) > project
  suffix (≥ k types, k = 3, in ≥ 2 directories).
- Term alignment always attempts a concept search. Nothing above the lift floor
  → NEW_TERM with no alternatives. Alignment verdicts are never MISFIT.
- Diff mode: cap 200 changed files per call; the changed files are excluded from
  every evidence read (`excludePaths`).
- Commit messages: English, conventional type(scope), header ≤ 100 chars, ending
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Integration tests fork the compiled daemon: `npm run build` before running
  them after any protocol or store change.

## Impact signals (tea-rags blastRadius, 2026-09-26)

| File                                                                               | Signal               | Consequence                                               |
| ---------------------------------------------------------------------------------- | -------------------- | --------------------------------------------------------- |
| `contracts/types/codegraph-symbols.ts` (`SymbolDefinition`)                        | transitiveImpact 299 | additive optional field only, own task (T1)               |
| `language/typescript/walker/walker.ts`                                             | transitiveImpact 51  | TS kind tagging in its own task (T2-ts)                   |
| `trajectory/codegraph/symbols/node-flush.ts`, `explore/naming-lexicon/verdicts.ts` | transitiveImpact 45  | verdict changes isolated in T5                            |
| `adapters/vcs/git/git-cli/client.ts`                                               | transitiveImpact 44  | new methods only, no signature change (T6)                |
| `adapters/duckdb/client.ts`, `daemon/client.ts`                                    | 54 / 45 commits      | new ops only, pattern of `readOntologyReportSummary` (T4) |

All files are owned by artk0de; no silo pairing needed.

## Parallelism

| Wave | Tasks                                                         | Runs in parallel because                                                                                          |
| ---- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 1    | T1, T3, T6                                                    | disjoint: contracts+migration+symbol store / pure explore functions / git adapter + language in-memory extraction |
| 2    | T2-ts, T2-py, T2-rb, T2-go, T2-rs, T2-java, T2-swift, T2-bash | one directory per language; all consume T1's `ChunkExtraction.symbolKind`                                         |
| 3    | T4                                                            | store + daemon op; needs T1's column                                                                              |
| 4    | T5                                                            | ops + verdicts + DTO; needs T3, T4 and the concurrent lexicon-verdict agent landed                                |
| 5    | T7                                                            | diff mode ops; needs T5 and T6                                                                                    |
| 6    | T8, T9                                                        | plugin docs, then gates + live                                                                                    |

Wave 2 languages each re-pin versions; run `npm run pin:lang-versions` once
after the whole wave, not per agent, to avoid pin-file conflicts.

### Waves added after W2 (spec §1a, §1b — every language at once)

W2 showed that no language can add interface / type alias / enum / constant
declarations as symbols (no chunk of their own, and a same-named symbol broke
short-name resolution). Two tasks were added, both covering all ten languages:

| Wave | Task                                                      | Scope                                                                                                                                                                                                                                            |
| ---- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 3a   | **T4a — kind roles per language** (`jqvbn`, §1a)          | each capability declares `symbolKindRoles`; the table applies the caller's policy; every resolver opts in; A/B tally on one corpus per language, every lost edge classified                                                                      |
| 3b   | **T4b — declaration channel core** (`vi0wx`/`l2pkp`, §1b) | `TypeDeclarationFact` gains `symbolKind` + `line`; Swift adapted; run-state hydration gated to languages whose resolver reads the facts; migration 038 `cg_type_declarations`, flush + delete like `cg_identifiers`; `readTypeNameRows` reads it |
| 3c   | **T4c-<lang> — every walker emits declaration facts**     | per language, table in §1b; one agent per language directory after T4b's contract lands; re-pin once after the wave                                                                                                                              |

T4 (`readTypeNameRows`, commit bb16c19cb) keeps its query contract; T4b only
switches its source. T5 and T7 read type and constant drafts from the facts.

---

### Task 1: Symbol kind contract, migration 035 and symbol store

**Files:**

- Modify: `src/core/contracts/types/codegraph-symbols.ts` (`SymbolDefinition`)
- Modify: `src/core/contracts/types/codegraph-extraction.ts` (`ChunkExtraction`)
- Modify: `src/core/domains/trajectory/codegraph/symbols/symbol-definitions.ts`
  (`symbolDefinitionsOf`)
- Modify: `src/core/adapters/duckdb/cg-symbols-row.ts` (`toCgSymbolsRow`, column
  list, hydration)
- Create:
  `src/core/domains/maintenance/migration/database/migrations/035-cg-symbols-symbol-kind.{sql,ts}`
- Modify: `src/core/domains/maintenance/migration/database/migrations/index.ts`
- Test:
  `tests/core/domains/maintenance/migration/database/035-cg-symbols-symbol-kind.test.ts`,
  `tests/core/adapters/duckdb/symbol-store-symbol-kind.test.ts`,
  `tests/core/domains/trajectory/codegraph/symbols/symbol-definitions.test.ts`

**Interfaces:**

- Produces:

```ts
// codegraph-symbols.ts
export type SymbolDefinitionKind =
  | "class"
  | "module"
  | "interface"
  | "enum"
  | "type_alias"
  | "constant"
  | "function"
  | "method";
// SymbolDefinition gains:
//   /** Declaration kind the walker saw (bd tea-rags-mcp-vi0wx). PERSISTED as
//    *  cg_symbols.symbol_kind (migration 035); absent = unknown. */
//   symbolKind?: SymbolDefinitionKind;
// ChunkExtraction gains the same optional field, set by each walker (Task 2).
```

- [ ] **Step 1: Failing tests.**
  - `symbolDefinitionsOf` threads `symbolKind` from a chunk, and omits it when
    absent.
  - Migration 035 adds a nullable `symbol_kind VARCHAR`; pre-existing rows read
    NULL; it is registered right after 034.
  - `upsertSymbolsBulk` then a hydrating read round-trips `symbolKind: "class"`;
    a def without it hydrates without the field.

```ts
it("threads the walker's symbol kind onto the definition", () => {
  const defs = symbolDefinitionsOf(
    extractionWith([
      { symbolId: "Foo", scope: [], calls: [], symbolKind: "class" },
    ]),
  );
  expect(defs[0].symbolKind).toBe("class");
});
```

- [ ] **Step 2:** Run `npx vitest run <the three test files>`; expect FAIL
      (unknown field / missing column).
- [ ] **Step 3: Implement.**
  - The migration SQL is
    `ALTER TABLE cg_symbols ADD COLUMN IF NOT EXISTS symbol_kind VARCHAR;`,
    following the 034 pattern.
  - `symbolDefinitionsOf` adds
    `...(c.symbolKind ? { symbolKind: c.symbolKind } : {})`, mirroring
    `isAbstractStub`.
  - `toCgSymbolsRow` writes it (NULL when absent), and the hydrating reader maps
    it back.
- [ ] **Step 4:** Tests pass; `npx tsc --noEmit -p tsconfig.json` clean.
- [ ] **Step 5:** Commit
      `feat(migration): cg_symbols records the declaration kind (tea-rags-mcp-vi0wx)`.

### Task 2 (per language, parallel): walkers tag chunks with a symbol kind

One task per language directory: `T2-ts` covers typescript and javascript,
because they share the TS walker's helpers. The others are `T2-py`, `T2-rb`,
`T2-go`, `T2-rs`, `T2-java`, `T2-swift` and `T2-bash`.

**Files (per language `<lang>`):**

- Modify: `src/core/domains/language/<lang>/walker/walker.ts`, the
  chunk/`nameOf` builder that emits `ChunkExtraction`
- Create: `src/core/domains/language/<lang>/walker/symbol-kind.ts`, which maps
  tree-sitter node types to `SymbolDefinitionKind`
- Test: `tests/core/domains/language/<lang>/walker/symbol-kind.test.ts`

**Interfaces:**

- Consumes: `SymbolDefinitionKind`, `ChunkExtraction.symbolKind` (Task 1).
- Produces:
  `symbolKindOf(nodeType: string, context: { atTopLevel: boolean }): SymbolDefinitionKind | undefined`,
  per language.

- [ ] **Step 1: Failing test.** Parse a fixture, run the walker, and assert
      `symbolKind` on each emitted chunk. Minimum cases per language:

| Language   | Fixture → expected                                                                                                                                                               |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| typescript | `class A {}` class; `interface I {}` interface; `enum E {}` enum; `type T = {…}` type_alias; `export const MAX = 3` constant; `function f(){}` function; method in class: method |
| javascript | class, function, method, top-level `const` constant                                                                                                                              |
| python     | `class A:` class; `def f():` function; method; `MAX = 3` at module level constant                                                                                                |
| ruby       | `class A` class; `module M` module; `def f` method; `MAX = 3` constant                                                                                                           |
| go         | `type S struct` class; `type I interface` interface; `func f()` function; method with receiver: method; `const X = 1` constant                                                   |
| rust       | `struct`/`enum` class/enum; `trait` interface; `fn` function; `impl` fn: method; `const`/`static` constant; `type` type_alias                                                    |
| java       | class, interface, enum, method, `static final` field constant                                                                                                                    |
| swift      | class/struct class, protocol interface, enum enum, func function/method, `typealias` type_alias                                                                                  |
| bash       | function only                                                                                                                                                                    |

- [ ] **Step 2:** Run the test; expect FAIL (`symbolKind` undefined).
- [ ] **Step 3: Implement.**
  - Add `symbolKindOf` and set `symbolKind` where the walker builds the chunk
    extraction.
  - **TS only:** type aliases and enums, and every language's top-level
    constants, must become symbols if the walker does not emit a chunk
    extraction for them today. Check first:
    - TS: `collectTypeAliases` documents that aliases are not symbols. Add the
      extraction through the same path class declarations use, and give aliases
      a `symbolId` under `DefaultSymbolIdComposer`.
    - This changes walker output, so re-pin after the wave.
- [ ] **Step 4:** The language's test directory passes, plus
      `tests/core/domains/language/capability` after
      `npm run pin:lang-versions`, which the wave runs once.
- [ ] **Step 5:** Commit
      `feat(trajectory): <lang> walker tags each chunk with its symbol kind (tea-rags-mcp-vi0wx)`.

### Task 3: Pure role, slot and lift functions

**Files:**

- Create: `src/core/domains/explore/naming-lexicon/type-roles.ts`,
  `name-slots.ts`, `term-alignment.ts`
- Modify: `src/core/domains/explore/naming-lexicon/index.ts` (exports)
- Test:
  `tests/core/domains/explore/naming-lexicon/{type-roles,name-slots,term-alignment}.test.ts`

**Interfaces:**

- Produces:

```ts
// type-roles.ts
export interface TypeNameRow {
  symbolId: string;
  relPath: string;
  shortName: string;
  symbolKind: SymbolDefinitionKind;
  ancestors: readonly string[];
}
export type TypeRoleEvidence = "inheritance" | "directory" | "projectSuffix";
export interface TypeRoleAssignment {
  symbolId: string;
  relPath: string;
  role: string;
  evidence: TypeRoleEvidence;
  support: number; // types sharing the role in that family / dir / project
}
export interface TypeRoleThresholds {
  directoryShare: number;
  projectSuffixMinTypes: number;
  projectSuffixMinDirs: number;
}
export const TYPE_ROLE_THRESHOLDS: TypeRoleThresholds = {
  directoryShare: 0.2,
  projectSuffixMinTypes: 3,
  projectSuffixMinDirs: 2,
};
export function deriveTypeRoles(
  rows: readonly TypeNameRow[],
  t?: TypeRoleThresholds,
): TypeRoleAssignment[];
export function expectedRoleFor(
  roles: readonly TypeRoleAssignment[],
  draft: { path: string; extends?: string },
): { role: string; evidence: TypeRoleEvidence; examples: string[] } | undefined;

// name-slots.ts
export interface NameSlots {
  head: string[];
  qualifiers: string[];
} // lower-cased words
export function splitNameSlots(
  name: string,
  knownHeads: ReadonlySet<string>,
): NameSlots;

// term-alignment.ts
export interface ModifierUse {
  word: string;
  heads: ReadonlySet<string>;
  dirs: ReadonlySet<string>;
  count: number;
}
export interface TermAlternative {
  word: string;
  heads: string[];
  domains: string[];
  lift: number;
}
export function establishedModifiers(
  uses: readonly ModifierUse[],
  minHeads?: number,
  minDirs?: number,
): ModifierUse[];
export function modifierLift(
  established: readonly ModifierUse[],
  conceptNames: readonly string[],
  projectTotal: number,
): Map<string, number>;
export function alignQualifiers(
  slots: NameSlots,
  established: readonly ModifierUse[],
  lift: ReadonlyMap<string, number>,
  floor: number,
): TermAlternative[]; // empty = new concept
export function alignHead(
  slots: NameSlots,
  headCounts: ReadonlyMap<string, number>,
): string | undefined; // dominant spelling, e.g. "doc" over "document"
```

- [ ] **Step 1: Failing tests** (exact cases):

```ts
it("inheritance family beats directory", () => {
  const rows = [
    t("TsStrategy", "src/a/ts.ts", ["SymbolResolutionStrategy"]),
    t("PyStrategy", "src/b/py.ts", ["SymbolResolutionStrategy"]),
    t("RubyStrategy", "src/c/rb.ts", ["SymbolResolutionStrategy"]),
    t("Helper", "src/a/helper.ts", []),
  ];
  const roles = deriveTypeRoles(rows);
  expect(
    expectedRoleFor(roles, {
      path: "src/z/new.ts",
      extends: "SymbolResolutionStrategy",
    }),
  ).toMatchObject({ role: "strategy", evidence: "inheritance" });
});
it("a directory role needs share ≥ 0.2", () => {
  /* presets/: 3 of 4 end in Preset → role preset */
});
it("a project suffix needs ≥ 3 types in ≥ 2 dirs", () => {
  /* Store ×3 in 2 dirs → role; ×2 → none */
});
it("splits head and qualifiers by the project's known heads", () => {
  expect(
    splitNameSlots("CalculatedDocument", new Set(["document", "doc"])),
  ).toEqual({ head: ["document"], qualifiers: ["calculated"] });
});
it("aligns the head to the dominant spelling", () => {
  expect(
    alignHead(
      { head: ["document"], qualifiers: [] },
      new Map([
        ["doc", 200],
        ["document", 3],
      ]),
    ),
  ).toBe("doc");
});
it("offers an established modifier with lift above the floor", () => {
  const uses = [
    mod(
      "predefined",
      ["template", "field"],
      ["src/templates", "src/fields"],
      12,
    ),
  ];
  const lift = modifierLift(
    establishedModifiers(uses),
    ["PredefinedTemplate", "PredefinedField"],
    4000,
  );
  expect(
    alignQualifiers(
      { head: ["doc"], qualifiers: ["calculated"] },
      establishedModifiers(uses),
      lift,
      2,
    ),
  ).toEqual([
    expect.objectContaining({
      word: "predefined",
      heads: ["field", "template"],
    }),
  ]);
});
it("nothing above the floor is a new concept", () => {
  /* returns [] */
});
```

- [ ] **Step 2:** Run; expect FAIL (modules missing).
- [ ] **Step 3: Implement.** Pure functions only; words come from the existing
      `casing.ts` word splitter (reuse it, do not duplicate).
  - Lift = (occurrences of the modifier in `conceptNames` /
    `conceptNames.length`) ÷ (`count` / `projectTotal`).
  - Floor default 2; measured in T9.
- [ ] **Step 4:** Tests pass, tsc clean.
- [ ] **Step 5:** Commit
      `feat(explore): type roles, name slots and term alignment (tea-rags-mcp-vi0wx)`.

### Task 4: Store reads and daemon op for type names

**Files:**

- Create: `src/core/adapters/duckdb/type-name-store.ts`
- Modify: `src/core/adapters/duckdb/client.ts`, `daemon/protocol.ts`,
  `daemon/op-commands.ts`, `daemon/client.ts` (one new op each, following
  `readOntologyReportSummary`)
- Modify: `src/core/contracts/types/codegraph-storage.ts` (query + row types)
- Test: `tests/core/adapters/duckdb/type-name-store.test.ts`,
  `tests/core/adapters/duckdb/daemon/client.test.ts` (op round-trip)

**Interfaces:**

- Consumes: `cg_symbols.symbol_kind` (T1), `TypeNameRow` (T3).
- Produces:

```ts
export interface TypeNameQuery {
  pathPrefixes: readonly string[];      // same helper the ontology report uses
  excludePaths?: readonly string[];     // diff mode: never read the changed files
  kinds: readonly SymbolDefinitionKind[]; // type-level kinds only
}
// GraphDbClient
readTypeNameRows(q: TypeNameQuery): Promise<TypeNameRow[]>;
```

- [ ] **Step 1: Failing tests.**
  - Rows carry their inheritance ancestors from `cg_symbols_inheritance`.
  - NULL-kind rows are excluded.
  - `excludePaths` drops a file's rows.
  - The non-production SQL predicate applies, so `scripts/` rows are absent.
  - The daemon op returns the same rows as the in-process store.
- [ ] **Step 2:** Run; FAIL.
- [ ] **Step 3:** Implement. One SQL read joins ancestors with `list()`, and
      `excludePaths` is bound as `rel_path NOT IN (…)`. That list is bounded by
      the diff cap (≤ 200), so a bind list is correct here, unlike the unbounded
      file list of the old ontology filter. Run `npm run build` before the
      daemon test.
- [ ] **Step 4:** Tests pass.
- [ ] **Step 5:** Commit
      `feat(adapters): type-name rows with ancestors for naming roles (tea-rags-mcp-vi0wx)`.

### Task 5: Type-name drafts, term alignment and novel names in the lexicon

**Precondition:** the concurrent lexicon-verdict agent (novel free names,
QUALIFIED co-occurrence) is committed.

**Files:**

- Modify: `src/core/domains/explore/naming-lexicon/verdicts.ts` (new
  `judgeTypeDraft`; alignment attached to NEW_TERM)
- Modify: `src/core/api/internal/ops/naming-lexicon-ops.ts` (read type rows,
  concept search for alignment, `excludePaths` plumbed into EVERY evidence read)
- Modify: `src/core/api/public/dto/naming-lexicon.ts`,
  `src/mcp/tools/codegraph.ts` (draft `kind: "type"` with `path`, `extends?`;
  verdicts COLLISION; `alternatives`)
- Test: `tests/core/domains/explore/naming-lexicon/verdicts.test.ts` (new
  describes), `tests/core/api/internal/ops/naming-lexicon-ops.test.ts`,
  `tests/mcp/tools/naming-lexicon-tool.test.ts`

**Interfaces:**

- Consumes: T3 functions, T4 `readTypeNameRows`.
- Produces:

```ts
export interface NamingLexiconTypeDraft { name: string; kind: "type"; path: string; extends?: string; concept?: string }
export type NamingVerdict =
  | { verdict: "CONFORMS" }
  | { verdict: "MISFIT"; suggestion: string; example?: … }
  | { verdict: "NEW_TERM"; topTerms: string[]; alternatives?: TermAlternative[] }
  | { verdict: "COLLISION"; existing: { symbolId: string; relPath: string } };
```

- [ ] **Step 1: Failing tests.**
  - `ResolutionOutcome` at `src/x/strategies/new.ts` extending
    `SymbolResolutionStrategy`, where the family role is `strategy` → MISFIT,
    suggestion `ResolutionOutcomeStrategy` (name + role in the draft's casing).
  - `Commit` where `Commit` already exists in another module → COLLISION.
  - `CalculatedDoc` with the concept search returning
    `PredefinedTemplate`/`PredefinedField` code → NEW_TERM with
    `alternatives[0].word === "predefined"`.
  - `CalculatedDoc` with nothing similar → NEW_TERM with no alternatives.
  - `CalculatedDocument` where `doc` is dominant → NEW_TERM with an alternative
    `{ word: "doc" }` for the head slot. Alignment stays soft (Global
    Constraints), even for the head.
  - An ops test asserts that `excludePaths` reaches every store read (type rows,
    by-type rows, callee rows, generic names).
- [ ] **Step 2:** Run; FAIL.
- [ ] **Step 3: Implement.**
  - The concept query is `draft.concept ?? words(draft.name).join(" ")`, run
    through the existing concept-mode search in `NamingLexiconOps`.
  - `conceptNames` = type names in the returned chunks.
  - Keep the schema within its byte budget: shorten descriptions if needed,
    never raise the budget.
- [ ] **Step 4:** Run the touched test dirs, then `npm run build` and the MCP
      tool tests.
- [ ] **Step 5:** Commit
      `feat(api): naming lexicon judges type names by role and aligned terms (tea-rags-mcp-vi0wx)`.

### Task 6: Changed files, added hunks and in-memory extraction

**Files:**

- Modify: `src/core/adapters/vcs/git/git-cli/client.ts` (two new methods, no
  existing signature changes)
- Create: `src/core/domains/language/in-memory-extraction.ts`. It lifts
  `extractFile` out of `scripts/ts-codegraph-typechecker-oracle.ts` into `src`;
  the script then imports it from `src`.
- Test: `tests/core/adapters/vcs/git/git-cli/changed-lines.test.ts` (temp repo),
  `tests/core/domains/language/in-memory-extraction.test.ts`

**Interfaces:**

- Produces:

```ts
// git CLI client
listChangedFiles(repoRoot: string, base: string): Promise<string[]>; // diff --name-only base + untracked (ls-files --others --exclude-standard)
readAddedLineRanges(repoRoot: string, base: string, relPath: string): Promise<Array<{ start: number; end: number }>>;
// parses `git diff -U0 base -- relPath` hunk headers `@@ -a,b +c,d @@` → { start: c, end: c + d - 1 } when d > 0; untracked file → one range covering the whole file
// in-memory-extraction.ts
export function extractFileInMemory(
  factory: LanguageFactory, repoRoot: string, relPath: string, text: string,
): FileExtraction | null; // null for a non-codegraph language
```

- [ ] **Step 1: Failing tests.**
  - Temp git repo:
    - edit line 3 and add lines 10–12 → ranges `[{3,3},{10,12}]`;
    - a pure deletion → no range;
    - an untracked file → whole file;
    - `listChangedFiles` includes the untracked file and excludes an unchanged
      one.
  - In-memory extraction of a TS snippet yields its `identifierDeclarations` and
    chunk `symbolKind`s.
- [ ] **Step 2:** Run; FAIL.
- [ ] **Step 3:** Implement with the adapter's existing exec helper (stall
      guard, child registry). Update the oracle and census scripts to import
      `extractFileInMemory`, and keep their tests green.
- [ ] **Step 4:** Tests pass; `npx vitest run tests/scripts`.
- [ ] **Step 5:** Commit
      `feat(adapters): changed files, added hunks and in-memory extraction for naming review (tea-rags-mcp-fdef2)`.

### Task 7: Diff mode in get_naming_lexicon

**Files:**

- Modify: `src/core/api/internal/ops/naming-lexicon-ops.ts` (`changes` / `files`
  source)
- Modify: `src/core/api/public/dto/naming-lexicon.ts`,
  `src/mcp/tools/codegraph.ts`
- Test: `tests/core/api/internal/ops/naming-lexicon-diff.test.ts`,
  `tests/mcp/tools/naming-lexicon-tool.test.ts`

**Interfaces:**

- Consumes: T5 judgement, T6 git + extraction.
- Produces:

```ts
export interface NamingReviewRequest {
  changes?: { base?: string };
  files?: string[];
}
export interface NamingReviewFinding {
  relPath: string;
  line: number;
  name: string;
  kind: string;
  verdict: NamingVerdict;
  genericName?: NamingLexiconGenericName;
}
export interface NamingReviewResult {
  base: string;
  checked: number;
  conforming: number;
  findings: NamingReviewFinding[];
  truncated?: { cap: number; skipped: number };
}
```

- [ ] **Step 1: Failing tests** (ops over a temp repo + DuckDB fixture):
  - A diff adding `meta: GitFileSignals` into a file whose OLD version is
    already in the fixture's `cg_identifiers` → finding MISFIT `fileSignals`.
    This is the self-confirmation guard: that file is in `excludePaths`.
  - An unchanged declaration in the same file is not reported.
  - Conforming declarations only raise `conforming`.
  - `result` with the generic caveat → a finding with `genericName`.
  - A new class `Commit` → COLLISION.
  - 201 changed files → `truncated`.
- [ ] **Step 2:** Run; FAIL.
- [ ] **Step 3: Implement.**
  - Build drafts from `identifierDeclarations` + identifier-row types, plus
    type-level chunks for `kind: "type"`, keeping those whose line is inside an
    added range.
  - Judge them through T5 with `excludePaths` = the changed files.
  - A draft in a language without codegraph is skipped and counted in `checked`
    as not judged. Say so in the DTO doc.
- [ ] **Step 4:** Touched dirs pass; `npm run build`; then
      `CODEGRAPH_ENABLED=true node build/cli/index.js call get_naming_lexicon '{"project":"tea-rags","changes":{}}'`
      on a scratch edit returns the finding.
- [ ] **Step 5:** Commit
      `feat(api): naming review over a diff (tea-rags-mcp-fdef2)`.

### Task 8: Plugin surfaces

**Files:**

- Modify: `.claude-plugin/tea-rags/skills/mr-review/SKILL.md` +
  `references/dimension-playbook.md` (naming as the eighth dimension, fed by
  `changes`)
- Modify: `.claude-plugin/tea-rags/skills/data-driven-generation/SKILL.md` (a
  naming-review step before commit; type drafts with `kind: "type"`)
- Modify: `.claude-plugin/tea-rags/.claude-plugin/plugin.json` (minor bump)
- Modify:
  `.claude-plugin/.benchmarks/{mr-review,data-driven-generation}/evals.json`
  (one case each)
- Modify:
  `.claude-plugin/dinopowers/skills/{requesting-code-review,receiving-code-review}/SKILL.md`
  — both tell the agent to hand-list the diff's identifiers into `names[]`;
  switch the diff case to `changes` (`names[]` stays for a single proposed
  rename), and update their evals
  (`.claude-plugin/.benchmarks/dinopowers-{requesting,receiving}-code-review/evals.json`)
- Modify: `.claude-plugin/tea-rags/rules/search-cascade.md` — the Naming branch
  of the decision tree gains "review the names a diff introduces →
  get_naming_lexicon `changes`"; the prohibited pattern "judging a name by grep"
  names `changes` next to `names[]`; the fallback-chain row covers the diff
  case. Update `.claude-plugin/.benchmarks/search-cascade/evals.json` (one
  diff-review case) and keep the injected hook output inside the per-part budget
  (`plugin-guidance-layers.md`).
- Modify: `src/mcp/resources/` search-guide content — the portable routing guide
  for non-Claude clients lists neither naming tool today; add
  `get_naming_lexicon` (names / types / changes) and `get_ontology_report`.
- Modify: `website/docs/usage/advanced/codegraph-enrichments.md` — the diff
  review mode and type-name verdicts.
- Tool schema (call contract) is NOT here: `changes` / `files` and
  `kind: "type"` land with their code in T5 / T7 (`src/mcp/tools/codegraph.ts`
  descriptions, within the schema byte budget).

- [ ] **Step 1:** Add the eval cases first (expected behaviour: the skill calls
      `get_naming_lexicon` with `changes` and reports findings grouped by
      verdict).
- [ ] **Step 2:** Edit the skills, the search cascade, the search-guide resource
      and the website doc; keep the tool-name references exact. After the
      cascade edit run `scripts/inject-rules.sh` and check no part exceeds the
      hook budget.
- [ ] **Step 3:** Bump the plugin minor version.
- [ ] **Step 4:** Commit
      `docs(plugin): naming review in mr-review and data-driven-generation (tea-rags-mcp-fdef2)`.

### Task 9: Gates and live validation

- [ ] **Step 1:** `npm run build`, then `npm run test:coverage`. Must pass
      without threshold changes.
- [ ] **Step 2:** Under the heavy-measure lock, run
      `DEBUG=1 node build/cli/index.js index-codebase --project tea-rags --force-enrichments codegraph --json`.
      Check `outcome.measured` true and nothing failed.
- [ ] **Step 3:** Measure on the self-index with the `call` CLI
      (`CODEGRAPH_ENABLED=true`):
  - role coverage: the share of type symbols with a role, per language;
  - precision: a hand-checked sample of 30 role assignments;
  - term alignment: 20 known reuse cases, counting how many give the right
    alternative; tune the lift floor if needed and record the value;
  - diff mode: a scratch edit adding `meta: GitFileSignals` to an indexed file →
    MISFIT. Also re-measure `.26` (SymbolDefinition `candidates`/`defs` many
    apart from `fallback` one).
- [ ] **Step 4:** Taxdome, Ruby-scoped recompute under the lock: role coverage
      and a 30-sample precision for Ruby.
- [ ] **Step 5:** Handoff to session 95aadf75 (xb669):
  - role API names (`readTypeNameRows` op, `deriveTypeRoles`);
  - persistence: read-time derived, no payload key;
  - granularity: type; a file's role = dominant role of its top-level types;
  - the measured coverage and precision.
- [ ] **Step 6:** Close `vi0wx`, `fdef2` and `.26` with the live numbers as
      evidence.
