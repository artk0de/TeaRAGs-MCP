# Naming Coverage: Ruby Class State and Untyped Methods — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use dinopowers:executing-plans
> (wraps superpowers:subagent-driven-development / executing-plans) to implement
> this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ruby class variables, `||=` memoization and accessor macros reach the
naming lexicon as `field` rows, and methods with no inferable return type are
judged by the project's method vocabulary in `get_naming_lexicon` and a new
`verbs` section of `get_ontology_report`.

**Architecture:** The Ruby identifier pass gains `class_variable` and `||=`; a
new Ruby facet pass turns catalogue accessor macros into `field` declarations
through the existing `expandClassBodyMacros` interpreter. Two bounded
`cg_symbols` reads (`readMethodVerbs`, `readMethodNamesMatching`) feed a pure
judgement module `naming-lexicon/method-vocabulary.ts`, which both the lexicon
(untyped `return` drafts) and the ontology report (`verbs`) call.

**Tech Stack:** TypeScript, tree-sitter-ruby, DuckDB (daemon + in-process
client), Vitest, zod (MCP schema).

**Spec:** `docs/superpowers/specs/2026-09-28-naming-coverage-ruby-state-and-methods-design.md`

## Global Constraints

- Every evidence read is scoped to the answer's language namespace (commit
  `a8edfcb57`): new reads extend `IdentifierScopeQuery`, so `languages` and
  `excludePaths` arrive through `scopedEvidence` in `naming-lexicon-ops.ts`.
- Ruby `versions.walker` 5 → 6 exactly once on this branch; later Ruby walker
  commits re-pin (`npm run pin:lang-versions`) without a second bump.
- No kernel edit (`src/core/domains/language/kernel/**`): no
  `sharedVersions` bump.
- `dsl/` stays pure data: interpretation lives in `walker/`.
- `naming-lexicon/casing.ts` (hub, fanIn 9) is consumed, never modified.
- `naming-lexicon-ops.ts` (2 100+ lines) gets wiring only; read assembly goes to
  a new file.
- MCP tool description ≤ 300 chars, input schema ≤ 1 536 bytes — measured with
  `npx tsx scripts/measure-tools-list.ts`, never raised.
- TDD: failing test first, run it red, then implement. Existing business-logic
  test expectations are not edited, except where a task names the intended
  invariant change.
- Verb lexicon = `NAMING_VERB_PREFIXES` (`naming-lexicon/shapes.ts`); holder
  minimum 2 (`MIN_ROLE_MEMBERS`), dominance share 0.5. No new tuning constants.
- Commits: conventional type + scope, `Co-Authored-By: Claude Opus 5.5 (1M
  context) <noreply@anthropic.com>`; deep-silo files need a `Why:` line.

---

### Task 0: Baseline before the first edit (read-only)

**Files:** none in the repo; output to `$CLAUDE_JOB_DIR/tmp/baseline/`.

- [ ] **Step 1:** Build the worktree (`npm run build`, no link).
- [ ] **Step 2:** Pick the Ruby corpus: `node build/cli/index.js call list_projects '{}'`
  → a registered Ruby project (mastodon or taxdome). Record its alias.
- [ ] **Step 3:** Record the review of one Ruby file with accessors, memoization
  and untyped methods:

```bash
node build/cli/index.js call get_naming_lexicon '{"project":"<alias>","files":["<app/models/some_model.rb>"]}' > baseline/review.json
node build/cli/index.js call get_ontology_report '{"project":"<alias>","language":"ruby","sections":["synonyms","outliers"]}' > baseline/ontology.json
```

  Expected: `review.notJudgedBy.method.unknownReturnType > 0`, no `@@` / accessor
  rows among `findings`. Keep both files for Task 9.

---

### Task 1: Ruby `@@class_variable` and `||=` declare fields and locals

**Files:**
- Modify: `src/core/domains/language/ruby/walker/passes/identifier-declarations.ts`
- Modify: `src/core/domains/language/ruby/capability.ts` (walker 5 → 6)
- Modify: `tests/core/domains/language/capability/version-pins.json` (via script)
- Test: `tests/core/domains/language/ruby/walker/identifier-declarations.test.ts`

**Interfaces:**
- Produces: `field` declarations named `@@x`; `||=` declarations with the same
  left-type → kind map as `assignment`.

- [ ] **Step 1: Write the failing tests** (append a describe to the existing
  file, reusing its `declarationsOf(source)` helper exactly as the existing ivar
  cases do):

```ts
describe("class variables and memoization declare", () => {
  it("a class variable is a field named with its sigil", () => {
    const rows = declarationsOf(`class Cache\n  @@store = Store.new\nend\n`);
    expect(rows).toContainEqual(expect.objectContaining({ name: "@@store", kind: "field", typeName: "Store" }));
  });

  it("||= declares its left side: ivar, class variable, local", () => {
    const rows = declarationsOf(
      `class Report\n  def totals\n    @totals ||= Totals.new\n    @@registry ||= {}\n    memo ||= compute\n  end\nend\n`,
    );
    expect(rows).toContainEqual(expect.objectContaining({ name: "@totals", kind: "field", typeName: "Totals" }));
    expect(rows).toContainEqual(expect.objectContaining({ name: "@@registry", kind: "field" }));
    expect(rows).toContainEqual(expect.objectContaining({ name: "memo", kind: "local" }));
  });

  it("other compound assignments still declare nothing", () => {
    const rows = declarationsOf(`def bump\n  count += 1\n  @hits -= 1\n  @ok &&= check\nend\n`);
    expect(rows.map((r) => r.name)).not.toEqual(expect.arrayContaining(["count", "@hits", "@ok"]));
  });
});
```

- [ ] **Step 2:** Run `npx vitest run tests/core/domains/language/ruby/walker/identifier-declarations.test.ts`
  — expected FAIL: no `@@store` / `@totals` rows.

- [ ] **Step 3: Implement.** In `identifier-declarations.ts`:

```ts
const ASSIGNMENT_KIND_BY_LEFT_TYPE: Readonly<Record<string, DeclaredIdentifierSite["kind"]>> = {
  identifier: "local",
  instance_variable: "field",
  class_variable: "field",
};

/** `a = v` and `a ||= v` declare `a`; `+=`, `-=`, `&&=` update a binding declared elsewhere. */
function declaringAssignmentSites(node: AstNode): DeclaredIdentifierSite[] {
  const left = node.childForFieldName("left");
  const kind = left ? ASSIGNMENT_KIND_BY_LEFT_TYPE[left.type] : undefined;
  if (!left || kind === undefined) return [];
  return [{ nameNode: left, kind, valueNode: node.childForFieldName("right") }];
}

const assignmentRule: IdentifierDeclarationRule = { nodeType: "assignment", collect: declaringAssignmentSites };

/** tree-sitter-ruby spells the operator as an anonymous child of `operator_assignment`. */
const memoizingAssignmentRule: IdentifierDeclarationRule = {
  nodeType: "operator_assignment",
  collect: (node) =>
    node.children.some((child) => child.type === "||=") ? declaringAssignmentSites(node) : [],
};
```

  Add `memoizingAssignmentRule` to `rules` after `assignmentRule`, and update
  the module docblock (compound assignment sentence → "`||=` declares; `+=` and
  the other compound forms update a binding declared elsewhere").
  If the anonymous operator child's `type` is not `"||="` in this grammar
  version, read `node.childForFieldName("operator")?.text === "||="` instead —
  verify with a one-off `parser.parse("a ||= 1").rootNode.toString()` in the
  test file's parser setup before choosing, and keep only the form that works.

- [ ] **Step 4:** Run the test file — PASS. Run the materialization parity
  suite: `npx vitest run tests/core/domains/language/materialization` — PASS
  (`operator` field reads must survive materialization; if the field-loss
  inventory flags `operator_assignment.operator`, use the child-type form).

- [ ] **Step 5: Bump and pin.** `ruby/capability.ts`: `walker: 5` → `walker: 6`
  with a comment line naming this change (class variables, `||=`, accessor
  fields — accessor fields land in Task 2 under the same bump). Then
  `npm run pin:lang-versions` and
  `npx vitest run tests/core/domains/language/capability` — PASS.
  Run `npm run gen:lang-compat` (no tier moves; commit whatever it rewrites).

- [ ] **Step 6: Commit**

```bash
git add src/core/domains/language/ruby/walker/passes/identifier-declarations.ts src/core/domains/language/ruby/capability.ts tests/core/domains/language/capability/version-pins.json tests/core/domains/language/ruby/walker/identifier-declarations.test.ts
git commit -m "feat(codegraph): Ruby class variables and ||= declare naming-lexicon rows" -m "Why: @@x and memoized @x ||= were invisible to get_naming_lexicon (bd tea-rags-mcp-0qaht). Ruby walker 5 -> 6."
```

---

### Task 2: Accessor macros declare fields (catalogue-driven facet pass)

**Files:**
- Create: `src/core/domains/language/ruby/walker/passes/accessor-field-declarations.ts`
- Modify: `src/core/domains/language/ruby/walker/passes.ts`
- Test: `tests/core/domains/language/ruby/walker/accessor-field-declarations.test.ts`

**Interfaces:**
- Consumes: `expandClassBodyMacros(node, catalogue)` (`ruby/walker/macro-expansion.ts`)
  → `DeclaredMethod { name, kind: "instance" | "static", category, startLine }`;
  `catalogueForGemfile(ctx.gemfileContent)` (`ruby/gemfile.ts`);
  `innermostChunkSymbolId(line, ctx.chunks)` (kernel barrel).
- Produces: `rubyAccessorFieldFacetPass: ExtractionFacetPass` publishing
  `identifierDeclarations` rows `{ name: "@x" | "@@x", kind: "field", line, ownerSymbolId }`.

- [ ] **Step 1: Write the failing tests** — drive the COMPOSED Ruby walker the
  way `identifier-declarations.test.ts` does (same helper import), so the
  registration is covered too:

```ts
describe("accessor macros declare fields", () => {
  it("attr_reader / attr_accessor / attr_writer declare one @field per operand", () => {
    const rows = fieldRowsOf(
      `class Invoice\n  attr_reader :number, :total\n  attr_accessor :status\n  attr_writer :note\nend\n`,
    );
    expect(rows.map((r) => r.name).sort()).toEqual(["@note", "@number", "@status", "@total"]);
    expect(new Set(rows.map((r) => r.kind))).toEqual(new Set(["field"]));
  });

  it("a static accessor (cattr_*, mattr_*) declares a class variable", () => {
    const rows = fieldRowsOf(`class Setting\n  cattr_accessor :default_locale\nend\n`, { gemfile: `gem "rails"\n` });
    expect(rows.map((r) => r.name)).toEqual(["@@default_locale"]);
  });

  it("a gem-gated static accessor declares nothing without its gem", () => {
    const rows = fieldRowsOf(`class Setting\n  cattr_accessor :default_locale\nend\n`, { gemfile: `gem "sinatra"\n` });
    expect(rows).toEqual([]);
  });

  it("a receiver-qualified call is no macro", () => {
    expect(fieldRowsOf(`class A\n  def x\n    obj.attr_reader :y\n  end\nend\n`)).toEqual([]);
  });

  it("an accessor is typed from the ivar the class assigns", () => {
    const rows = typedFieldRowsOf(
      `class Order\n  attr_reader :customer\n  def initialize\n    @customer = Customer.new\n  end\nend\n`,
    );
    expect(rows).toContainEqual(expect.objectContaining({ name: "@customer", typeName: "Customer" }));
  });
});
```

  `fieldRowsOf` = composed-walker extraction filtered to `kind === "field"`
  rows whose line is an accessor line; `typedFieldRowsOf` runs the rows through
  `buildIdentifierRows` (`domains/trajectory/codegraph/symbols/identifier-rows.ts`)
  as `naming-review-extraction.ts` does, because the type is joined there. Put
  both helpers at the top of the new test file. Check which gem activates
  `cattr_*` in `dsl/activesupport.ts` (`activatedBy`) and use that gem name in
  the Gemfile fixtures.

- [ ] **Step 2:** Run the new test file — FAIL (no accessor rows).

- [ ] **Step 3: Implement** `accessor-field-declarations.ts`:

```ts
/**
 * Accessor macros declare fields for the naming lexicon (bd tea-rags-mcp-0qaht):
 * `attr_reader :total` declares `@total`, `cattr_accessor :x` declares `@@x`.
 * The macro set is the DSL catalogue's `accessor` category, read through the
 * same interpreter the symbol pass uses (`expandClassBodyMacros`), gated by the
 * project's Gemfile — never a hard-coded name list. A writer's `x=` and a
 * reader's `x` are one field.
 */
import type { AstNode } from "../../../../../contracts/types/ast.js";
import type { IdentifierDeclaration } from "../../../../../contracts/types/codegraph.js";
import { innermostChunkSymbolId, type ExtractionFacetPass } from "../../../kernel/index.js";
import { catalogueForGemfile } from "../../gemfile.js";
import { expandClassBodyMacros } from "../macro-expansion.js";

export const rubyAccessorFieldFacetPass: ExtractionFacetPass = {
  run: (root, ctx) => {
    if (ctx.chunks.length === 0) return {};
    const catalogue = catalogueForGemfile(ctx.gemfileContent);
    const declarations: IdentifierDeclaration[] = [];
    const seen = new Set<string>();
    const stack: AstNode[] = [root];
    for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
      if (node.type === "call" || node.type === "method_call") {
        for (const method of expandClassBodyMacros(node, catalogue)) {
          if (method.category !== "accessor") continue;
          const name = `${method.kind === "static" ? "@@" : "@"}${method.name.replace(/=$/, "")}`;
          const line = method.startLine;
          const ownerSymbolId = innermostChunkSymbolId(line, ctx.chunks);
          if (ownerSymbolId === undefined) continue;
          const key = `${ownerSymbolId}\u0000${name}`;
          if (seen.has(key)) continue;
          seen.add(key);
          declarations.push({ name, kind: "field", line, ownerSymbolId });
        }
      }
      const { children } = node;
      for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
    }
    return declarations.length > 0 ? { identifierDeclarations: declarations } : {};
  },
};
```

  Register in `passes.ts` after the identifier pass and update its docblock
  ("today only the identifier declarations" → list both):

```ts
export const RUBY_EXTRACTION_PASSES: readonly ExtractionFacetPass[] = [
  rubyTypeAbstractnessFacetPass,
  createIdentifierDeclarationFacetPass(RUBY_IDENTIFIER_DECLARATION_SYNTAX),
  rubyAccessorFieldFacetPass,
];
```

  Confirm the `IdentifierDeclaration` import path by reading the kernel
  barrel's own import of it (`kernel/identifier-declarations.ts` top).

- [ ] **Step 4:** Run the new test file, the Ruby walker suite
  (`npx vitest run tests/core/domains/language/ruby`) and
  `tests/core/domains/language/materialization` — PASS. If the typed case
  fails, read `recoveredType` / `fieldTypeOf` in `identifier-rows.ts`: the
  lookup tries `@x` and `x` under the enclosing class keys; the accessor row's
  owner must be a chunk of that class.

- [ ] **Step 5:** `npm run pin:lang-versions` (walker stays 6), capability tests PASS.

- [ ] **Step 6: Commit** — `feat(codegraph): Ruby accessor macros declare naming-lexicon fields`,
  body with `Why:` and `Versions: walker 6 (bumped in the previous commit, re-pinned)`.

---

### Task 3: Bounded method-name reads over `cg_symbols`

**Files:**
- Modify: `src/core/contracts/types/codegraph-storage.ts`
- Modify: `src/core/adapters/duckdb/identifier-store.ts`
- Modify: `src/core/adapters/duckdb/client.ts`, `daemon/protocol.ts`,
  `daemon/op-commands.ts`, `daemon/client.ts`
- Modify: every `IdentifierReader` implementer/wrapper the compiler flags
  (`scopedEvidence` in `naming-lexicon-ops.ts`, test doubles)
- Test: `tests/core/adapters/duckdb/identifier-store-method-names.test.ts`

**Interfaces:**
- Produces (contracts):

```ts
/** A read over declared method / function names (`cg_symbols`, symbol_kind method | function), production files only. */
export interface MethodNameScopeQuery extends IdentifierScopeQuery, IdentifierLanguageGroupingQuery {
  nonProductionPaths: TypeNameQuery["nonProductionPaths"];
}
/** Holders per leading verb, for the verbs of `verbs` only (`find_x`, `findX` → `find`). */
export interface MethodVerbQuery extends MethodNameScopeQuery {
  verbs: readonly string[];
}
/** Names matching any of `patterns` (RE2, anchored by the caller). */
export interface MethodNamePatternQuery extends MethodNameScopeQuery {
  patterns: readonly string[];
}
export interface MethodVerbRow extends IdentifierLanguageGroupedRow {
  verb: string;
  holders: number;
}
export interface MethodNameRow extends IdentifierLanguageGroupedRow {
  shortName: string;
  holders: number;
}
// on the identifier reader contract, beside existingSymbolShortNames:
readMethodVerbs: (q: MethodVerbQuery) => Promise<MethodVerbRow[]>;
readMethodNamesMatching: (q: MethodNamePatternQuery) => Promise<MethodNameRow[]>;
```

- [ ] **Step 1: Write the failing store tests**, seeding `cg_symbols` +
  `cg_symbols_files` exactly as `identifier-store-language-scope.test.ts` does:
  - symbols: `app/a.rb` `User#load_user` (method), `app/b.rb`
    `Account#load_user` (method), `app/c.rb` `User#fetch_user` (method),
    `app/d.rb` `User` (class), `web/e.ts` `Api#loadUser` (method),
    `spec/f_spec.rb` `X#load_user` (method, non-production).
  - `readMethodVerbs({ verbs: ["load","fetch"], nonProductionPaths })` →
    `[{verb:"load",holders:3},{verb:"fetch",holders:1}]` (sorted holders desc);
    with `languages: ["ruby"]` → load 2, fetch 1; the class row never counts;
    the spec file never counts.
  - `readMethodNamesMatching({ patterns: ["^(?:load|fetch)(?:_user[!?]?|User)$"], … })`
    → `load_user` (2), `fetch_user` (1), `loadUser` (1).
  - `excludePaths: ["app/a.rb"]` drops one `load_user` holder; `languages: []`
    → `[]`; `groupByLanguage: true` adds `language` per row.

- [ ] **Step 2:** Run — FAIL (methods do not exist).

- [ ] **Step 3: Implement** in `identifier-store.ts`, beside
  `existingSymbolShortNames`, reusing `evidenceScopePredicate(pathPrefixes,
  excludePaths, languages)`, `compileNonProductionPathPredicate`, the
  `fileLanguageGrouping` join for `groupByLanguage`, and `placeholders`:

```sql
-- readMethodVerbs: one row per verb; holders = distinct symbol ids
SELECT regexp_extract(short_name, '^(' || ? || ')(?:_|[A-Z]|$)', 1) AS verb,
       count(DISTINCT symbol_id) AS holders
  FROM cg_symbols
 WHERE symbol_kind IN ('method', 'function')
   AND <scope.sql> AND NOT <nonProduction("rel_path")>
   AND regexp_matches(short_name, '^(' || ? || ')(?:_|[A-Z]|$)')
 GROUP BY verb
 ORDER BY holders DESC, verb
-- the ? is verbs.map(escapeRegex).join("|"); pass it twice

-- readMethodNamesMatching: one row per matching name
SELECT short_name, count(DISTINCT symbol_id) AS holders
  FROM cg_symbols
 WHERE symbol_kind IN ('method', 'function')
   AND <scope.sql> AND NOT <nonProduction("rel_path")>
   AND (regexp_matches(short_name, ?) OR regexp_matches(short_name, ?) …)
 GROUP BY short_name
 ORDER BY holders DESC, short_name
```

  With `groupByLanguage`, add the file-language join/column exactly as the
  aggregate reads do and key the GROUP BY by it. Empty `verbs` / `patterns` →
  `[]` without a query. Constructors (`initialize`, `constructor`, `__init__`)
  are excluded by `short_name NOT IN (...)`.

- [ ] **Step 4:** Thread both reads through `client.ts`, `daemon/protocol.ts`
  (param shapes), `daemon/op-commands.ts`, `daemon/client.ts` following
  `existingSymbolShortNames` line for line; add both to `scopedEvidence`
  (bind `excludePaths` and `languages`, caller's explicit `languages` wins).
  `npx tsc --noEmit` — clean.

- [ ] **Step 5:** Run the new store test + `tests/core/adapters/duckdb` — PASS.

- [ ] **Step 6: Commit** — `feat(codegraph): bounded method-name reads for the naming lexicon`
  with the SQL-pushdown rationale in the body.

---

### Task 4: `method-vocabulary.ts` — pure judgement of untyped method names

**Files:**
- Create: `src/core/domains/explore/naming-lexicon/method-vocabulary.ts`
- Modify: `src/core/domains/explore/naming-lexicon/index.ts` (barrel)
- Test: `tests/core/domains/explore/naming-lexicon/method-vocabulary.test.ts`

**Interfaces:**
- Consumes: `splitIdentifierWords`, `joinIdentifierWords` (`casing.ts`),
  `NAMING_VERB_PREFIXES` (`shapes.ts`), `MethodVerbRow`, `MethodNameRow`.
- Produces:

```ts
export interface UntypedMethodEvidence {
  /** Project verbs of NAMING_VERB_PREFIXES with holders (readMethodVerbs). */
  verbs: readonly MethodVerbRow[];
  /** Names sharing the draft's noun tail under any lexicon verb (readMethodNamesMatching). */
  tailNames: readonly MethodNameRow[];
  /** Verbless-branch analogues: names ending in the draft's last word. */
  lastWordNames: readonly MethodNameRow[];
  /** True when a method of this exact name is declared elsewhere in scope. */
  declared: boolean;
}
export type UntypedMethodVerdict =
  | { verdict: "CONFORMS" }
  | { verdict: "MISFIT"; suggestion: string; holder: string }
  | { verdict: "NEW_TERM"; topTerms: string[] }
  | { verdict: "NO_CONVENTION"; prefer: { analogous: string[] } };
export function methodVerbOf(name: string): string | undefined;          // "load_user" → "load"; "total" → undefined
export function methodNounTail(name: string): string[];                  // "load_user!" → ["user"]
export function methodTailPattern(tail: readonly string[]): string;       // RE2, both casings, all lexicon verbs
export function methodLastWordPattern(word: string): string;              // RE2, both casings
export function judgeUntypedMethodName(input: {
  name: string;
  casing: IdentifierCasing;
  evidence: UntypedMethodEvidence;
}): UntypedMethodVerdict;
export function groupMethodsByTail(rows: readonly MethodNameRow[]): Map<string, { verb: string; holders: number; name: string }[]>;
```

- [ ] **Step 1: Write the failing table tests** (pure, no mocks):

```ts
const verbs = (entries: [string, number][]) => entries.map(([verb, holders]) => ({ verb, holders }));
const names = (entries: [string, number][]) => entries.map(([shortName, holders]) => ({ shortName, holders }));
const none = { verbs: [], tailNames: [], lastWordNames: [], declared: false };

describe("judgeUntypedMethodName", () => {
  it("MISFIT when the noun tail has a dominant verb the draft does not use", () => {
    const v = judgeUntypedMethodName({
      name: "fetch_user",
      casing: "snake",
      evidence: { ...none, tailNames: names([["load_user", 7], ["fetch_user", 1]]), verbs: verbs([["load", 30]]) },
    });
    expect(v).toEqual({ verdict: "MISFIT", suggestion: "load_user", holder: "load_user" });
  });
  it("keeps a trailing ! or ? on the suggestion", () => {
    const v = judgeUntypedMethodName({
      name: "fetch_user!",
      casing: "snake",
      evidence: { ...none, tailNames: names([["load_user!", 3]]) },
    });
    expect(v).toMatchObject({ verdict: "MISFIT", suggestion: "load_user!" });
  });
  it("no dominance (below 2 holders or 50 %) falls through to the verb vocabulary", () => {
    const v = judgeUntypedMethodName({
      name: "fetch_user",
      casing: "snake",
      evidence: { ...none, tailNames: names([["load_user", 1]]), verbs: verbs([["fetch", 4]]) },
    });
    expect(v).toEqual({ verdict: "CONFORMS" });
  });
  it("NEW_TERM with the project's top verbs when the verb is foreign", () => {
    const v = judgeUntypedMethodName({
      name: "make_user",
      casing: "snake",
      evidence: { ...none, verbs: verbs([["load", 9], ["build", 3], ["make", 1]]) },
    });
    expect(v).toEqual({ verdict: "NEW_TERM", topTerms: ["load", "build"] });
  });
  it("camelCase drafts get camelCase suggestions", () => {
    const v = judgeUntypedMethodName({
      name: "fetchUser",
      casing: "camel",
      evidence: { ...none, tailNames: names([["loadUser", 4]]) },
    });
    expect(v).toMatchObject({ verdict: "MISFIT", suggestion: "loadUser" });
  });
  it("a verbless name declared elsewhere conforms", () => {
    expect(judgeUntypedMethodName({ name: "total", casing: "snake", evidence: { ...none, declared: true } })).toEqual({
      verdict: "CONFORMS",
    });
  });
  it("a verbless new name gets analogues sharing its last word", () => {
    const v = judgeUntypedMethodName({
      name: "process_payment",
      casing: "snake",
      evidence: { ...none, lastWordNames: names([["capture_payment", 3], ["refund_payment", 2]]) },
    });
    expect(v).toEqual({ verdict: "NO_CONVENTION", prefer: { analogous: ["capture_payment", "refund_payment"] } });
  });
});

describe("method name patterns", () => {
  it("the tail pattern matches both casings under every lexicon verb", () => {
    const re = new RegExp(methodTailPattern(["user"]));
    for (const s of ["load_user", "fetch_user?", "findUser"]) expect(re.test(s)).toBe(true);
    for (const s of ["load_users", "user_load", "loadUserName"]) expect(re.test(s)).toBe(false);
  });
  it("the last-word pattern matches suffix words only", () => {
    const re = new RegExp(methodLastWordPattern("payment"));
    for (const s of ["capture_payment", "payment", "capturePayment"]) expect(re.test(s)).toBe(true);
    for (const s of ["payments", "repayment"]) expect(re.test(s)).toBe(false);
  });
});
```

- [ ] **Step 2:** Run — FAIL (module missing).

- [ ] **Step 3: Implement.** Rules, in order:
  1. `words = splitIdentifierWords(name)`; `marker = /[!?]+$/.exec(name)?.[0] ?? ""`.
  2. `verb = NAMING_VERB_PREFIXES.includes(words[0]) && words.length > 1 ? words[0] : undefined`.
  3. No verb → `declared` → CONFORMS; else NO_CONVENTION with the top 5
     `lastWordNames` by holders (excluding `name` itself).
  4. Verb → group `tailNames` by their verb (`methodVerbOf`); total holders `T`;
     top `(v, h)`. If `h >= 2 && h / T >= 0.5 && v !== verb` → MISFIT with
     `suggestion = joinIdentifierWords([v, ...tail], casing) + marker`,
     `holder` = the top name.
  5. Else `verb` holds ≥ 2 in `verbs` → CONFORMS.
  6. Else NEW_TERM with the verbs holding ≥ 2, holders desc, max 5, excluding `verb`.
  Patterns: escape words; snake `(?:_w1_w2)[!?]?`, camel `W1W2` (capitalised);
  tail pattern `^(?:v1|…)(?:<snake>|<camel>)$`; last-word pattern
  `(?:^|_)word[!?]?$|^word$|[a-z0-9]Word$`.

- [ ] **Step 4:** Run — PASS. Export from the barrel.

- [ ] **Step 5: Commit** — `feat(explore): judge untyped method names by the project's verb vocabulary`.

---

### Task 5: Lexicon wiring — untyped `return` drafts judged, review stops skipping them

**Files:**
- Create: `src/core/api/internal/ops/naming-lexicon-method-evidence.ts`
- Modify: `src/core/domains/explore/naming-lexicon/verdicts.ts` (thin delegation)
- Modify: `src/core/api/internal/ops/naming-lexicon-ops.ts` (wiring only)
- Modify: `src/core/api/public/dto/naming-lexicon.ts` (`unknownReturnType` removed from `NamingReviewNotJudgedReason`)
- Test: `tests/core/api/internal/ops/naming-lexicon-untyped-methods.test.ts`,
  `tests/core/domains/explore/naming-lexicon/verdicts.test.ts` (new describe)

**Interfaces:**
- Consumes: Task 3 reads, Task 4 functions.
- Produces:

```ts
// naming-lexicon-method-evidence.ts
export async function readUntypedMethodEvidence(
  reader: IdentifierReader,                    // already scopedEvidence-wrapped
  drafts: readonly { name: string }[],         // untyped return drafts
  scope: { pathPrefixes: string[] | undefined; nonProductionPaths: TypeNameQuery["nonProductionPaths"] },
  declared: ReadonlySet<string>,               // existingSymbolShortNames result the judge already has
): Promise<(name: string) => UntypedMethodEvidence>;
// verdicts.ts — JudgeDraftNameInput gains:
untypedMethod?: UntypedMethodEvidence;
```

- [ ] **Step 1: Write failing tests.**
  - verdicts: a `return` draft with no `type`, no `callee`, with
    `untypedMethod` → the `judgeUntypedMethodName` verdict (one MISFIT case,
    one NO_CONVENTION case); without `untypedMethod` → unchanged bare
    NEW_TERM (pins backward behaviour for callers that pass nothing).
  - ops names mode (fixture style of `naming-lexicon-language-scope.test.ts`):
    Ruby symbols `load_user` ×3 holders, draft `{ name: "fetch_user", kind: "return" }`
    with `language: "ruby"` → `MISFIT`, `suggestion: "load_user"`.
  - ops diff mode (fixture style of `naming-lexicon-diff.test.ts`): a changed
    Ruby file adding `def fetch_user; end` beside indexed `load_user` methods →
    a `MISFIT` finding for `fetch_user`; `notJudgedBy` carries no
    `unknownReturnType`.
  This removes the `unknownReturnType` reason — the intended invariant change
  of D4; any existing test asserting it is updated in this task and named in
  the commit body.

- [ ] **Step 2:** Run — FAIL.

- [ ] **Step 3: Implement.**
  - `verdicts.ts` `judgeDraftName`: after the `overrides` early CONFORMS,
    `if (input.kind === "return" && input.typeName === undefined && input.callee === undefined && input.untypedMethod) return judgeUntypedMethodName({ name: input.name, casing: input.casing, evidence: input.untypedMethod });`
    — nothing else in the file changes.
  - `naming-lexicon-method-evidence.ts`: one `readMethodVerbs` per request
    (memoize on the `AnswerContext`'s alignment state like `typeNameRows`), one
    `readMethodNamesMatching` with every draft's tail pattern, one with every
    draft's last-word pattern; returns a lookup building
    `UntypedMethodEvidence` per draft name by filtering rows with the draft's
    own patterns.
  - `judgeDrafts` (ops): collect untyped return drafts; if any, call
    `readUntypedMethodEvidence(graphDb, …, taken)` and pass `untypedMethod`
    into `judgeDraftName` for them.
  - review: `unjudgedCallables` callables become value drafts
    `{ name, kind: "return" }` in `reviewDrafts` (owner from the callable's
    symbolId, as typed return drafts get it); drop the `unknownReturnType`
    branch from `notJudgedBreakdown` and the DTO union.

- [ ] **Step 4:** Run the new tests + `tests/core/api/internal/ops/naming-lexicon`
  + `tests/core/domains/explore/naming-lexicon` — PASS; `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit** — `feat(mcp): get_naming_lexicon judges untyped methods by method vocabulary`,
  body naming the `unknownReturnType` removal and each updated expectation.

---

### Task 6: `get_ontology_report` `verbs` section

**Files:**
- Modify: `src/core/api/public/dto/ontology.ts`
- Modify: `src/core/api/internal/ops/ontology-report-ops.ts`
- Modify: `src/mcp/tools/codegraph.ts` (sections enum)
- Test: `tests/core/api/internal/ops/ontology-report-verbs.test.ts`,
  `tests/mcp/tools/naming-lexicon-tool.test.ts` (budget stays green)

**Interfaces:**
- Consumes: `readMethodNamesMatching` with a verb-head pattern
  (`^(?:<lexicon verbs>)(?:_|[A-Z])`, `groupByLanguage: true`),
  `groupMethodsByTail`, `judgeUntypedMethodName`.
- Produces (DTO):

```ts
export type OntologyReportSectionName = "synonyms" | "homonyms" | "outliers" | "collisions" | "verbs";

/** One noun tail and the verbs the project reads it with (`load_user` ×7, `fetch_user` ×1). */
export interface OntologyVerbGroup {
  tail: string;
  language: string;
  holders: number;
  verbs: { verb: string; holders: number }[];
  /** Names off the tail's dominant verb, each with the name the lexicon would suggest. */
  deviants: { name: string; holders: number; suggestion: string }[];
}
// GetOntologyReportResponse gains: verbs?: OntologyVerbGroup[];
```

- [ ] **Step 1: Failing test:** seeded Ruby `load_user` ×3, `fetch_user` ×1,
  `load_account` ×2 and TS `loadUser` ×1 → `sections: ["verbs"]` returns the
  Ruby `user` group with `verbs` load 3 / fetch 1 and deviant
  `fetch_user → load_user`; the TS row forms its own group (never merged into
  Ruby); `account` has no deviant and ranks below `user`; omitting `sections`
  returns no `verbs` key (opt-in).

- [ ] **Step 2:** Run — FAIL.

- [ ] **Step 3: Implement.** `ALL_SECTIONS` stays the four; `verbs` only when
  requested. Group rows per language namespace, then per tail
  (`groupMethodsByTail`); deviants = names whose `judgeUntypedMethodName`
  against their own group is MISFIT; casing from the language profile's
  `naming.casing.method[0]`; rank groups by deviants' holders desc, then
  holders; cap by `limit`. The store-level `OntologyReportSection` union is
  NOT extended — the verbs section never touches `ontology-report-store.ts`.
  Add `"verbs"` to the zod enum; if the input schema passes 1 536 bytes, shorten
  existing `.describe()` text instead of raising the limit.

- [ ] **Step 4:** Run the new test, `tests/core/api/internal/ops/ontology-report*`,
  `tests/mcp` — PASS. `npx tsx scripts/measure-tools-list.ts` → record before →
  after bytes.

- [ ] **Step 5: Commit** — `feat(mcp): get_ontology_report verbs section`, tools/list
  bytes in the body.

---

### Task 7: Guidance surfaces

**Files:**
- Modify: `src/mcp/resources/registry.ts` (naming-lexicon overview + ontology examples)
- Modify: `.claude-plugin/tea-rags/skills/data-driven-generation/SKILL.md` (Step 5)
- Modify: `.claude-plugin/tea-rags/skills/mr-review/SKILL.md` or its
  `references/dimension-playbook.md` (naming dimension: `verbs`)
- Modify: both `plugin.json` (tea-rags 0.39.5 → 0.39.6; dinopowers only if touched)

- [ ] **Step 1:** Overview (caveman ultra): untyped `return` drafts judged by
  method vocabulary (verb of the noun tail, else project verbs; verbless →
  name use / analogues); Ruby `@@x`, `||=`, accessor macros are `field` rows;
  `verbs` section opt-in.
- [ ] **Step 2:** DDG Step 5: a `return` draft without `type` is judged — MISFIT
  `suggestion` swaps the verb; do not invent a type to get a verdict.
- [ ] **Step 3:** mr-review naming dimension: `sections=["verbs"]` for a
  method-naming audit.
- [ ] **Step 4:** Bump plugin versions; `scripts/inject-rules.sh --count` vs
  declared parts (only if a rule file grew).
- [ ] **Step 5: Commit** — `docs(mcp): guidance for untyped-method judgement and verbs`.

---

### Task 8: Gates

- [ ] **Step 1:** `npm run build` (no link), `npx tsc --noEmit`, `npx eslint` on
  every touched file.
- [ ] **Step 2:** `npm run test:coverage` once on the branch head (whole suite;
  thresholds are global). A threshold miss → `coverage-expander` subagent
  (background), never lowered thresholds.

---

### Task 9: Live validation (USER-GATED — ask first)

- [ ] **Step 1:** Take the heavy-measure lock (`mkdir ~/.claude/heavy-measure.lock.d`
  + `owner` file); check `node build/cli/index.js auto-update status --project <alias>`.
- [ ] **Step 2:** With explicit consent:
  `DEBUG=1 node build/cli/index.js index-codebase --project <alias> --force-enrichments codegraph --languages ruby --json`
  — `outcome.measured: true`, no `failed` / `degraded`.
- [ ] **Step 3:** Re-run Task 0's two calls; compare: accessor / `@@` / `||=`
  field rows appear in the review, untyped methods are findings or conforming
  (no `unknownReturnType`), `sections: ["verbs"]` returns groups. Record the
  wall-clock of the review call against the baseline on the largest corpus.
- [ ] **Step 4:** Release the lock; commit is authorized by a successful
  validation (worktree only, no push, no merge).
