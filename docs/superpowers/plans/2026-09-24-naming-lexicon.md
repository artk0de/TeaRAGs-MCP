# Naming Lexicon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use dinopowers:executing-plans
> (wraps superpowers:executing-plans / subagent-driven-development) to implement
> this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist every identifier declaration (param / local / field / return)
with its best-known type in the codegraph, expose `get_naming_lexicon` so an
agent learns how THIS project names values of a type or a concept, and wire it
into DDG Step 5; rework DDG Step 7 to symbol-level risks.

**Architecture:** One kernel extraction pass, configured per language by a
declarative `IdentifierDeclarationSyntax`, publishes a new
`FileExtraction.identifierDeclarations` channel (syntactic facts only). At sink
time a pure row builder joins each declaration with the type channels the
language already publishes and buffers rows into a new `cg_identifiers` DuckDB
table beside `cg_symbols`. A read-only `NamingLexiconOps` aggregates that table
(type mode) and optionally runs an in-process semantic search (concept mode).

**Tech Stack:** TypeScript, tree-sitter, DuckDB (in-process + daemon), vitest,
zod MCP schemas.

**Spec:** `docs/superpowers/specs/2026-09-24-naming-lexicon-design.md`

## Global Constraints

- Base: `worktree-mass-wave-0923`; work on `worktree-naming-lexicon`.
- Every language that has `<LANG>_EXTRACTION_PASSES` is covered in v1.
- `runExtractionPasses` / `composeExtractionWalker`
  (`kernel/extraction-passes.ts`, hub: fanIn 9, transitiveImpact 47) stay
  untouched. The new pass is only appended to each language's list.
- `codegraph/symbols/provider.ts` (hub: fanIn 12, 104 commits) gets no edits
  unless a task says so explicitly.
- `adapters/duckdb/*` is being changed in parallel by the DuckDB bloat fix on
  the same integration branch. Before Task 5, run
  `git log --oneline -5 worktree-mass-wave-0923 -- src/core/adapters/duckdb` and
  rebase onto it if it moved; take the next free migration number at that moment
  (029 is the last one today).
- Business-logic tests are immutable. Adding an entry to an enumeration test
  (tool list, derived language set) is allowed; rewriting expectations is not.
- Naming: domain-qualified exported names (`.claude/rules/naming.md`).
- Commits: `feat(<scope>)` with scopes from `.claude/rules/commit-rules.md`
  (`contracts`, `trajectory`, `migration`, `mcp`, `api`); plugin/docs
  `docs(plugin)`. Trailer:
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Reindex is user-gated. Never run `index-codebase` from a task.

## Spec amendments (decided during planning, with evidence)

1. **`LocalBinding` is NOT changed.** 404 literal `{ line, type }` expectations
   across 78 test files assert binding shape with `toEqual`; a required `source`
   field would force rewriting business-logic tests. Provenance instead lives on
   the declaration:
   `typeSource ∈ annotation | constructor | binding | field-type | return-type`.
   Loss: a joined binding type does not say whether it came from YARD or AST.
2. **The pass is syntactic only.** `ExtractionPass.run(root, ctx)` receives no
   native extraction, so the type JOIN moves to the sink-time row builder (Task
   6), which sees the fully merged `FileExtraction`.
3. **Pass-2 `call-arg` param types are not persisted in v1.** Rows are built at
   sink time (pass-1). This is the same class of increment as TS checker types.
4. **Casing lives in the language descriptor** (superseded 2026-09-25 by user:
   "camelCase/snakeCase помести в дескриптор языка … это должно быть частью
   субстрата"). Not `NamingConventionPorts` (Ruby/Python only, answer class
   existence) and not a table inside the lexicon: `LanguageCapability.naming`
   declares accepted casings per identifier role, first canonical (spec §
   "Naming convention in the language descriptor"). Task 3g adds it; Task 7
   reads it.
5. **Type recovery for untyped rows (2026-09-25, after Phase 0; user-approved:
   "давай пробовать все методы").** Phase 0: 8.3% of taxdome declarations typed
   syntactically. Spec § "Type recovery" adds `boundCallee` to the channel and
   four stages — `binding` and `finder` persisted by the row builder,
   `call-return` (edge join) and `name-inferred` computed at query time — plus
   the `CALLEE_DERIVED` shape, a `byCallee` answer, walker-side collection
   unwrapping for Python/TS, a leading-`::` strip and a primitive stop-list.
   Pass-1 constraint (amendment 3) holds: `binding` sees only walker-built
   `localBindings`; resolver-inferred types reach rows only through the
   `call-return` edge join. Deltas per task:
   - **Task 3e (new)** — `boundCallee` + collection unwrapping, below.
   - **Task 5** — three nullable columns `bound_member`, `bound_receiver`,
     `bound_call_expression`; `IdentifierRow` gains the same optional fields;
     new read `aggregateIdentifiersByCallee({ callees, pathPrefixes })` →
     `{ member, receiver, kind, name, n, exampleOwner }[]`; the type aggregate
     LEFT JOINs `cg_symbols_edges_method` (`edge_kind = 'exact'`, exactly one
     target per `(source_symbol_id, source_rel_path, call_expression)`) and the
     target's `kind = 'return'` row to fill `call-return` for rows with no type.
   - **Task 6** — row builder: `finder` stage from a language-owned finder
     vocabulary (Ruby list in the spec; other languages empty in v1);
     `bound_call_expression` = the `CallRef.callText` of the FIRST call in the
     owner chunk with `startLine >= decl.line` and the same `member` and
     `receiver` (the value's call precedes any later namesake call; covers
     `x =\n  foo()`, where the call starts a line below the declaration —
     `boundCallee` carries no line, per 3e); absent when none matches; strip a
     leading `::` from Ruby type names.
   - **Task 3f (new, after 3e)** — generic collection unwrapping in the
     languages 3e left out: Rust
     `Vec / VecDeque / HashSet / BTreeSet / Option / Box / Rc / Arc<T>` and
     slices `&[T]`; Java
     `List / Set / Collection / Iterable / Optional / Stream<T>`; Swift
     `Array<T> / Set<T> / Optional<T>`. Maps keep their head. Walker bump for
     the three languages.
   - **Task 3g (new, after 3f)** — `IdentifierCasing`, `IdentifierRole` and
     `LanguageCapability.naming` in `contracts/types/language.ts`; every code
     language's `capability.ts` declares it (markdown omits); a derived-set test
     in `tests/navigator-enumerations.test.ts` (languages declaring `naming` ==
     languages publishing `identifierDeclarations`); a table test pinning each
     language's canonical casing per role. `npm run gen:lang-compat` only if the
     generated docs render the descriptor (they do not today — the drift-guard
     test decides). Re-pin; `Versions: unchanged — read-path descriptor`.
   - **Task 7 (casing)** — `casing.ts` drops `identifierCasingFor(language)`;
     `renderIdentifier(typeName, casing)` and `detectIdentifierCasing(name)`
     stay pure; the canonical casing per role is passed in from the descriptor
     by the ops layer (Task 8), so `domains/explore/naming-lexicon` never
     imports the language domain.
   - **Task 7** — `NamingShape` gains `CALLEE_DERIVED` (name == callee member
     minus a verb prefix `find_|get_|fetch_|load_|build_|create_|new_|make_` and
     a trailing `!`/`?`); `EXACT` accepts the plural of `snake(T)`;
     `isNonConceptType(typeName)` stop-list
     (`string number boolean int str bool float unknown any Any object void None nil`,
     single-letter generics).
   - **Task 8** — `name-inferred` stage (≥ 3 typed rows, one type ≥ 80%) in the
     ops layer, never written; `evidence` counts per `typeSource`; `byCallee`
     when a draft carries `callee` and no type.

## File Structure

| File                                                                                     | Responsibility                               |
| ---------------------------------------------------------------------------------------- | -------------------------------------------- |
| `src/core/contracts/types/codegraph-extraction.ts` (modify)                              | `IdentifierDeclaration` + channel            |
| `src/core/domains/language/kernel/merge-extraction.ts` (modify)                          | rulebook row                                 |
| `src/core/domains/language/kernel/identifier-declarations.ts` (create)                   | syntax types, pass factory, owner assignment |
| `src/core/domains/language/<lang>/walker/identifier-declarations.ts` (create ×9)         | per-language `IdentifierDeclarationSyntax`   |
| `src/core/domains/language/<lang>/walker/passes.ts` (modify ×9)                          | append the pass                              |
| `src/core/domains/language/<lang>/capability.ts` (modify ×9)                             | walker version bump                          |
| `scripts/identifier-declarations-census.ts` (create)                                     | Phase 0 offline size measurement             |
| `src/core/domains/maintenance/migration/database/migrations/0NN-cg-identifiers.{sql,ts}` | table                                        |
| `src/core/adapters/duckdb/identifier-store.ts` (create)                                  | write + read SQL for `cg_identifiers`        |
| `src/core/contracts/types/codegraph-storage.ts` (modify)                                 | `GraphDbClient` methods                      |
| `src/core/adapters/duckdb/client.ts`, `daemon/{client,protocol,op-commands}.ts` (modify) | delegate + daemon ops                        |
| `src/core/adapters/duckdb/file-graph-store.ts` (modify)                                  | `removeFile` deletes identifiers             |
| `src/core/domains/trajectory/codegraph/symbols/identifier-rows.ts` (create)              | pure row builder (type join)                 |
| `src/core/domains/trajectory/codegraph/symbols/node-flush.ts` (modify)                   | buffer + flush identifier rows               |
| `src/core/domains/trajectory/codegraph/symbols/extraction-sink.ts` (modify)              | pass rows into the buffer                    |
| `src/core/domains/explore/naming-lexicon/{casing,shapes,terms,verdicts}.ts` (create)     | pure lexicon logic                           |
| `src/core/api/public/dto/naming-lexicon.ts` (create) + `dto/index.ts`                    | DTOs                                         |
| `src/core/api/internal/ops/naming-lexicon-ops.ts` (create)                               | orchestration                                |
| `src/bootstrap/factory.ts`, `src/core/api/public/app.ts` (modify)                        | wiring                                       |
| `src/mcp/tools/codegraph.ts` (modify)                                                    | `get_naming_lexicon` registration            |
| `.claude-plugin/tea-rags/skills/data-driven-generation/SKILL.md` + plugin manifest       | DDG Step 5/6/7, minor bump                   |

---

### Task 1: `identifierDeclarations` channel contract

**Files:**

- Modify: `src/core/contracts/types/codegraph-extraction.ts` (`FileExtraction`)
- Modify: `src/core/domains/language/kernel/merge-extraction.ts`
  (`FILE_EXTRACTION_MERGE_RULEBOOK`)
- Test: `tests/core/domains/language/kernel/merge-extraction.test.ts` (add a
  case; do not edit existing ones)

**Interfaces — Produces:**

```ts
export type IdentifierDeclarationKind = "param" | "local" | "field" | "return";
export type IdentifierTypeSource = "annotation" | "constructor" | "binding" | "field-type" | "return-type";

export interface IdentifierDeclaration {
  name: string;
  kind: Exclude<IdentifierDeclarationKind, "return">; // the pass never emits "return"
  line: number; // 1-based
  ownerSymbolId: string;
  typeName?: string;
  typeSource?: Extract<IdentifierTypeSource, "annotation" | "constructor">;
}
// FileExtraction:
identifierDeclarations?: IdentifierDeclaration[];
```

- [ ] **Step 1: Failing test** — in `merge-extraction.test.ts`:

```ts
it("concatenates identifierDeclarations base-first", () => {
  const base = { ...emptyExtraction(), identifierDeclarations: [decl("a", 1)] };
  const merged = mergeExtraction(base, {
    identifierDeclarations: [decl("b", 2)],
  });
  expect(merged.identifierDeclarations?.map((d) => d.name)).toEqual(["a", "b"]);
});
```

(`emptyExtraction` / `decl` = local helpers in the test: minimal
`FileExtraction` with `relPath`, `language`, `imports: []`, `chunks: []`,
`fileScope: []`; `decl(name, line)` →
`{ name, kind: "local", line, ownerSymbolId: "f" }`. Use the file's existing
helper if one exists.)

- [ ] **Step 2:**
      `npx vitest run tests/core/domains/language/kernel/merge-extraction.test.ts`
      → FAIL (tsc: rulebook missing key once the field exists).
- [ ] **Step 3:** Add the types + field; rulebook row
      `identifierDeclarations: (base, pass) => [...(base ?? []), ...pass],`
- [ ] **Step 4:** Test passes; `npx tsc --noEmit` clean.
- [ ] **Step 5:** Commit
      `feat(contracts): identifierDeclarations extraction channel`.

---

### Task 2: Kernel pass `createIdentifierDeclarationFacetPass`

**Files:**

- Create: `src/core/domains/language/kernel/identifier-declarations.ts`
- Test: `tests/core/domains/language/kernel/identifier-declarations.test.ts`

**Interfaces — Consumes:** `IdentifierDeclaration` (Task 1), `AstNode`
(`contracts/types/ast.ts`), `WalkContext`, `ExtractionPass`
(`contracts/types/language.ts`).

**Produces:**

```ts
export interface DeclaredIdentifierSite {
  nameNode: AstNode;
  kind: "param" | "local" | "field";
  typeNode?: AstNode | null; // written type annotation
  valueNode?: AstNode | null; // initializer, for constructor typing
}

export interface IdentifierDeclarationRule {
  nodeType: string;
  collect: (node: AstNode) => readonly DeclaredIdentifierSite[];
}

export interface IdentifierDeclarationSyntax {
  rules: readonly IdentifierDeclarationRule[];
  /** Type name from an annotation node's text (strip `:`, generics, pointers). */
  annotationTypeName: (typeNode: AstNode) => string | undefined;
  /** `X.new` / `new X()` / `X()` / `&X{}` / `X::new` → "X"; else undefined. */
  constructorTypeName: (valueNode: AstNode) => string | undefined;
}

/** Field-driven rule for the common shape: name/type/value are named fields. */
export function fieldRule(
  nodeType: string,
  kind: DeclaredIdentifierSite["kind"],
  fields: { name: string; type?: string; value?: string },
): IdentifierDeclarationRule;

export function createIdentifierDeclarationFacetPass(
  syntax: IdentifierDeclarationSyntax,
): ExtractionPass<Partial<FileExtraction>>;

/** Innermost chunk containing `line` — smallest span, deeper scope on tie. */
export function innermostChunkSymbolId(
  line: number,
  chunks: WalkContext["chunks"],
): string | undefined;
```

Behaviour contract:

- Walk the whole tree once (iterative stack, no recursion — deep files).
- For each node whose `type` matches a rule, call `collect`. For each site: name
  = `nameNode.text`; skip empty names and names that are not identifier-like
  (`/^[@$]{0,2}[A-Za-z_][\w]*[!?]?$/`); line = `nameNode.startPosition.row + 1`;
  owner = `innermostChunkSymbolId(line, ctx.chunks)` → no owner ⇒ skip the site
  (file-scope declarations are out of v1 scope).
- Type: `typeNode` → `annotationTypeName` → `typeSource: "annotation"`; else
  `valueNode` → `constructorTypeName` → `typeSource: "constructor"`; else no
  type.
- Deduplicate on `(ownerSymbolId, kind, name)` — first site wins (reassignments
  are not new declarations).
- Return `{}` when nothing was found (the merge rulebook must not see an empty
  array — see `domains/language/CLAUDE.md` on empty channels reaching the
  spill), else `{ identifierDeclarations }`.

- [ ] **Step 1: Failing tests** — parse with `tree-sitter-typescript` and a
      syntax object defined inside the test (keeps the kernel test
      language-free):

```ts
import Parser from "tree-sitter";
import TS from "tree-sitter-typescript";
import { describe, expect, it } from "vitest";

import {
  createIdentifierDeclarationFacetPass,
  fieldRule,
  innermostChunkSymbolId,
} from "../../../../../src/core/domains/language/kernel/identifier-declarations.js";

const syntax = {
  rules: [
    fieldRule("required_parameter", "param", { name: "pattern", type: "type" }),
    fieldRule("variable_declarator", "local", {
      name: "name",
      type: "type",
      value: "value",
    }),
  ],
  annotationTypeName: (n) =>
    n.text.replace(/^:\s*/, "").split("<")[0].trim() || undefined,
  constructorTypeName: (v) =>
    v.type === "new_expression"
      ? v.childForFieldName("constructor")?.text
      : undefined,
};

function run(src: string, chunks) {
  const p = new Parser();
  p.setLanguage(TS.typescript);
  const tree = p.parse(src);
  return createIdentifierDeclarationFacetPass(syntax).run(
    tree.rootNode as never,
    {
      code: src,
      relPath: "a.ts",
      language: "typescript",
      chunks,
    },
  );
}

describe("identifier declaration pass", () => {
  const chunks = [
    { symbolId: "Svc", startLine: 1, endLine: 6, scope: [] },
    { symbolId: "Svc#load", startLine: 2, endLine: 5, scope: ["Svc"] },
  ];
  const src = [
    "class Svc {",
    "  load(id: string, repo: Repo<Doc>) {",
    "    const doc = new Document(id);",
    "    const row = repo.get(id); const doc2: Document = row;",
    "  }",
    "}",
  ].join("\n");

  it("records params and locals with owner, line and syntactic type", () => {
    expect(run(src, chunks).identifierDeclarations).toEqual([
      {
        name: "id",
        kind: "param",
        line: 2,
        ownerSymbolId: "Svc#load",
        typeName: "string",
        typeSource: "annotation",
      },
      {
        name: "repo",
        kind: "param",
        line: 2,
        ownerSymbolId: "Svc#load",
        typeName: "Repo",
        typeSource: "annotation",
      },
      {
        name: "doc",
        kind: "local",
        line: 3,
        ownerSymbolId: "Svc#load",
        typeName: "Document",
        typeSource: "constructor",
      },
      { name: "row", kind: "local", line: 4, ownerSymbolId: "Svc#load" },
      {
        name: "doc2",
        kind: "local",
        line: 4,
        ownerSymbolId: "Svc#load",
        typeName: "Document",
        typeSource: "annotation",
      },
    ]);
  });

  it("returns an empty partial when nothing is declared", () => {
    expect(
      run("class A {}", [
        { symbolId: "A", startLine: 1, endLine: 1, scope: [] },
      ]),
    ).toEqual({});
  });

  it("dedupes reassignment within one owner", () => {
    const out = run("function f() { let x = 1; x = 2; let x2 = 3 }", [
      { symbolId: "f", startLine: 1, endLine: 1, scope: [] },
    ]);
    expect(out.identifierDeclarations?.map((d) => d.name)).toEqual(["x", "x2"]);
  });

  it("innermost chunk: smallest span, deeper scope on tie", () => {
    const c = [
      { symbolId: "A", startLine: 1, endLine: 10, scope: [] },
      { symbolId: "A#constructor", startLine: 1, endLine: 10, scope: ["A"] },
      { symbolId: "A#m", startLine: 3, endLine: 4, scope: ["A"] },
    ];
    expect(innermostChunkSymbolId(3, c)).toBe("A#m");
    expect(innermostChunkSymbolId(8, c)).toBe("A#constructor");
    expect(innermostChunkSymbolId(20, c)).toBeUndefined();
  });
});
```

(Order of `toEqual` = document order. Adjust `annotationTypeName` in the test
only if the grammar puts `:` outside `type_annotation`; do not weaken the
assertions.)

- [ ] **Step 2:** Run → FAIL (module missing).
- [ ] **Step 3:** Implement per the behaviour contract. `innermostChunkSymbolId`
      is a linear scan (chunks per file are small); reuse the tie rule from
      `kernel/assign-calls-to-chunks.ts` (smallest span, deeper `scope.length`).
- [ ] **Step 4:** Tests pass; `npx tsc --noEmit` clean.
- [ ] **Step 5:** Commit `feat(trajectory): kernel identifier declaration pass`.

---

### Task 3: Per-language `IdentifierDeclarationSyntax` (all languages)

One sub-task per language group, same recipe. Node types below are the expected
tree-sitter names. Verify each against the grammar (parse a snippet and print
`rootNode.toString()`) before writing the rule. The test is the authority, not
this list.

**Recipe per language `<lang>`:**

- Create `src/core/domains/language/<lang>/walker/identifier-declarations.ts`
  exporting `<LANG>_IDENTIFIER_DECLARATION_SYNTAX: IdentifierDeclarationSyntax`.
- Append
  `createIdentifierDeclarationFacetPass(<LANG>_IDENTIFIER_DECLARATION_SYNTAX)`
  as the LAST entry of `<LANG>_EXTRACTION_PASSES` in `<lang>/walker/passes.ts`.
- Bump `versions.walker` by 1 in `<lang>/capability.ts`, then
  `npm run pin:lang-versions` (the `version-pins.test.ts` guard digests the
  language + kernel sources; see `.claude/rules/index-format-versions.md` for
  the commit-body `Versions:` line). Check whether `kernel/capability.ts`
  `sharedVersions.walker` must move too — the rule file decides.
- Test
  `tests/core/domains/language/<lang>/walker/identifier-declarations.test.ts`
  through the COMPOSED walker, like
  `tests/core/domains/language/go/walker/struct-field-types.test.ts`:
  `new <Lang>Language().walker.walk({ tree, code, relPath, language, chunks })`
  and assert `.identifierDeclarations`.

Existing tests that pin a walker's whole output with `toEqual` will now see the
new channel. If one breaks, stop and report it; do not edit its expectation.
Most walker tests assert individual channels, so few should.

#### Task 3a: Ruby + Python

Ruby rules: `method_parameters` / `lambda_parameters` children (`identifier`,
`optional_parameter` name, `keyword_parameter` name) → param; `assignment` with
`left` = `identifier` → local, `left` = `instance_variable` → field;
`operator_assignment` ignored. Constructor: `call` whose method is `new` and
receiver is a `constant` / `scope_resolution` → receiver text (last `::` segment
kept as written, e.g. `Foo::Bar`). No annotations
(`annotationTypeName: () => undefined`).

Ruby test (the taxdome case):

```ruby
class ProcessEvent
  def call(id, ignored:)
    tax_automation_document = find_tax_automation_document!(id)
    @document = TaxAutomationDocument.new
    row = TaxAutomationDocument.find(id)
  end
end
```

chunks: `ProcessEvent` 1–7, `ProcessEvent#call` 2–6. Expected (document order):
`id` param, `ignored` param, `tax_automation_document` local (no type),
`@document` field typed `TaxAutomationDocument`/`constructor`, `row` local (no
type — `.find` is not a constructor; its type comes from the join in Task 6).

Python rules: `parameters` children (`identifier`, `typed_parameter`,
`default_parameter`, `typed_default_parameter`) → param, annotation from `type`;
`assignment` `left` = `identifier` → local (annotation from `type`), `left` =
`attribute` whose object is `self` → field (name = attribute). Constructor:
`call` whose function is an `identifier` / `attribute` starting uppercase → that
text. Test: `def load(self, repo: Repo): doc = Document(); self.cache = Cache()`
→ `self` param (keep it — it is a declaration), `repo` param `Repo`/annotation,
`doc` local `Document`/constructor, `cache` field `Cache`/constructor.

#### Task 3b: TypeScript + JavaScript

TS rules as in the Task 2 test, plus `optional_parameter`,
`public_field_definition` (field, name field `name`, type `type`, value
`value`), `lexical_declaration` handled through its `variable_declarator`
children. Constructor: `new_expression` → `constructor` field text. JS: same
minus annotations (`annotationTypeName: () => undefined`), parameters are
`identifier` / `assignment_pattern` children of `formal_parameters` (JS grammar
has no `required_parameter`), `field_definition` → field. Destructuring patterns
(`object_pattern`, `array_pattern`): collect each bound `identifier` /
`shorthand_property_identifier_pattern` as a separate untyped site.

#### Task 3c: Go + Rust

Go: `parameter_declaration` (one or more `name` children, `type`) → param per
name; `short_var_declaration` `left` expression_list × `right` expression_list
positional → local per name; `var_spec` → local (names + `type` + `value`);
`field_declaration` → field (names + `type`). Annotation: strip `*`, `[]`,
package qualifier kept (`sync.Pool`), generic args dropped. Constructor:
`composite_literal` (`&X{}` via `unary_expression`) → type text; `New<X>()`
calls are NOT constructors (their type comes from the join).

Rust: `parameter` (`pattern`, `type`) → param; `let_declaration` (`pattern`,
`type`, `value`) → local; `field_declaration` → field. Constructor:
`struct_expression` → name; `call_expression` whose function is
`scoped_identifier` ending in `::new` → the path before `::new`. Annotation:
strip `&`, `mut`, lifetimes, generic args.

#### Task 3d: Java + Swift + Bash, then the derived-set test

Java: `formal_parameter` → param; `local_variable_declaration` →
`variable_declarator` per name, type from the declaration's `type`;
`field_declaration` → field. Constructor: `object_creation_expression` → `type`
text. Annotation: drop generic args.

Swift: `parameter` → param (external/internal name: use the internal `name`);
`property_declaration` inside a function body → local, at type/class body level
→ field; type from `type_annotation`. Constructor: `call_expression` whose
callee is an uppercase `simple_identifier` → that name.

Bash: `variable_assignment` inside a function → local; `local` / `declare`
declarations → local. No types (both type functions return `undefined`).

Then add to `tests/navigator-enumerations.test.ts` a derived set: every language
whose `<lang>/index.ts` walker composes an identifier declaration pass. Derive
it the way the file derives its other sets (from the facades, not from prose);
assert it equals the set of languages with `<LANG>_EXTRACTION_PASSES` — i.e. no
language is left out.

- [ ] **Per sub-task steps:** failing test → run (FAIL) → syntax + pass +
      version bump → run (PASS) →
      `npx vitest run tests/core/domains/language/<lang>` (whole language suite
      green) → commit
      `feat(trajectory): identifier declarations for <lang>[, <lang2>]`.

---

#### Task 3e: `boundCallee` + collection unwrapping (all languages)

**Files:** `contracts/types/codegraph-extraction.ts` (`IdentifierDeclaration`
gains
`readonly boundCallee?: { readonly member: string; readonly receiver?: string }`),
`kernel/identifier-declarations.ts` (`IdentifierDeclarationSyntax` gains
`boundCalleeOf?(value: AstNode): { member; receiver? } | undefined`; the kernel
calls it for `local` / `field` sites that carry a value node), each
`<lang>/walker/passes/identifier-declarations.ts`, walker version bump for every
language, ledger + re-pin, tests per language.

Rule: the OUTERMOST call of the value only, read with the same member/receiver
split the language's monolith walker uses for `CallRef` (reuse its helper — the
row builder matches on it, so the two must agree by construction; a test per
language asserts `boundCallee` equals the `CallRef` `{member, receiver}` of the
same line). Chained receivers keep their text (`Doc.where(x).first` → member
`first`, receiver `Doc.where(x)`). Constructors stay `typeSource: "constructor"`
and also carry `boundCallee`.

Collection unwrapping: Python annotations
`list[T] / List[T] / Sequence[T] / Iterable[T] / set[T] / tuple[T, ...] / Optional[T]`
→ `T`; TypeScript `T[]`, `Array<T>`, `ReadonlyArray<T>`, `Set<T>` → `T`
(`Promise<T>` keeps its head: not a collection, and its names differ —
`docPromise`). Maps keep the head. Existing 3a/3b expectations that pin `list` /
untyped arrays are invariant changes — update them red-first and say so in the
commit body.

Commit:
`feat(trajectory): identifier declarations carry the bound callee (tea-rags-mcp-4p3sb.<new>)`.

### Task 4: Phase 0 — offline size census (no reindex)

**Files:**

- Create: `scripts/identifier-declarations-census.ts`

Walks a project root, parses every file of a supported language with that
language's COMPOSED walker (`LanguageFactory` / the language facade, the same
way `scripts/codegraph-chain-tally.ts` obtains walkers — reuse its file
discovery and chunk-range source), and prints one JSON object:

```json
{
  "files": 0,
  "declarations": 0,
  "typed": 0,
  "byLanguage": { "ruby": { "param": 0, "local": 0, "field": 0, "typed": 0 } },
  "estimatedBytes": 0
}
```

`estimatedBytes` = Σ over declarations of
`relPath.length + ownerSymbolId.length + name.length + (typeName?.length ?? 0) + 24`
(a naive upper bound; DuckDB dictionary compression will be lower).

- [ ] **Step 1:** Run on the worktree itself:
      `npx tsx scripts/identifier-declarations-census.ts .` — sanity: > 0
      declarations for typescript.
- [ ] **Step 2:** Run on taxdome (read-only):
      `npx tsx scripts/identifier-declarations-census.ts /Users/artk0re/Dev/taxdome`
      (path from `tea-rags` registry: `list_projects`).
- [ ] **Step 3:** Record both JSON outputs in the plan's "Phase 0 results"
      section below. **CHECKPOINT: report to the user** — the numbers decide
      whether untyped declarations stay in the table.
- [ ] **Step 4:** Commit `chore(scripts): identifier declarations census`.

---

### Task 5: `cg_identifiers` table, store, client + daemon ops

Before starting: re-check the bloat-fix constraint in Global Constraints.

**Files:**

- Create: migration `0NN-cg-identifiers.sql` + `.ts` (`SQL_0NN_CG_IDENTIFIERS`),
  register in `migrations/index.ts`.
- Create: `src/core/adapters/duckdb/identifier-store.ts`
- Modify: `src/core/contracts/types/codegraph-storage.ts` (`GraphDbClient`)
- Modify: `src/core/adapters/duckdb/client.ts` (`DuckDbGraphClient` delegates)
- Modify: `src/core/adapters/duckdb/daemon/protocol.ts` (`DAEMON_OPS` + params
  union), `daemon/op-commands.ts` (`DAEMON_OP_COMMANDS`), `daemon/client.ts`
- Modify: `src/core/adapters/duckdb/file-graph-store.ts#removeFile` — add
  `DELETE FROM cg_identifiers WHERE rel_path = ?` to its transaction.
- Modify: in-memory `GraphDbClient` fakes in tests that implement the full
  interface (tsc will list them) — add no-op methods only.
- Test: `tests/core/adapters/duckdb/identifier-store.test.ts`, extend
  `tests/core/adapters/duckdb/daemon/server.test.ts` op list if it enumerates
  ops.

**SQL:**

```sql
CREATE TABLE IF NOT EXISTS cg_identifiers (
  rel_path        VARCHAR NOT NULL,
  owner_symbol_id VARCHAR NOT NULL,
  kind            VARCHAR NOT NULL,
  name            VARCHAR NOT NULL,
  type_name       VARCHAR,
  type_source     VARCHAR,
  line            INTEGER NOT NULL
);
```

**Interfaces — Produces** (on `GraphDbClient`):

```ts
export interface IdentifierRow {
  ownerSymbolId: string;
  kind: IdentifierDeclarationKind;
  name: string;
  line: number;
  typeName?: string;
  typeSource?: IdentifierTypeSource;
}
export interface IdentifierReplaceEntry { relPath: string; rows: IdentifierRow[] }

replaceIdentifiersBulk(entries: IdentifierReplaceEntry[]): Promise<void>;
/** type → kind → name → count, rel_path filtered by an optional path prefix list. */
aggregateIdentifiersByType(q: { types: string[]; pathPrefixes?: string[] }): Promise<
  { typeName: string; kind: IdentifierDeclarationKind; name: string; n: number; exampleOwner: string }[]>;
/** For anchors: their param/return types. */
anchorIdentifierTypes(symbolIds: string[]): Promise<{ ownerSymbolId: string; kind: "param" | "return"; typeName: string }[]>;
/** Homonymy: which types a name is bound to. */
identifierNameTypes(names: string[]): Promise<{ name: string; typeName: string | null; n: number }[]>;
/** Collision: short names already taken by symbols. */
existingSymbolShortNames(names: string[]): Promise<string[]>;
/** Row count under a scope — drives scope widening. */
countIdentifiers(q: { types: string[]; pathPrefixes?: string[] }): Promise<number>;
```

`replaceIdentifiersBulk`: one transaction; `DELETE ... WHERE rel_path IN (...)`
for the batch's paths, then a bulk insert (appender or multi-row VALUES — follow
whatever `symbol-store.ts#upsertSymbolsBulk` does after the bloat fix lands).
Daemon op name `replaceIdentifiersBulk` is a `write(...)`; the four reads are
reads (follow how `getCallers` is declared in `op-commands.ts`).

- [ ] **Step 1: Failing tests** (in-process DuckDB, same setup as the existing
      `tests/core/adapters/duckdb/*` store tests):
  - replace twice for the same `relPath` → rows of the second call only;
  - `removeFile(relPath)` removes its identifiers;
  - `aggregateIdentifiersByType({types:["Doc"]})` groups and counts, returns an
    `exampleOwner`;
  - `pathPrefixes` filters by `rel_path LIKE prefix || '%'`;
  - `identifierNameTypes(["row"])` returns one entry per distinct type,
    `typeName: null` for untyped;
  - `existingSymbolShortNames` reads `cg_symbols.short_name`;
  - migration test: the migration list includes the new file and applies clean
    (extend the existing migrations test's expectation only by the new entry).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement store, contract, client delegation, daemon
      protocol/op/client, `removeFile` delete, fakes.
- [ ] **Step 4:** `npx vitest run tests/core/adapters/duckdb` green; tsc clean.
- [ ] **Step 5:** Commit
      `feat(migration): cg_identifiers table and graph client ops`.

---

### Task 6: Sink-time row builder + write wiring

**Files:**

- Create: `src/core/domains/trajectory/codegraph/symbols/identifier-rows.ts`
- Modify: `src/core/domains/trajectory/codegraph/symbols/node-flush.ts`
- Modify: `src/core/domains/trajectory/codegraph/symbols/extraction-sink.ts`
  (the `deps.nodeFlush.buffer(...)` call)
- Modify ONLY IF the eager path must carry rows too: `symbols/provider.ts`
  `acceptExtraction` buffer call — one argument added, nothing else (hub file;
  `Why:` line in the commit).
- Test:
  `tests/core/domains/trajectory/codegraph/symbols/identifier-rows.test.ts`,
  extend `node-flush` tests with a new case.

**Interfaces — Produces:**

```ts
export function buildIdentifierRows(
  extraction: FileExtraction,
): IdentifierRow[];
```

Join rules (pure, no I/O):

1. Every `identifierDeclarations` entry becomes a row, keeping its syntactic
   type.
2. Untyped `param` / `local`: find the owner chunk
   (`extraction.chunks.find(c => c.symbolId === ownerSymbolId)`), take
   `chunk.localBindings?.[name]`, pick the binding with `line === decl.line`,
   else the nearest with `line <= decl.line` → `typeName = binding.type`,
   `typeSource = "binding"`. Skip empty `type` (Go shadow bindings use `""`).
3. Untyped `field`: look up the owner chunk's enclosing class name
   (`chunk.scope.at(-1)`; for a class-level owner, the owner's own last segment)
   in `ivarTypes`, `classFieldTypes` (keys: verify the key format in
   `codegraph-extraction.ts` docs — short class name vs qualified; try both the
   last scope segment and `scope.join("::")`). Field name lookup with and
   without a leading `@` / `self.`. → `typeSource = "field-type"`.
4. Return rows: for each chunk whose `symbolId` is a key of
   `structuredReturnTypes`, one row
   `{ kind: "return", name: <short name after the last "#" or ".">, ownerSymbolId: symbolId, line: chunk.startLine ?? 0, typeName: <ref name>, typeSource: "return-type" }`.
   Use the existing ref → name helper the codebase uses for `RubyTypeRef`
   (`refToName` in `kernel/type-fact-store.ts` or its exported equivalent); skip
   refs without a single nominal name.

Wiring: `SymbolNodeFlushQueue#buffer` gains an optional
`identifiers?: IdentifierRow[]` argument stored beside `definitions`;
`#flushBatch` calls
`graphDb.replaceIdentifiersBulk(batch.map(e => ({ relPath: e.relPath, rows: e.identifiers ?? [] })))`
after `upsertSymbolsBulk` (always, so a file that lost all declarations is
cleared). The sink passes `buildIdentifierRows(extraction)`.

- [ ] **Step 1: Failing tests** — `identifier-rows.test.ts`:
  - syntactic type kept (`annotation`);
  - Ruby shape: `row` local at line 5 + chunk
    `localBindings: { row: [{ line: 5, type: "TaxAutomationDocument" }] }` →
    `typeName: "TaxAutomationDocument", typeSource: "binding"`;
  - nearest-preceding binding chosen when no exact line;
  - `type: ""` binding ignored;
  - field typed from `ivarTypes`;
  - return row from `structuredReturnTypes`
    (`"ProcessEvent#find_tax_automation_document!"` →
    `name: "find_tax_automation_document!"`);
  - **invariant**: an extraction whose calls use a convention-typable receiver
    (`tax_automation_document.provider`) but has no declaration/binding for it
    produces NO row for that name — rows come only from declarations and the
    three type channels.
  - node-flush: buffered identifiers reach `replaceIdentifiersBulk` with their
    relPath; a file buffered with `[]` still produces an entry (clears).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement builder + wiring.
- [ ] **Step 4:** `npx vitest run tests/core/domains/trajectory/codegraph`
      green. Worker-forking tests need a local build: `npm run build` (no link).
- [ ] **Step 5:** Commit
      `feat(trajectory): persist identifier declarations to cg_identifiers`.

---

### Task 7: Pure lexicon logic

**Files:**

- Create: `src/core/domains/explore/naming-lexicon/casing.ts`, `shapes.ts`,
  `terms.ts`, `verdicts.ts`, `index.ts`
- Test: `tests/core/domains/explore/naming-lexicon/*.test.ts`

**Produces:**

```ts
// casing.ts
export type IdentifierCasing = "snake" | "camel";
export function identifierCasingFor(language: string): IdentifierCasing; // ruby/python/rust/bash → snake, else camel
export function typeToIdentifier(
  typeName: string,
  casing: IdentifierCasing,
): string;
// "Foo::TaxAutomationDocument" → "tax_automation_document" | "taxAutomationDocument"
export function splitIdentifierWords(identifier: string): string[]; // snake, camel, PascalCase, "::", "#", "."; lowercased; strips @ $ ! ?

// shapes.ts
export type NamingShape = "EXACT" | "QUALIFIED" | "TAIL" | "VERB_TYPE" | "FREE";
export function classifyNamingShape(
  name: string,
  typeName: string,
  kind: IdentifierDeclarationKind,
  casing: IdentifierCasing,
): NamingShape;
export interface NamingShapeShare {
  shape: NamingShape;
  share: number;
}
export function shapeDistribution(
  rows: { name: string; n: number }[],
  typeName: string,
  kind: IdentifierDeclarationKind,
  casing: IdentifierCasing,
): { shares: NamingShapeShare[]; n: number; confidence: number };
// confidence = min(1, (n / 20) ** 2)

// terms.ts
export interface ConceptTerm {
  term: string;
  score: number;
  holders: string[];
}
export function extractConceptTerms(
  holders: { symbolId: string; relativePath: string; score: number }[],
  limit?: number,
): ConceptTerm[];
// words from symbolId + path segments (drop "src", "lib", "app", file extensions), n-grams 1..3 of consecutive words joined "_", score = Σ holder score, holders ≤ 3, sorted desc, default limit 10

// verdicts.ts
export type NamingVerdict =
  | { verdict: "CONFORMS" }
  | { verdict: "MISFIT"; suggestion: string; holder?: string }
  | { verdict: "NEW_TERM"; topTerms: string[] };
export function judgeDraftName(input: {
  name: string;
  kind?: IdentifierDeclarationKind;
  typeName?: string;
  casing: IdentifierCasing;
  byTypeRows?: {
    kind: IdentifierDeclarationKind;
    name: string;
    n: number;
    exampleOwner: string;
  }[];
  conceptTerms?: ConceptTerm[];
}): NamingVerdict;
```

Shape rules (`s = typeToIdentifier(T)`, words compared lowercased):

- `EXACT`: name (sigils stripped) equals `s`.
- `QUALIFIED`: words(name) starts with words(s) and is longer.
- `TAIL`: words(name) is a non-empty proper suffix of words(s).
- `VERB_TYPE`: kind `return`, words(name) = one verb word + words(s).
- else `FREE`.

Verdict rules:

- Typed draft: rows of the draft's kind for its type; if the draft's shape has
  share ≥ 0.2 in `shapeDistribution` → `CONFORMS`; else `MISFIT` with
  `suggestion` = most frequent row name of that kind (for `return` with no rows:
  `find_` + `s` in snake / `find` + Pascal(s) in camel), `holder` = its
  `exampleOwner`.
- Untyped draft with `conceptTerms`: if no word of the draft appears in any of
  the top 5 terms → `NEW_TERM { topTerms: top 5 term strings }`; else
  `CONFORMS`.
- Otherwise `CONFORMS` (nothing to judge against).

- [ ] **Step 1: Failing tests** covering, at minimum: `typeToIdentifier` for
      both casings and `A::B`;
      `splitIdentifierWords("find_tax_automation_document!")`,
      `("taxAutomationDocument")`, `("@document")`; each shape with the taxdome
      names (`tax_automation_document` EXACT, `tax_automation_document_ignored`
      QUALIFIED, `document` TAIL, `find_tax_automation_document!` VERB_TYPE for
      `return`, `row` FREE); `shapeDistribution` shares sum to 1 and confidence
      `(n/20)^2` capped; `extractConceptTerms` ranks `tax_automation_document`
      above noise for holders `TaxPreparation::TaxAutomations::Document#...`
      paths; verdicts: `row` typed `TaxAutomationDocument` with rows
      `[{local, tax_automation_document, 212}]` → MISFIT suggestion
      `tax_automation_document`; `find_vendor_envelope` return typed
      `TaxAutomationDocument` with rows
      `[{return, find_tax_automation_document!, 4}]` → MISFIT suggestion
      `find_tax_automation_document!`; untyped `VendorEnvelopeSyncer` with terms
      lacking `vendor`/`envelope`/`syncer` → NEW_TERM.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit
      `feat(explore): naming lexicon shape, term and verdict logic`.

---

### Task 8: `NamingLexiconOps` + DTOs

**Files:**

- Create: `src/core/api/public/dto/naming-lexicon.ts`; re-export in
  `dto/index.ts` (precedent `architecture.ts`)
- Create: `src/core/api/internal/ops/naming-lexicon-ops.ts`
- Test: `tests/core/api/internal/ops/naming-lexicon-ops.test.ts`

**DTOs:**

```ts
export interface NamingLexiconRequest extends CollectionRef {
  pathPattern?: string;
  language?: string;
  types?: string[];
  anchors?: string[];
  concept?: string;
  names?: { name: string; kind?: IdentifierDeclarationKind; type?: string }[];
}
export interface NamingLexiconTypeEntry {
  type: string;
  kinds: Partial<
    Record<IdentifierDeclarationKind, { name: string; n: number }[]>
  >; // top 5 each
  shapes: Partial<Record<IdentifierDeclarationKind, NamingShapeShare[]>>;
  confidence: number;
}
export interface NamingLexiconResult {
  scope: string; // the pathPattern-derived prefix actually used, "" = project
  byType: NamingLexiconTypeEntry[];
  concept?: { terms: ConceptTerm[] };
  names: ({
    name: string;
    evidence: {
      n: number;
      example?: string;
      boundTypes: number;
      collision: boolean;
    };
  } & NamingVerdict)[];
  notices?: string[]; // e.g. "concept step skipped: embeddings unavailable"
  driftWarning?: string;
}
```

**Ops** (deps like `TracePathOps`:
`{ pool: GraphDbClientPool, collectionRegistry, resolveActiveCollection?, exploreOps: Pick<ExploreOps, "semanticSearch"> }`):

1. Validate ≥ 1 of `types | anchors | concept | names`; `concept` without
   `language` → throw the project's input-validation error type used by other
   ops (find it in `trace-path-ops.ts`).
2. Resolve collection exactly like `TracePathOps`; `pool.acquireReader`;
   `try/finally close`.
3. Scope: `pathPattern` → literal prefix before the first glob metachar
   (`*?{[`); `countIdentifiers` < 5 → drop the last path segment and retry; then
   `""`.
4. Types = `types` ∪ `anchorIdentifierTypes(anchors)` ∪ `names[].type`.
5. `aggregateIdentifiersByType` → build `byType` with `shapeDistribution`
   (casing from `language`, else from the file extension of `exampleOwner`'s
   path is not available — default `identifierCasingFor(language ?? "ruby")` is
   wrong for TS; so: when `language` is absent, infer casing per type from its
   rows: majority of names containing `_` → snake, else camel).
6. Concept (if `concept`):
   `exploreOps.semanticSearch({ ...collectionRef, query: concept, language, pathPattern: <L2 = first two path segments of pathPattern or undefined>, filter: { presets: "production" }, rerank: { custom: { similarity: 0.7, chunkFanIn: 0.15, fanIn: 0.15 } }, limit: 30, metaOnly: true })`
   → holders (`symbolId`, `relativePath`, `score`) → `extractConceptTerms`. < 5
   holders under L2 → retry without `pathPattern`. Embedding error → add a
   notice, continue.
7. Names: `identifierNameTypes`, `existingSymbolShortNames`, `judgeDraftName`.
8. Empty table on a collection that has symbols (`countIdentifiers` = 0 with no
   types filter while `cg_symbols` is non-empty) →
   `driftWarning: "cg_identifiers is empty — reindex with --force to populate"`.

- [ ] **Step 1: Failing tests** with a fake `GraphDbClient` (only the six
      methods + `close`) and a fake `exploreOps`: type mode builds byType and
      shapes; anchors add types; scope widening path; concept notice on explore
      throwing; names verdicts end-to-end for the taxdome case; validation error
      without inputs; driftWarning on empty table.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(api): NamingLexiconOps and DTOs`.

---

### Task 9: Wiring + MCP tool + docs

**Files:**

- Modify: `src/bootstrap/factory.ts` (construct `NamingLexiconOps` next to
  `TracePathOps`, same `codegraphContext` guard, inject `exploreOps`)
- Modify: `src/core/api/public/app.ts` (App `getNamingLexicon`, AppDeps
  `namingLexiconOps?`, impl falling back to an empty result like `tracePath`)
- Modify: `src/mcp/tools/codegraph.ts`
  (`registerToolSafe(server, "get_naming_lexicon", ...)`, inline zod with
  `collectionPathFields()`; `readOnlyHint: true`, `idempotentHint: true`)
- Modify: `tests/mcp/tools/codegraph-gating.test.ts` — add
  `"get_naming_lexicon"` to the expected list (enumeration update only).
- Modify: `README.md`, `website/docs/usage/advanced/codegraph-enrichments.md`
  (tool list + one paragraph).
- Test: `tests/mcp/tools/naming-lexicon-tool.test.ts` (schema rejects an empty
  request; handler forwards to `app.getNamingLexicon`; absent without codegraph
  — covered by the gating test).

Tool description (verbatim — COMPACT, call contract only; when-to-call is
selection policy and lives in the search cascade, Task 12):

> Project naming vocabulary from the codegraph. `types`/`anchors` → names per
> kind + dominant shape; `names[]` → CONFORMS | MISFIT{suggestion} |
> NEW_TERM{topTerms}; `concept`+`language` → project terms for a description.

Each zod field gets a ≤ 1-line `.describe()`; enums (`kind`) are enumerated by
the schema, not by prose. No examples in the schema — examples live in skills.
Budget: description ≤ 300 chars, whole tool schema ≤ 1.5 KB serialized (a test
asserts both, so later edits cannot bloat it).

- [ ] Steps: failing tool test → implement wiring → `npx vitest run tests/mcp`
      green → commit `feat(mcp): get_naming_lexicon tool`.

---

### Task 10: DDG skill — Step 5 lexicon, Step 6 vocabulary, Step 7 rework

**Files:**

- Modify: `.claude-plugin/tea-rags/skills/data-driven-generation/SKILL.md`
- Modify: the tea-rags plugin manifest version (minor bump; find the `version`
  field under `.claude-plugin/tea-rags/`)

Edits (English, match the file's terse register):

1. Step matrix: row 5 STYLE adds "+ lexicon"; row 7 VERIFY becomes "symbol
   risks + N-th-way + tests-at-risk (MODIFY)".
2. Step 5 STYLE: new subsection "Naming (lexicon)" — the mode table from spec
   §"Step 5 STYLE — one lexicon call"; back-edge to Step 4 when concept finds a
   holder REUSE missed; `byType` → vocabulary for Step 6; codegraph off →
   `semantic_search` with the spec's step-5 parameters, concept only.
3. Step 6: "Names come from the vocabulary; a word outside it is NEW_TERM with a
   one-line justification in the output."
4. Step 7: delete items 1–3 (identifier existence, template declaration Read);
   add "Symbol risks" per spec §"Step 7 VERIFY — reworked" (preset
   `criticalPath`, ≤ 5 symbols, the three reactions, `dangerous` fallback when
   codegraph off); keep N-th-way and tests-at-risk; one line that Step 7 is the
   extension point for post-generation structural checks.
5. Labels are read from `rankingOverlay.{file,chunk}.<field>.label` — keep the
   existing "Reading Overlay Labels" section consistent.

- [ ] Steps: edit → `npx prettier --write` on the file → markdownlint (if
      available) → commit
      `docs(plugin): DDG naming lexicon step and symbol-risk verify`.

#### Task 10b: DDG eval cases

**Files:** `.claude-plugin/.benchmarks/data-driven-generation/evals.json`,
`.claude-plugin/.benchmarks/data-driven-generation/benchmark.md`

The suite (15 cases, last run 2026-04-21) predates this change. Cases that pin
behaviour this plan removes on purpose are superseded, not silently deleted:

- eval-11 / eval-13 / eval-14 (identifier-existence check in VERIFY) → set
  `"status": "superseded"` with `"supersededBy"` naming the new case and
  `"reason": "Step 7 identifier check removed (naming-lexicon spec); specs catch hallucinated identifiers"`.
- Any other case whose expectation contradicts the current SKILL.md (check
  eval-6 template weights against the Step 2 delegation to
  `extract-project-patterns`) gets the same treatment, reason stated.

New cases (neutral user framing, no rule vocabulary in the prompt, same `mustDo`
/ `mustNotDo` / `failureMode` shape as the existing ones):

1. `naming-type-misfit`: Ruby, taxdome-like context; a new method loads a
   `TaxAutomationDocument`. mustDo: one `get_naming_lexicon` call in Step 5 with
   `types` and planned `names`; local named after the lexicon's dominant name;
   finder named `find_<snake type>`. mustNotDo: `row` or an invented term.
2. `naming-concept-new-term`: CREATE of a service whose concept exists in the
   project under another term. mustDo: `concept` passed as a description (not
   the draft name), `language` set, project term adopted. mustNotDo: draft name
   inside `concept`.
3. `naming-concept-backedge`: concept mode returns a holder REUSE did not find.
   mustDo: back to Step 4, gate that holder. mustNotDo: rename and write a
   sibling.
4. `naming-new-term-justified`: genuinely new concept. mustDo: new term with a
   one-line justification. mustNotDo: force-fit an unrelated project term.
5. `naming-codegraph-off`: prime lacks `codegraph.symbols`. mustDo:
   `semantic_search` with the step-5 concept parameters. mustNotDo: call
   `get_naming_lexicon`.
6. `verify-symbol-risk`: generated code calls a symbol whose chunk `bugFixRate`
   is critical. mustDo: `find_symbol(rerank: "criticalPath", metaOnly: true)` on
   called symbols (≤ 5), defensive call, pinned-test check. mustNotDo:
   per-identifier existence sweep; `dangerous` while codegraph is on.
7. `verify-central-modified`: MODIFY of a symbol labelled `pageRank` critical.
   mustDo: Step 8 `get_callers`.
8. `naming-modify-scope`: MODIFY / hotfix. mustDo: lexicon with the symbol's
   signature types only, `names` = new locals only, no `concept`.

- [ ] Write the cases and supersede markers; validate the JSON parses.
- [ ] Run the suite with `Skill(optimize-skill)` (with-rule vs baseline,
      parallel subagents) on the reworked SKILL.md; append a `runs[]` entry
      (date, pass counts, delta, failureMap) and a dated section in
      `benchmark.md`. Target: with-rule 100% on active cases. A failing new case
      → fix SKILL.md wording and re-run, at most 3 iterations, each recorded.
- [ ] Commit
      `docs(plugin): DDG eval cases for naming lexicon and symbol-risk verify`.

---

### Task 12: Teach the other skills + search cascade (user request 2026-09-25)

User: "остальные скиллы научить работать с новыми функциями, описывать компактно
mcp схему". Placement per `.claude/rules/plugin-guidance-layers.md`:

- **Search cascade** (`.claude-plugin/tea-rags/rules/search-cascade.md`): one
  decision-tree row — intent "what does this project call X / how are values of
  type T named / is this name right" → `get_naming_lexicon`; prohibited pattern:
  grepping for names or `semantic_search` on a draft name to judge naming.
  Codegraph off → the concept fallback DDG Step 5 documents. Check
  `scripts/inject-rules.sh --count` against declared parts.
- **Skills** — every skill where a name is CREATED or JUDGED gets the lexicon,
  described compactly: ONE line with the call shape
  (`get_naming_lexicon(types|anchors|names|concept+language)`) and what to read
  from the answer for that skill — never a copy of the schema. Candidates (the
  implementer confirms each by reading the skill; skip with a reason when a
  skill never names or judges names):
  - `tea-rags:mr-review` — a naming dimension: new identifiers in the diff
    judged via `names[]` (MISFIT/NEW_TERM surface as review findings).
  - `tea-rags:refactoring-scan` — rename candidates: identifiers whose shape is
    MISFIT against a dominant convention.
  - `tea-rags:extract-project-patterns` — naming convention as part of a pattern
    (dominant shapes per kind).
  - `tea-rags:explore` — vocabulary questions route to the tool.
  - `dinopowers:brainstorming` / `dinopowers:writing-plans` — names proposed for
    new symbols in a design or plan go through `names[]` / `concept` before the
    plan fixes them.
  - `dinopowers:requesting-code-review` / `receiving-code-review` — naming
    comments resolved against the lexicon, not taste.
- Eval cases: one per changed skill in its benchmark `evals.json`, static
  validation only; runs join Task 10b's deferred run.
- Plugin bumps: tea-rags and dinopowers, minor each.
- Commit
  `docs(plugin): skills use the naming lexicon (tea-rags-mcp-4p3sb.<new>)`.

### Task 11: Gates

- [ ] `npm run build` (bare, no link).
- [ ] `npm run test:coverage` — thresholds unchanged. Below threshold →
      `coverage-expander` subagent (background), per project CLAUDE.md.
- [ ] `npx tsc --noEmit`, `npx eslint` on touched files — no disables.
- [ ] **Live validation — authorized 2026-09-25 ("залайв валидируй в пачке
      совсем остальным"), one batch, every heavy step under
      `/Users/artk0re/.claude/heavy-measure.lock.d`:** 0. After Tracks E–H are
      merged: REBASE onto the newest `worktree-mass-wave-0923` (user,
      2026-09-25: "ребейзнись на самую свежую версию интеграционной ветки и уже
      после ребейза делай лайв валидацию"). Version conflicts: walker version
      above both sides; pins only via `npm run pin:lang-versions`. Full
      path-filtered suite + tsc after.
  1. `npm run build && npm link`, `/mcp reconnect` (user action).
  2. Record DuckDB file sizes of both projects' codegraph DBs.
  3. `DEBUG=1 tea-rags index-codebase --project tea-rags --force-enrichments codegraph --wait-enrichments --json`
     — walker changes are enrichment-owned (`epic-completion-gate.md`); if the
     drift report demands `--force` instead, ask before substituting.
  4. Same for taxdome (`--force-enrichments codegraph`, minutes, not hours).
  5. Measure on taxdome: typed share per `typeSource` (annotation, constructor,
     binding, finder, call-return, name-inferred), rows per kind, DuckDB size
     delta; `prime` resolve rates unchanged vs before.
  6. MCP: `get_naming_lexicon` — taxdome scenario (`row` /
     `find_vendor_envelope` → MISFIT with the project's names), a TS type on
     taxdome, `GraphDbClient` on tea-rags; `get_ontology_report` on both
     projects — top synonyms / homonyms / outliers inspected by hand for false
     positives.
  7. DDG + skill evals (Task 10b / 12) under the lock.
  8. Defect scan: every false positive / wrong verdict / slow query found in 5–7
     becomes a fix (parallel subagents), then re-measure. Target: "works well",
     not perfect — each remaining limitation named with its number.

### Task 6b: return rows for every language (bead .21)

`call-return` needs the TARGET's `return` row; before 6b only Ruby's
`structuredReturnTypes` produced them. 6b adds `functionReturnTypes` (Go, Ruby,
Swift) to the row builder and syntactic return annotations to the declaration
pass (TS, Python, Java, Rust, Go, Swift; TS async `Promise<T>` records `T`).

### Task 13: `get_ontology_report` (bead .20; user: "Искал уголь, нашел золото")

Project-wide naming ontology audit over `cg_identifiers`, sibling of
`get_architecture_report`: synonyms (one type, scattered names), homonyms (one
name, several concept types), outliers (names off their type's dominant shape),
symbol collisions. Data-driven generic-name filter, `nonConceptTypes` excluded,
`name-inferred` never counts. Same compact-schema budget as Task 9. Concept
synonyms (two terms, one concept) are reserved for semantic clustering — bead
`tea-rags-mcp-wa6bz`, linked.

## Phase 0 results

Census `5766a0195` (`scripts/identifier-declarations-census.ts`), syntactic
types only — the sink-time join (Task 6) has not run, so `typed` is a floor.
Full JSON outputs are reproducible with the script; the summary:

| Corpus   | Files  | Declarations | Typed (syntactic) | Naive bytes | Wall  |
| -------- | ------ | ------------ | ----------------- | ----------- | ----- |
| tea-rags | 1,245  | 29,899       | 10,914 (36.5%)    | 3.2 MB      | 4.8 s |
| taxdome  | 24,242 | 255,254      | 21,235 (8.3%)     | 39.0 MB     | 67 s  |

Per language on taxdome: ruby 33,413 param / 27,165 local / 12,163 field, 1,640
typed (all `constructor`); typescript 84,838 / 96,434 / 233, 19,590 typed
(18,758 `annotation`); javascript 990 declarations; bash 18 locals. Zero parse
failures and zero unwalked files on both corpora.

Observations that feed Tasks 6–7:

- TS top type names are primitives (`string` 3,288, `number` 2,787, `boolean`
  805 on taxdome) — type mode needs a primitive stop-list, or it ranks
  non-concepts first.
- Collection typing is inconsistent: Go/Java/Swift unwrap to the element
  (`[]*Doc` → `Doc`), Python records the head (`list` is its top name), TS
  leaves `T[]` untyped.
- Ruby constructor names keep a leading `::` (`System` 171 vs `::System` 18) —
  normalize at the row builder.
- The census process peaks at 5.5 GB RSS on taxdome outside the V8 heap
  (identical under `--max-old-space-size=1024`); suspected per-file native
  `Parser` retention in the shared `extractFile` helper. Script-only, does not
  touch the production chunker pool.
