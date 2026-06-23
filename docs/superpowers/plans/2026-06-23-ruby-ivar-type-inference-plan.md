# Ruby ivar Type-Inference Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the universal `CallContext.classFieldTypes` interface for
Ruby (the 5th implementation after TS/Java/Python/Rust) — infer `@ivar` receiver
types so calls on them resolve to concrete in-project class methods; gem-typed
ivars route to `externalSkipped` via the honest denominator.

**Architecture:** A walker collector `collectRubyIvarFieldTypes` populates the
EXISTING `FileExtraction.classFieldTypes` field (zero contract change). A new
chain pass `RubyIvarFieldSymbolResolutionStrategy` consumes
`ctx.classFieldTypes[scope]["@ivar"]` and reuses a shared `resolveTypeMethod`
(extracted from `RubyLocalTypeSymbolResolutionStrategy`'s private
`resolveByLocalTypeInternal` into `shared.ts`). `RubyExternalVocabulary` gains
an `@ivar` gem branch. The `RubyCallResolver` facade DI-wires the new strategy
into its constructor chain. Mirrors the Python `self.field` precedent exactly.

**Tech Stack:** TypeScript (ESM), vitest, tree-sitter-ruby (parsing not changed
— only AST walks added).

## Global Constraints

- Universal interface = the EXISTING `CallContext.classFieldTypes` data-shape
  contract; Ruby becomes its 5th implementation (after TS/Java/Python/Rust). NO
  new engine/Provider abstraction.
- `CallResolver` (`contracts/types/codegraph.ts`) and `LanguageSymbolResolver`
  (`contracts/types/language.ts`) signatures are IMMUTABLE (the 5-language
  seam). NO contract change is required — `classFieldTypes` already exists.
- Business-logic tests are IMMUTABLE: move OK, rewrite NO. `strategies.test.ts`
  (ruby local-type cases), `ruby-resolver-dispatch.test.ts`,
  `ruby-resolver-external-import.test.ts`, `ruby-resolver.test.ts` are the
  regression net — they stay green; only ADD ivar cases (additive).
- TDD red→green for every NET-NEW unit (`collectRubyIvarFieldTypes`,
  `RubyIvarFieldSymbolResolutionStrategy`, `RubyExternalVocabulary` ivar
  branch). The codegraph `resolveSuccessRate` is EXPECTED to rise — this is a
  behaviour change, NOT a byte-identical refactor.
- Task 3 (`resolveTypeMethod` extraction) is RELOCATION: relocate code only,
  existing tests stay green, NO new tests written during the move.
- No eslint-disable; never lower coverage thresholds; no `v8 ignore` as a
  shortcut.
- Conventional commits: `feat`/`improve`/`refactor(trajectory)`; header ≤100
  chars; the Task 6 `ruby-resolver.ts` hub commit needs a silo-pairing `Why:`
  line.
- Worktree `.claude/worktrees/ruby-dsl-decomposition`. Ephemeral branch — do NOT
  push. commit ≠ merge ≠ push.
- Quality gates per task: `npx vitest run` green, `tsc` 0 errors, eslint 0
  (pre-commit runs tests + coverage + type-check in parallel).
- Live huginn validation is post-merge + user-gated (reindex rewrites the shared
  Qdrant index) — NOT a code task; see Final section.

---

## File Structure

| File                                                                    | Responsibility                                                               | Task |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---- |
| `src/core/domains/language/ruby/walker/local-bindings.ts`               | +`collectRubyIvarFieldTypes` (reuses `constInstanceType`)                    | 1    |
| `src/core/domains/language/ruby/walker/walker.ts`                       | `extractFromRubyFile` calls collector, sets `FileExtraction.classFieldTypes` | 2    |
| `src/core/domains/language/ruby/resolver/strategies/shared.ts`          | +`resolveTypeMethod` (relocated from ruby-local-type)                        | 3    |
| `src/core/domains/language/ruby/resolver/strategies/ruby-local-type.ts` | delegate to `shared.resolveTypeMethod`                                       | 3    |
| `src/core/domains/language/ruby/resolver/strategies/ruby-ivar-field.ts` | NEW `RubyIvarFieldSymbolResolutionStrategy`                                  | 4    |
| `src/core/domains/language/ruby/resolver/strategies/index.ts`           | barrel export new strategy                                                   | 4    |
| `src/core/domains/language/ruby/resolver/ruby-external-vocabulary.ts`   | `@ivar` gem branch in `isQualifiedReceiverExternal`                          | 5    |
| `src/core/domains/language/ruby/resolver/ruby-resolver.ts`              | constructor: DI-wire new strategy (HUB — chain assembly only)                | 6    |

**Sequencing:** bottom-up. Walker (1, 2) → shared relocation (3) → strategy (4)
→ external branch (5) → facade wiring (6). The fanIn-9 facade switches LAST,
after every collaborator exists and is tested.

---

### Task 1: Walker collector `collectRubyIvarFieldTypes` (net-new, TDD)

**Files:**

- Modify: `src/core/domains/language/ruby/walker/local-bindings.ts` (add export
  beside `constInstanceType` / `collectLocalBindingsForChunk`)
- Test: `tests/core/domains/language/ruby/walker/ruby-walker.test.ts` (new
  `describe` block)

**Interfaces:**

- Consumes: `constInstanceType(node: AstNode): string | null` (existing in this
  file — returns the constructor type name for `Const.new` / instance-returning
  factory, else `null`); `walk(root, visit)` and `AstNode` (existing imports).
- Produces:
  `collectRubyIvarFieldTypes(root: AstNode): Record<string, Record<string, string>>`
  — `Record<className, Record<"@ivar", typeName>>`. Consumed by Task 2 (walker
  wiring).

**Behaviour:** walk each `class` / `module` body; for an `assignment` whose LHS
is an `instance_variable` (`@client`) and whose RHS yields a type via
`constInstanceType`, record `out[className]["@client"] = typeName`. Within-file
conflict → last-write-wins (mirror `collectPythonClassFieldTypes`). Non-`@ivar`
LHS, non-constructor RHS, and chained LHS (`@a.b = …`) record nothing.

- [ ] **Step 1: Write the failing test**

Add to `tests/core/domains/language/ruby/walker/ruby-walker.test.ts` (top:
`import { collectRubyIvarFieldTypes } from "../../../../../../src/core/domains/language/ruby/walker/local-bindings.js";`
and reuse the file's existing tree-sitter parse helper — match the helper name
already used by the `localBindings` describe blocks, e.g. `parseRuby(src)`
returning the root node):

```typescript
describe("collectRubyIvarFieldTypes (ivar → type, classFieldTypes channel)", () => {
  it("records @ivar = Const.new under the enclosing class", () => {
    const root = parseRuby(`
      class Foo
        def initialize
          @client = HttpClient.new
        end
      end
    `);
    expect(collectRubyIvarFieldTypes(root)).toEqual({
      Foo: { "@client": "HttpClient" },
    });
  });

  it("last-write-wins on a within-class conflict", () => {
    const root = parseRuby(`
      class Foo
        def initialize; @client = HttpClient.new; end
        def reset; @client = FakeClient.new; end
      end
    `);
    expect(collectRubyIvarFieldTypes(root)).toEqual({
      Foo: { "@client": "FakeClient" },
    });
  });

  it("skips a lowercase / non-constructor RHS", () => {
    const root = parseRuby(`
      class Foo
        def initialize; @client = build_client; end
      end
    `);
    expect(collectRubyIvarFieldTypes(root)).toEqual({});
  });

  it("skips a local-variable assignment (not an ivar)", () => {
    const root = parseRuby(`
      class Foo
        def initialize; client = HttpClient.new; end
      end
    `);
    expect(collectRubyIvarFieldTypes(root)).toEqual({});
  });

  it("keys ivars of a nested-namespace class by its full scope name", () => {
    const root = parseRuby(`
      module Agents
        class WebsiteAgent
          def initialize; @parser = HtmlParser.new; end
        end
      end
    `);
    expect(collectRubyIvarFieldTypes(root)).toEqual({
      "Agents::WebsiteAgent": { "@parser": "HtmlParser" },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
`npx vitest run tests/core/domains/language/ruby/walker/ruby-walker.test.ts -t "collectRubyIvarFieldTypes"`
Expected: FAIL — `collectRubyIvarFieldTypes is not a function` (export not
defined).

- [ ] **Step 3: Write minimal implementation**

Add to `src/core/domains/language/ruby/walker/local-bindings.ts` (beside
`constInstanceType`). The class-name scoping mirrors how the file already
derives scope; if a `className(node)` / scope helper exists in
`walker/ast-utils.js`, import and reuse it rather than re-deriving. Minimal
self-contained version:

```typescript
/**
 * Per-class `@ivar -> typeName` map for the universal `classFieldTypes` channel
 * (Ruby is the 5th implementation after TS/Java/Python/Rust). Walks each class /
 * module body and records `@ivar = Const.new` constructor assignments across ALL
 * methods of the class. Mirrors `collectPythonClassFieldTypes`: within-class
 * conflict is last-write-wins; non-constructor RHS records nothing (the constant
 * gate lives in `constInstanceType`). The `@`-prefixed key matches the call-site
 * receiver text verbatim (`@client`).
 */
export function collectRubyIvarFieldTypes(
  root: AstNode,
): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  walk(root, (node) => {
    if (node.type !== "class" && node.type !== "module") return;
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return;
    const className = readScopeResolution(nameNode); // "Foo" or "Agents::WebsiteAgent"
    const body = node.childForFieldName("body");
    if (!body) return;
    const fields: Record<string, string> = {};
    walk(body, (inner) => {
      if (inner.type !== "assignment") return;
      const lhs = inner.childForFieldName("left");
      if (lhs?.type !== "instance_variable") return; // @client; skips locals + @a.b
      const rhs = inner.childForFieldName("right");
      if (!rhs) return;
      const type = constInstanceType(rhs);
      if (type) fields[lhs.text] = type; // last-write-wins
    });
    if (Object.keys(fields).length > 0) {
      out[className] = { ...(out[className] ?? {}), ...fields };
    }
  });
  return out;
}
```

Notes for the implementer:

- `readScopeResolution` already exists in `local-bindings.ts` (used by
  `constInstanceType`); it renders a `scope_resolution` node as `A::B`. For a
  bare `constant` name node it returns the text. Confirm it handles the
  bare-`constant` case; if not, fall back to `nameNode.text` when
  `nameNode.type === "constant"`.
- The inner `walk(body, …)` descends into nested classes too. If a test for a
  nested class inside another class shows cross-attribution, scope the inner
  walk to stop at nested `class`/`module` nodes (the outer `walk` visits them
  separately) — add
  `if (inner !== body && (inner.type === "class" || inner.type === "module")) return;`
  guard mirroring `collectMethodLocalBindings`'s nested-method guard. Add this
  only if a test requires it (YAGNI).

- [ ] **Step 4: Run test to verify it passes**

Run:
`npx vitest run tests/core/domains/language/ruby/walker/ruby-walker.test.ts -t "collectRubyIvarFieldTypes"`
Expected: PASS (5 cases).

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/language/ruby/walker/local-bindings.ts tests/core/domains/language/ruby/walker/ruby-walker.test.ts
git commit -m "feat(trajectory): collect Ruby @ivar constructor types into classFieldTypes channel"
```

---

### Task 2: Walker wiring — set `FileExtraction.classFieldTypes` (additive)

**Files:**

- Modify: `src/core/domains/language/ruby/walker/walker.ts`
  (`extractFromRubyFile`, ~line 77-142)
- Test: `tests/core/domains/language/ruby/walker/ruby-walker.test.ts` (extend
  with an `extractFromRubyFile` assertion)

**Interfaces:**

- Consumes: `collectRubyIvarFieldTypes` (Task 1);
  `FileExtraction.classFieldTypes?: Record<string, Record<string, string>>`
  (ALREADY exists in `contracts/types/codegraph.ts` — set by TS/Java/Python/Rust
  walkers; Ruby is adding its setter).
- Produces: `extractFromRubyFile` now returns `classFieldTypes` on its
  `FileExtraction` when ivar types were found. Consumed downstream by
  `provider.ts` → `CallContext.classFieldTypes` (existing propagation, no
  change).

- [ ] **Step 1: Write the failing test**

Add to `ruby-walker.test.ts` (reuse the existing `extractFromRubyFile` helper
the file already uses for `localBindings` extraction assertions):

```typescript
describe("extractFromRubyFile — classFieldTypes (ivar inference)", () => {
  it("surfaces @ivar constructor types on the FileExtraction", () => {
    const extraction = extractFromRubyFile(
      "app/models/foo.rb",
      `
      class Foo
        def initialize
          @client = HttpClient.new
        end
      end
    `,
    );
    expect(extraction.classFieldTypes).toEqual({
      Foo: { "@client": "HttpClient" },
    });
  });

  it("omits classFieldTypes when no ivar constructor types are present", () => {
    const extraction = extractFromRubyFile(
      "app/models/bar.rb",
      `
      class Bar
        def run; helper; end
      end
    `,
    );
    expect(extraction.classFieldTypes).toBeUndefined();
  });
});
```

(If `extractFromRubyFile`'s test helper signature differs — e.g. it takes
`(source)` only or a parsed tree — match the existing `localBindings`
describe-block invocation in this same file verbatim.)

- [ ] **Step 2: Run test to verify it fails**

Run:
`npx vitest run tests/core/domains/language/ruby/walker/ruby-walker.test.ts -t "classFieldTypes (ivar inference)"`
Expected: FAIL — `extraction.classFieldTypes` is `undefined` for the first case.

- [ ] **Step 3: Write minimal implementation**

In `src/core/domains/language/ruby/walker/walker.ts`, inside
`extractFromRubyFile`, after the `FileExtraction` object (`out`/`base`) is built
and before it is returned, add (import `collectRubyIvarFieldTypes` from
`./local-bindings.js` at the top):

```typescript
const ivarFieldTypes = collectRubyIvarFieldTypes(input.tree.rootNode);
if (Object.keys(ivarFieldTypes).length > 0)
  out.classFieldTypes = ivarFieldTypes;
```

Match the surrounding code's variable name for the extraction object (`out` /
`base` / `extraction`) and the root-node accessor (`input.tree.rootNode` —
confirm against how `extractFromRubyFile` already reads the tree; line ~104 uses
`input.tree.rootNode` for `collectLocalBindingsForChunk`). Place the snippet
next to the existing `localBindings` / `classAncestors` setters so all
`FileExtraction` fields are populated in one place (colocation).

- [ ] **Step 4: Run test to verify it passes**

Run:
`npx vitest run tests/core/domains/language/ruby/walker/ruby-walker.test.ts -t "classFieldTypes (ivar inference)"`
Expected: PASS (2 cases).

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/language/ruby/walker/walker.ts tests/core/domains/language/ruby/walker/ruby-walker.test.ts
git commit -m "feat(trajectory): wire Ruby walker to emit classFieldTypes from @ivar inference"
```

---

### Task 3: Relocate `resolveTypeMethod` into `shared.ts` (RELOCATION — no new tests)

**Files:**

- Modify: `src/core/domains/language/ruby/resolver/strategies/shared.ts` (add
  `resolveTypeMethod` export)
- Modify:
  `src/core/domains/language/ruby/resolver/strategies/ruby-local-type.ts`
  (delegate to it)
- Regression net (DO NOT EDIT):
  `tests/core/domains/language/ruby/resolver/strategies/strategies.test.ts`
  (RubyLocalType cases),
  `tests/core/domains/language/ruby/resolver/ruby-resolver.test.ts`
  (resolveByLocalType cases)

**Interfaces:**

- Consumes: existing `resolveConstant`, `lastConstantSegment`,
  `pickSingleCandidate` (already in `shared.ts`); `CallContext`,
  `SymbolResolutionTarget` types.
- Produces:
  `resolveTypeMethod(typeName: string, member: string, ctx: CallContext): SymbolResolutionTarget | null`
  in `shared.ts`. Consumed by `ruby-local-type.ts` (this task) and
  `ruby-ivar-field.ts` (Task 4).

This is a behaviour-identical move: the body of
`RubyLocalTypeSymbolResolutionStrategy#resolveByLocalTypeInternal` (incl.
`prepend` MRO walk, `classAncestors` walk, file-only fallback, cycle-guard
`visited` Set) moves verbatim into a free function in `shared.ts`. The metric
must not move. NO new tests written during the move (relocation discipline) —
the existing local-type tests are the regression net.

- [ ] **Step 1: Add `resolveTypeMethod` to `shared.ts`**

Move the `resolveByLocalTypeInternal` body verbatim into `shared.ts`, renamed,
with the recursion guard kept as an inner helper (or an optional `visited`
param). Exact relocation:

```typescript
/**
 * Resolve `<typeName>#<member>` against the symbol table: the type's file via
 * `resolveConstant`, then the method within that file's class scope, walking
 * `prepend` modules (reverse MRO) and `classAncestors` (declaration order),
 * falling back to a file-only edge when the file is known but the method is
 * inherited from outside the project. `null` when the type's file is unknown
 * (gem / stdlib). Relocated verbatim from RubyLocalTypeSymbolResolutionStrategy
 * so both the local-var and @ivar strategies share one lookup.
 */
export function resolveTypeMethod(
  typeName: string,
  member: string,
  ctx: CallContext,
): SymbolResolutionTarget | null {
  return resolveTypeMethodInternal(typeName, member, ctx, new Set());
}

function resolveTypeMethodInternal(
  typeName: string,
  member: string,
  ctx: CallContext,
  visited: Set<string>,
): SymbolResolutionTarget | null {
  // <<< paste the EXACT current body of resolveByLocalTypeInternal here,
  //     replacing recursive `this.resolveByLocalTypeInternal(...)` calls with
  //     `resolveTypeMethodInternal(...)` >>>
}
```

Ensure `shared.ts` already imports everything the body uses (`resolveConstant`,
`lastConstantSegment`, `pickSingleCandidate`, `CallContext`,
`SymbolResolutionTarget`) —
`resolveConstant`/`lastConstantSegment`/`pickSingleCandidate` are defined IN
`shared.ts`, so no new import for those; add the type imports if absent.

- [ ] **Step 2: Delegate in `ruby-local-type.ts`**

Replace `resolveByLocalType`'s body and delete the private
`resolveByLocalTypeInternal`:

```typescript
import { /* …existing… */ resolveTypeMethod } from "./shared.js";

// inside RubyLocalTypeSymbolResolutionStrategy:
private resolveByLocalType(typeName: string, member: string, ctx: CallContext): SymbolResolutionTarget | null {
  return resolveTypeMethod(typeName, member, ctx);
}
```

Remove the now-unused `resolveByLocalTypeInternal` method and any imports it
alone used (e.g. if `lastConstantSegment` is no longer referenced in
`ruby-local-type.ts`). Do NOT touch `attempt` / `resolveByLocalType`'s call
sites.

- [ ] **Step 3: Run the regression net — must stay green untouched**

Run:
`npx vitest run tests/core/domains/language/ruby/resolver/strategies/strategies.test.ts tests/core/domains/language/ruby/resolver/ruby-resolver.test.ts`
Expected: PASS — all existing `RubyLocalType` and `resolveByLocalType` cases
green, unchanged. If any fail, the move was not byte-identical — fix the
relocation, do NOT edit the tests.

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit` Expected: 0 errors (no dangling reference to the removed
private method).

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/language/ruby/resolver/strategies/shared.ts src/core/domains/language/ruby/resolver/strategies/ruby-local-type.ts
git commit -m "refactor(trajectory): extract resolveTypeMethod into shared for reuse by ivar strategy"
```

---

### Task 4: `RubyIvarFieldSymbolResolutionStrategy` (net-new, TDD)

**Files:**

- Create:
  `src/core/domains/language/ruby/resolver/strategies/ruby-ivar-field.ts`
- Modify: `src/core/domains/language/ruby/resolver/strategies/index.ts` (barrel
  export)
- Test:
  `tests/core/domains/language/ruby/resolver/strategies/strategies.test.ts` (new
  `describe` block — additive)

**Interfaces:**

- Consumes: `SymbolResolutionStrategy`, `SymbolResolutionOutcome`, `CONTINUE`,
  `DROP`, `resolved` (from `contracts/resolution.js` /
  `contracts/types/language.js` — see how `ruby-local-type.ts` imports them);
  `resolveTypeMethod` (Task 3); `ResolverConfig`, `CallRef`, `CallContext`.
- Produces: `RubyIvarFieldSymbolResolutionStrategy` (class implementing
  `SymbolResolutionStrategy`). Consumed by Task 6 (facade wiring) and exported
  via the barrel.

Outcome ladder (mirror `PythonSelfFieldSymbolResolutionStrategy#attempt`,
diverging only on gem-type — Ruby DROPs instead of best-effort resolved, so the
gem call routes to `externalSkipped` via Task 5):

- receiver not `/^@\w+$/`, or `callerScope` empty → `CONTINUE`
- typeName not recorded for the ivar → `DROP` (never fall through to fabricate)
- typeName recorded → `resolveTypeMethod`; non-null → `resolved`; null (gem) →
  `DROP`

- [ ] **Step 1: Write the failing test**

Add to `tests/core/domains/language/ruby/resolver/strategies/strategies.test.ts`
(reuse the file's existing `ctx({...})`, `tableWith([...])`, `sym(...)` helpers
— the RubyLocalType describe block in the same file shows their exact shapes):

```typescript
describe("RubyIvarFieldSymbolResolutionStrategy", () => {
  const strat = new RubyIvarFieldSymbolResolutionStrategy(cfg);
  const call: CallRef = {
    callText: "@client.get",
    receiver: "@client",
    member: "get",
    startLine: 1,
  };

  it("resolves @ivar.X via the recorded field type", () => {
    const symbolTable = tableWith([
      "app/clients/http_client.rb",
      [
        sym("HttpClient", "HttpClient", "app/clients/http_client.rb", []),
        sym("HttpClient#get", "get", "app/clients/http_client.rb", [
          "HttpClient",
        ]),
      ],
    ]);
    const outcome = strat.attempt(
      call,
      ctx({
        symbolTable,
        callerScope: ["Foo"],
        classFieldTypes: { Foo: { "@client": "HttpClient" } },
      }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: {
        targetRelPath: "app/clients/http_client.rb",
        targetSymbolId: "HttpClient#get",
      },
    });
  });

  it("resolves to a file-only edge when the type's file is known but the method is not", () => {
    const symbolTable = tableWith([
      "app/clients/http_client.rb",
      [sym("HttpClient", "HttpClient", "app/clients/http_client.rb", [])],
    ]);
    const outcome = strat.attempt(
      call,
      ctx({
        symbolTable,
        callerScope: ["Foo"],
        classFieldTypes: { Foo: { "@client": "HttpClient" } },
      }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: {
        targetRelPath: "app/clients/http_client.rb",
        targetSymbolId: null,
      },
    });
  });

  it("DROPS when the ivar has no recorded type — never falls through", () => {
    const symbolTable = tableWith([
      "other.rb",
      [sym("Other#get", "get", "other.rb", ["Other"])],
    ]);
    const outcome = strat.attempt(
      call,
      ctx({ symbolTable, callerScope: ["Foo"], classFieldTypes: { Foo: {} } }),
    );
    expect(outcome.kind).toBe("drop");
  });

  it("DROPS when the recorded type is a gem (no project file) — routes to external, not resolved", () => {
    const symbolTable = tableWith(); // Net::HTTP not in the project
    const outcome = strat.attempt(
      { ...call, receiver: "@http", member: "get" },
      ctx({
        symbolTable,
        callerScope: ["Foo"],
        classFieldTypes: { Foo: { "@http": "Net::HTTP" } },
      }),
    );
    expect(outcome.kind).toBe("drop");
  });

  it("continues when the receiver is not a single ivar (chained @a.b)", () => {
    const outcome = strat.attempt(
      { ...call, receiver: "@a.b" },
      ctx({
        symbolTable: tableWith(),
        callerScope: ["Foo"],
        classFieldTypes: { Foo: { "@a": "A" } },
      }),
    );
    expect(outcome.kind).toBe("continue");
  });

  it("continues outside a class scope (callerScope empty)", () => {
    const outcome = strat.attempt(
      call,
      ctx({
        symbolTable: tableWith(),
        classFieldTypes: { Foo: { "@client": "HttpClient" } },
      }),
    );
    expect(outcome.kind).toBe("continue");
  });

  it("continues when the receiver is not an ivar", () => {
    const outcome = strat.attempt(
      { ...call, receiver: "user" },
      ctx({
        symbolTable: tableWith(),
        callerScope: ["Foo"],
        classFieldTypes: { Foo: { "@client": "HttpClient" } },
      }),
    );
    expect(outcome.kind).toBe("continue");
  });
});
```

Add `RubyIvarFieldSymbolResolutionStrategy` to the test file's import from
`strategies/index.js`.

- [ ] **Step 2: Run test to verify it fails**

Run:
`npx vitest run tests/core/domains/language/ruby/resolver/strategies/strategies.test.ts -t "RubyIvarFieldSymbolResolutionStrategy"`
Expected: FAIL — class not exported / not a constructor.

- [ ] **Step 3: Write minimal implementation**

Create `src/core/domains/language/ruby/resolver/strategies/ruby-ivar-field.ts`
(match the import paths used by `ruby-local-type.ts` for
`CONTINUE`/`DROP`/`resolved`/`SymbolResolutionOutcome` and
`SymbolResolutionStrategy`):

```typescript
import {
  CONTINUE,
  DROP,
  resolved,
  type SymbolResolutionOutcome,
} from "../../../../../contracts/resolution.js";
import type {
  CallContext,
  CallRef,
} from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { resolveTypeMethod, type ResolverConfig } from "./shared.js";

const IVAR_RECEIVER = /^@\w+$/;

/**
 * `@ivar.X` resolution via the walker-inferred `classFieldTypes` channel (the
 * universal type-inference interface; Ruby is its 5th implementation). A single
 * `@ivar` receiver whose type was recorded from a constructor assignment
 * (`@client = HttpClient.new`) resolves `<type>#<member>` via the shared
 * `resolveTypeMethod`. Mirrors PythonSelfFieldSymbolResolutionStrategy with one
 * divergence: a gem type (no project file) DROPS rather than emitting a
 * best-effort external target — the gem call is reclassified as external by
 * RubyExternalVocabulary so it leaves the resolveSuccessRate denominator
 * (honest denominator, cai0). A `@ivar` access is an instance-field receiver,
 * never an import/global name, so an unrecorded ivar DROPS rather than falling
 * through to the ambiguous short-name path.
 */
export class RubyIvarFieldSymbolResolutionStrategy implements SymbolResolutionStrategy {
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    const receiver = call.receiver;
    if (
      !receiver ||
      !IVAR_RECEIVER.test(receiver) ||
      ctx.callerScope.length === 0
    )
      return CONTINUE;
    const enclosing = ctx.callerScope.join("::");
    const typeName = ctx.classFieldTypes?.[enclosing]?.[receiver];
    if (!typeName) return DROP;
    const target = resolveTypeMethod(typeName, call.member, ctx);
    return target ? resolved(target) : DROP;
  }
}
```

Implementer notes:

- Confirm `CONTINUE` / `DROP` / `resolved` / `SymbolResolutionOutcome` are
  imported from the SAME module `ruby-local-type.ts` imports them from (the
  snippet assumes `contracts/resolution.js`; adjust the path/symbol names to
  match the existing strategy files exactly).
- `ResolverConfig` is exported from `./shared.js` (it is re-exported via the
  strategies barrel; `shared.js` is its origin per `ruby-resolver.ts`'s import).
  If `resolveTypeMethod` and `ResolverConfig` come from different modules in
  practice, import each from its real origin.
- `this.cfg` is held for parity with sibling strategies (mode-dependent
  candidate picking happens inside `resolveTypeMethod` via
  `pickSingleCandidate(..., ctx)`-style helpers); keep the field even if unused
  directly, matching `RubyConeTypeLocator`'s constructor.

- [ ] **Step 4: Barrel export**

Add to `src/core/domains/language/ruby/resolver/strategies/index.ts`:

```typescript
export { RubyIvarFieldSymbolResolutionStrategy } from "./ruby-ivar-field.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run:
`npx vitest run tests/core/domains/language/ruby/resolver/strategies/strategies.test.ts -t "RubyIvarFieldSymbolResolutionStrategy"`
Expected: PASS (7 cases).

- [ ] **Step 6: Commit**

```bash
git add src/core/domains/language/ruby/resolver/strategies/ruby-ivar-field.ts src/core/domains/language/ruby/resolver/strategies/index.ts tests/core/domains/language/ruby/resolver/strategies/strategies.test.ts
git commit -m "feat(trajectory): add RubyIvarFieldSymbolResolutionStrategy for @ivar receiver resolution"
```

---

### Task 5: `RubyExternalVocabulary` @ivar gem branch (net-new, TDD)

**Files:**

- Modify: `src/core/domains/language/ruby/resolver/ruby-external-vocabulary.ts`
  (`isQualifiedReceiverExternal`)
- Test:
  `tests/core/domains/language/ruby/resolver/ruby-resolver-external-import.test.ts`
  (ADD cases — existing immutable)

**Interfaces:**

- Consumes: existing `resolveConstant` (already imported in this file),
  `CallContext`, `SUPER_RECEIVER_SENTINEL` (existing).
  `CallContext.classFieldTypes` + `callerScope`.
- Produces: `isQualifiedReceiverExternal` now also returns `true` for an `@ivar`
  receiver whose recorded type is a gem. The `targetsExternalImport` facade
  method (unchanged) routes this to `externalSkipped`.

Current method (from `ruby-external-vocabulary.ts`):

```typescript
isQualifiedReceiverExternal(receiver: string, ctx: CallContext): boolean {
  if (receiver === SUPER_RECEIVER_SENTINEL) return superTargetsExternal(ctx);
  return /^[A-Z]/.test(receiver) && resolveConstant(receiver, ctx) === null;
}
```

- [ ] **Step 1: Write the failing test**

Add to
`tests/core/domains/language/ruby/resolver/ruby-resolver-external-import.test.ts`
(within the existing `describe("RubyCallResolver.targetsExternalImport", …)`,
using the file's existing `makeCtx` / `resolver` — note `makeCtx` currently
builds `callerScope: []`; pass `callerScope` + `classFieldTypes` explicitly via
a `CallContext` literal as the super tests in this file already do):

```typescript
// cai0 imass — an @ivar whose inferred type is a gem (no project file) is honestly
// external: the ivar strategy DROPs it, and it must leave the denominator like any
// gem call, NOT remain an internal-miss. An in-project ivar type is NOT external
// (the ivar strategy resolves it); an unrecorded ivar is NOT external (stays an
// attempted-unresolved internal miss).
it("flags an @ivar call whose recorded type is a gem (Net::HTTP)", () => {
  const call: CallRef = {
    callText: "@http.get(uri)",
    receiver: "@http",
    member: "get",
    startLine: 3,
  };
  const ctx: CallContext = {
    callerFile: "app/services/fetcher.rb",
    callerScope: ["Fetcher"],
    imports: [],
    symbolTable: new InMemoryGlobalSymbolTable(),
    classFieldTypes: { Fetcher: { "@http": "Net::HTTP" } },
  };
  expect(resolver.targetsExternalImport(call, ctx)).toBe(true);
});

it("does NOT flag an @ivar call whose recorded type resolves to a project file", () => {
  const table = new InMemoryGlobalSymbolTable();
  table.upsertFile("app/models/user.rb", [
    {
      symbolId: "User",
      fqName: "User",
      shortName: "User",
      relPath: "app/models/user.rb",
      scope: [],
    },
  ]);
  const call: CallRef = {
    callText: "@user.save",
    receiver: "@user",
    member: "save",
    startLine: 3,
  };
  const ctx: CallContext = {
    callerFile: "app/services/fetcher.rb",
    callerScope: ["Fetcher"],
    imports: [],
    symbolTable: table,
    classFieldTypes: { Fetcher: { "@user": "User" } },
  };
  expect(resolver.targetsExternalImport(call, ctx)).toBe(false);
});

it("does NOT flag an @ivar call with no recorded type", () => {
  const call: CallRef = {
    callText: "@x.save",
    receiver: "@x",
    member: "save",
    startLine: 3,
  };
  const ctx: CallContext = {
    callerFile: "app/services/fetcher.rb",
    callerScope: ["Fetcher"],
    imports: [],
    symbolTable: new InMemoryGlobalSymbolTable(),
    classFieldTypes: { Fetcher: {} },
  };
  expect(resolver.targetsExternalImport(call, ctx)).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
`npx vitest run tests/core/domains/language/ruby/resolver/ruby-resolver-external-import.test.ts -t "@ivar"`
Expected: FAIL — the gem-ivar case returns `false` (current method ignores
`@`-receivers; `/^[A-Z]/` is false for `@http`).

- [ ] **Step 3: Write minimal implementation**

Edit `isQualifiedReceiverExternal` in `ruby-external-vocabulary.ts` — add the
`@ivar` branch BEFORE the constant branch:

```typescript
const IVAR_RECEIVER = /^@\w+$/;

isQualifiedReceiverExternal(receiver: string, ctx: CallContext): boolean {
  if (receiver === SUPER_RECEIVER_SENTINEL) return superTargetsExternal(ctx);
  if (IVAR_RECEIVER.test(receiver)) return ivarTargetsExternal(receiver, ctx);
  return /^[A-Z]/.test(receiver) && resolveConstant(receiver, ctx) === null;
}
```

Add the helper (file-local, mirroring `superTargetsExternal`):

```typescript
/**
 * An `@ivar` receiver whose walker-inferred type (`classFieldTypes`) resolves to
 * NO project file is a gem / stdlib instance (`@http = Net::HTTP.new`): the ivar
 * strategy DROPs it, so it reaches this classifier unresolved and is honestly
 * external — excluded from the resolveSuccessRate denominator, not an internal
 * miss (cai0 imass). An in-project type → false (the strategy resolved it). An
 * unrecorded ivar → false (genuinely attempted-unresolved; we don't know it's a gem).
 */
function ivarTargetsExternal(receiver: string, ctx: CallContext): boolean {
  if (ctx.callerScope.length === 0) return false;
  const typeName =
    ctx.classFieldTypes?.[ctx.callerScope.join("::")]?.[receiver];
  return typeName !== undefined && resolveConstant(typeName, ctx) === null;
}
```

- [ ] **Step 4: Run the new + existing external-import tests**

Run:
`npx vitest run tests/core/domains/language/ruby/resolver/ruby-resolver-external-import.test.ts`
Expected: PASS — 3 new `@ivar` cases green, ALL pre-existing cases (constant,
bare-call, super) still green.

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/language/ruby/resolver/ruby-external-vocabulary.ts tests/core/domains/language/ruby/resolver/ruby-resolver-external-import.test.ts
git commit -m "improve(trajectory): classify gem-typed @ivar calls as external (honest denominator)"
```

---

### Task 6: Facade DI wiring — insert the ivar strategy into the chain (the HUB)

**Files:**

- Modify: `src/core/domains/language/ruby/resolver/ruby-resolver.ts`
  (constructor chain assembly ONLY, ~line 93-102)
- Test: `tests/core/domains/language/ruby/resolver/ruby-resolver.test.ts` (NEW
  additive `describe` only — existing describes immutable)

**Interfaces:**

- Consumes: `RubyIvarFieldSymbolResolutionStrategy` (Task 4) via the strategies
  barrel; `cfg: ResolverConfig` (existing constructor local).
- Produces: end-to-end `@ivar.X` resolution through the public `resolve` method
  (no signature change).

`ruby-resolver.ts` is a fanIn-9 HUB. Touch ONLY the `this.strategies = [...]`
array. Do NOT touch `resolve` / `resolveDispatch` / `targetsExternalImport` /
`resolveFileEdges` bodies. Place the ivar pass right after
`RubyLocalTypeSymbolResolutionStrategy` (both are walker-inferred-type passes; a
typed ivar must win over `constant` / `bareCall`).

- [ ] **Step 1: Write the failing integration test**

Add a NEW `describe` to
`tests/core/domains/language/ruby/resolver/ruby-resolver.test.ts` (do not modify
existing describes; reuse the file's existing `InMemoryGlobalSymbolTable` +
`CallContext` construction idiom):

```typescript
describe("RubyCallResolver — @ivar type-inference resolution (end-to-end, cai0 imass)", () => {
  it("resolves @client.get to the inferred HttpClient#get", () => {
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("app/clients/http_client.rb", [
      {
        symbolId: "HttpClient",
        fqName: "HttpClient",
        shortName: "HttpClient",
        relPath: "app/clients/http_client.rb",
        scope: [],
      },
      {
        symbolId: "HttpClient#get",
        fqName: "HttpClient#get",
        shortName: "get",
        relPath: "app/clients/http_client.rb",
        scope: ["HttpClient"],
      },
    ]);
    const call: CallRef = {
      callText: "@client.get",
      receiver: "@client",
      member: "get",
      startLine: 5,
    };
    const ctx: CallContext = {
      callerFile: "app/services/fetcher.rb",
      callerScope: ["Fetcher"],
      imports: [],
      symbolTable: table,
      classFieldTypes: { Fetcher: { "@client": "HttpClient" } },
    };
    expect(resolver.resolve(call, ctx)).toEqual({
      targetRelPath: "app/clients/http_client.rb",
      targetSymbolId: "HttpClient#get",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
`npx vitest run tests/core/domains/language/ruby/resolver/ruby-resolver.test.ts -t "@ivar type-inference resolution"`
Expected: FAIL — `resolve` returns `null` (no chain pass handles `@client` yet;
without the ivar pass it reaches `bareCall`/drop).

- [ ] **Step 3: Wire the strategy into the constructor chain**

In `src/core/domains/language/ruby/resolver/ruby-resolver.ts`, add
`RubyIvarFieldSymbolResolutionStrategy` to the barrel import block (lines 48-63)
and insert it into `this.strategies` right after
`RubyLocalTypeSymbolResolutionStrategy`:

```typescript
this.strategies = [
  new RubySuperSymbolResolutionStrategy(cfg),
  new RubySelfMemberSymbolResolutionStrategy(cfg),
  new RubyLocalTypeSymbolResolutionStrategy(cfg),
  new RubyIvarFieldSymbolResolutionStrategy(cfg),
  new RubyConstantSymbolResolutionStrategy(cfg),
  new RubyExplicitRequireSymbolResolutionStrategy(cfg),
  new RubyArRelationGuardSymbolResolutionStrategy(cfg),
  new RubyReceiverSetDropSymbolResolutionStrategy(cfg),
  new RubyBareCallSymbolResolutionStrategy(cfg),
];
```

Also update the pass-order doc comment (lines 21-29) to insert
`4. ivarField (@ivar.X via walker-inferred classFieldTypes — terminal guard)`
and renumber the following passes. Doc-comment only — no logic.

- [ ] **Step 4: Run the new test + the full ruby resolver regression net**

Run: `npx vitest run tests/core/domains/language/ruby/resolver/` Expected: PASS
— the new `@ivar` integration case green AND `ruby-resolver-dispatch.test.ts`,
`ruby-resolver-external-import.test.ts`, `ruby-resolver.test.ts`,
`strategies.test.ts` all still green (the new pass is a terminal guard on
`@ivar` receivers only — it `CONTINUE`s on every receiver the other passes
handle, so it cannot regress them).

- [ ] **Step 5: Full suite + type-check**

Run: `npx vitest run` then `npx tsc --noEmit` Expected: all green, 0 type
errors.

- [ ] **Step 6: Commit (silo-pairing Why line)**

```bash
git add src/core/domains/language/ruby/resolver/ruby-resolver.ts tests/core/domains/language/ruby/resolver/ruby-resolver.test.ts
git commit -m "refactor(trajectory): wire RubyIvarFieldSymbolResolutionStrategy into the resolve chain" -m "Why: ruby-resolver.ts is a fanIn-9 hub and its constructor chain is an artk0de deep-silo; the change is constructor-array-only (one strategy inserted after localType), no public-method body touched, so the 5-language CallResolver seam and the resolve metric for non-@ivar receivers are unaffected."
```

---

## Final (NOT a code task — user-gated): live huginn validation

After merge to main + rebuild + relink, with explicit user go-ahead for reindex:

```bash
tea-rags index-codebase --project huginn --wait-enrichments --force --json
```

Confirm from `byReceiverKind`:

- `ivar` resolveSuccessRate RISES from baseline 0.488 (huginn) toward the
  ~129-miss-addressable ceiling.
- gem-typed ivars land in `externalSkipped` (denominator shrinks), NOT in
  `resolved` (no fabricated gem edges).
- ruby aggregate (baseline 0.5547) and overall (baseline 0.4708) move UP.

Do NOT chain a reindex automatically — it rewrites the shared Qdrant index and
depends on ollama. Wait for the explicit "reindex"/"замер".

---

## Self-Review

**Spec coverage:** every spec §Architecture component maps to a task — walker
collector (T1), walker wiring (T2), `resolveTypeMethod` extraction (T3), ivar
strategy (T4), honest-denominator external branch (T5), facade DI (T6); the
`@`-prefixed key, last-write-wins, gem→external divergence, and
immutable-regression-net constraints are all encoded in task steps. Live
validation is the user-gated Final section.

**Placeholder scan:** the only intentional `<<< paste … >>>` marker is Task 3
Step 1 — a RELOCATION of an existing verbatim body (the source is
`RubyLocalTypeSymbolResolutionStrategy#resolveByLocalTypeInternal`, read in full
during design); reproducing it inline would risk drift from the live source, so
the instruction is to move it verbatim. Every net-new unit has complete code.

**Type consistency:**
`collectRubyIvarFieldTypes(root): Record<string, Record<string,string>>` (T1) →
set on `FileExtraction.classFieldTypes` (T2) → read as
`ctx.classFieldTypes?.[scope]?.[receiver]` in both
`RubyIvarFieldSymbolResolutionStrategy` (T4) and `ivarTargetsExternal` (T5).
`resolveTypeMethod(typeName, member, ctx): SymbolResolutionTarget | null`
defined T3, consumed T4. `@`-prefixed key symmetric across walker emit (T1),
strategy read (T4), external-vocab read (T5). Receiver regex `/^@\w+$/`
identical in T4 and T5.
