# Ruby receiver type inference (Increment B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax. When executing, prefer the dinopowers wrappers
> (dinopowers:subagent-driven-development / dinopowers:test-driven-development /
> dinopowers:verification-before-completion).

**Goal:** Type more Ruby call receivers (relation tails, block params,
class-valued constants, association chains) so the dynamic fan-out collapses
into single EXACT edges, and suppress provably-external chain receivers —
raising codegraph precision AND recall without ever emitting a wrong-type edge.

**Architecture:** Every exact-receiver strategy funnels into one resolver
function `resolveTypeMethod(typeName, member, ctx, mode)`. The dispatch defer
and `RubyLocalTypeSymbolResolutionStrategy` key on `call.receiver`. So each
slice's job is ONLY to populate the right `(receiverKey → type)` into
`localBindings`/`classFieldTypes`; the existing machinery produces the edge. The
ONE exception is var=CONST, which adds a class-method branch inside the shared
resolver. B-suppress mirrors the shipped Increment A (one text predicate, two
consumers).

**Tech Stack:** TypeScript, vitest, tree-sitter-ruby, DuckDB codegraph.

## Global Constraints

- **NO breaking contract change.** `LocalBinding.valueKind` is an ADDITIVE
  OPTIONAL field (`"instance" | "class"`, absent ⇒ `"instance"`); every other
  language's binding consumer must be unaffected (full suite green).
- **No wrong-type edges.** Every slice's unit test pins the EXACT correct target
  symbolId (e.g. `Model#save`, `User#name`), never just "non-empty". A wrong
  exact edge is invisible in aggregate `exactRatio` — the test is the guard.
- **Regression invariant:** receivers not matched by a new rule resolve EXACTLY
  as before. Bare-identifier untyped receivers still fan out where no binding is
  added; in-project association tails (`event.user.agents`) are NEVER
  suppressed.
- **`collectRubyCalls` (walker.ts, 263-line god-method, fanIn 16) — additive
  cases only.** Do NOT restructure it.
- **Silo files** (`local-bindings.ts` artk0de 100% deep-silo; `shared.ts`
  artk0de 100% chunk) — additive change, full golden coverage, flag for owner
  review.
- Each task is RED → GREEN. Test runner `npx vitest run <file>`; pre-commit runs
  tsc + full suite + coverage. Stay on `worktree-ruby-lsp-spike` (stacks on
  Increment A; do NOT merge A first).
- **Tracks 1–2 (Tasks 1–4) own `local-bindings.ts` → strictly sequential.**
  **Task 5 (B-suppress) is disjoint-file → may run in parallel.** Task 6 is
  last.

## Mechanism reference (verified from source — read before any task)

- `constInstanceType(node): string | null` — `local-bindings.ts:47`. Receiver is
  `YARD_CONST` AND method ∈ `{new} ∪ INSTANCE_RETURNING_METHODS` → the const.
- `INSTANCE_RETURNING_METHODS` — `local-bindings.ts:16` =
  `find find! find_by find_by! create create! build first last take`.
- `collectLocalBindingsForChunk(root, startLine, endLine, yardByLine): Record<string, LocalBinding[]>`
  — `local-bindings.ts:218`. `push(name, type, line)` helper. `walk` callback
  handles `method`/`singleton_method` (optional-param defaults) and
  `assignment`. NO block case today.
- `LocalBinding { line: number; type: string }` —
  `contracts/types/codegraph.ts:368`.
- `resolveLocalBindingType(bindings, varName, atLine)` —
  `contracts/types/codegraph.ts:386`. Most-recent binding with `line <= atLine`.
- `RubyLocalTypeSymbolResolutionStrategy.attempt` — `ruby-local-type.ts:24`:
  `resolveLocalBindingType(ctx.localBindings, call.receiver, call.startLine)` →
  `resolveTypeMethod(localType, call.member, ctx, mode)` → exact target; DROP on
  miss.
- `resolveTypeMethod(typeName, member, ctx, mode): SymbolResolutionTarget | null`
  — `shared.ts:253`: `resolveConstant` → file, prepend MRO, `lookupByShortName`
  scoped to the type file + scope-tail, walk `classAncestors`; file-only edge on
  method miss; null on file miss.
- dispatch defer — `ruby-dynamic-dispatch.ts:55`:
  `if (ctx.localBindings && Object.prototype.hasOwnProperty.call(ctx.localBindings, r)) return []`
  where `r = call.receiver` (line 50). Keys on the FULL receiver text — a
  compound key `"event.user"` IS recognized if present.
- `receiverIsIndexAccess` (A's predicate) — `shared.ts:78`.
  `EXTERNAL_CHAIN_TAILS` mirrors `AR_RELATION_BUILDERS`
  (`ruby-ar-relation-guard.ts:36`).
- `isQualifiedReceiverExternal(receiver, ctx)` —
  `ruby-external-vocabulary.ts:23`, branch order: index → super →
  ivar(`/^@\w+$/`) → constant → else `false`.
- `associationModelConstant(callNode)` — `walker.ts:679` (PRIVATE). Parses
  `class_name:` override, else first symbol arg → `singularizeAssociation` +
  `camelizeModelName`. Returns the model constant or null.
- `singularizeAssociation` — exported from `dsl/inflection.ts`.
  `camelizeModelName` — PRIVATE `walker.ts:663`. `RUBY_ASSOCIATION_MACROS` —
  PRIVATE `walker.ts:644`.
- `collectRubyIvarFieldTypes(root): Record<class, Record<field, type>>` —
  `local-bindings.ts:75`, written to `out.classFieldTypes` at `walker.ts:159` —
  the TEMPLATE for the B1 association-map channel.
- Test precedents:
  `tests/core/domains/language/typescript/walker/typescript-walker.test.ts`
  describe `"parameter-type bindings (localBindings) — bd tea-rags-mcp-x6ta"`
  (localBindings unit-test harness to mirror); ruby walker tests under
  `tests/core/domains/ingest/pipeline/chunker/extraction/walker-branch-paths.test.ts`
  - `tests/core/domains/language/ruby/walker/`; resolver tests under
    `tests/core/domains/language/ruby/resolver/strategies/`; provider end-to-end
    `tests/core/domains/trajectory/codegraph/symbols/inproject-edge-recall.test.ts`.

---

### Task 1: B2 — Relation-tail typing

**Files:**

- Modify: `src/core/domains/language/ruby/walker/local-bindings.ts`
- Test: the ruby walker localBindings test (mirror the x6ta harness; place
  beside the existing `collectLocalBindingsForChunk` tests —
  `tests/core/domains/language/ruby/walker/local-bindings.test.ts` if present,
  else the ruby block of `walker-branch-paths.test.ts`).

**Interfaces:**

- Produces: `constInstanceType` now also types a relation-tail RHS
  (`Const.<rel>(...)[.<rel>(...)]*.<instance-method>` → `Const`). Consumed
  implicitly by `collectLocalBindingsForChunk` (unchanged call site) → the
  existing `RubyLocalTypeSymbolResolutionStrategy` resolves `x.member`.

- [ ] **Step 1: Write the failing test** — assert a relation-tail-typed local
      resolves to the EXACT model method. Mirror the x6ta harness
      (`extractFromRubyFile` → inspect `localBindings`, or drive the resolver
      and assert the edge target). Minimum fixture + assertions:

```ruby
# fixture: app/posts_controller.rb
class PostsController
  def show
    post = Post.where(published: true).order(:created_at).first
    post.touch
  end
end
```

Assert: `localBindings["post"]` contains a binding with `type === "Post"` (NOT
the relation), so the `post.touch` call resolves to target symbolId `Post#touch`
(given a `Post#touch` def in the symbol table). Add a NEGATIVE case:
`rel = Post.where(published: true)` (NO terminal instance method) does NOT bind
`rel` to a single `"Post"` instance (it is a collection — left for B-block).

- [ ] **Step 2: Run RED**

Run: `npx vitest run <relation-tail test file> -t "relation tail"` Expected:
FAIL — `localBindings["post"]` is empty (relation tail not typed).

- [ ] **Step 3: Implement** — in `local-bindings.ts`, add the relation-method
      set and a chain-root walker, and extend `constInstanceType`:

```ts
/**
 * AR::Relation-returning query methods: `Const.where(...)` is a
 * `Relation<Const>`, and chaining another of these stays `Relation<Const>`
 * (same element type). A terminal instance-returning method
 * ({@link INSTANCE_RETURNING_METHODS}) on such a relation yields ONE `Const`
 * instance — so `Const.where(...).first` is typed `Const` (bd Increment B / B2).
 */
export const RELATION_RETURNING_METHODS = new Set([
  "where",
  "not",
  "order",
  "joins",
  "includes",
  "eager_load",
  "preload",
  "references",
  "group",
  "having",
  "limit",
  "offset",
  "distinct",
  "select",
  "reorder",
  "unscope",
  "except",
  "all",
  "readonly",
  "lock",
  "merge",
  "none",
]);

/**
 * Walk a relation chain `Const.<rel>(...)[.<rel>(...)]*` down to its root
 * constant. Returns the fully-qualified const when the chain bottoms out at a
 * `YARD_CONST` receiver through only {@link RELATION_RETURNING_METHODS}; null
 * for any non-relation link (no guessing).
 */
function relationRootConst(node: AstNode): string | null {
  const asConst =
    node.type === "scope_resolution"
      ? readScopeResolution(node)
      : node.type === "constant"
        ? node.text
        : null;
  if (asConst && YARD_CONST.test(asConst)) return asConst;
  if (node.type !== "call" && node.type !== "method_call") return null;
  const recv = node.childForFieldName("receiver");
  const method = node.childForFieldName("method");
  if (!recv || !method || !RELATION_RETURNING_METHODS.has(method.text))
    return null;
  return relationRootConst(recv);
}
```

Then rewrite `constInstanceType` to also accept a relation-chain receiver:

```ts
function constInstanceType(node: AstNode): string | null {
  if (node.type !== "call" && node.type !== "method_call") return null;
  const receiver = node.childForFieldName("receiver");
  const method = node.childForFieldName("method");
  if (!receiver || !method) return null;
  const methodName = method.text;
  if (methodName !== "new" && !INSTANCE_RETURNING_METHODS.has(methodName))
    return null;
  const receiverText =
    receiver.type === "scope_resolution"
      ? readScopeResolution(receiver)
      : receiver.text;
  // Direct `ClassName.new` / `ClassName.find` — receiver is the constant itself.
  if (YARD_CONST.test(receiverText)) return receiverText;
  // B2 relation tail `Const.where(...).first` — receiver is a relation chain.
  return relationRootConst(receiver);
}
```

- [ ] **Step 4: Run GREEN**

Run: `npx vitest run <relation-tail test file>` Expected: PASS (relation tail
typed to the model; bare relation NOT typed).

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/language/ruby/walker/local-bindings.ts <test file>
git commit -m "feat(trajectory): type ActiveRecord relation-tail locals (increment B / B2)"
```

---

### Task 2: B-block — block-parameter element typing

**Files:**

- Modify: `src/core/domains/language/ruby/walker/local-bindings.ts`
- Test: same ruby walker localBindings test file as Task 1.

**Interfaces:**

- Consumes: `resolveLocalBindingType` (existing), Task 1's relation typing
  (composes — a relation-bound collection iterated in a block yields the model).
- Produces: a block parameter is bound to the iterated receiver's resolved type
  at the block line, so `coll.each { |e| e.member }` resolves `e.member`
  exactly.

- [ ] **Step 1: Write the failing test** — fixture where a typed collection is
      iterated and the block param's method must resolve to the element type:

```ruby
# fixture: app/digest.rb
class Digest
  # @param posts [Array<Post>]
  def run(posts)
    posts.each { |p| p.publish }
  end
end
```

Assert: `localBindings["p"]` has `type === "Post"` (inherited from `posts`,
which brg9 already binds to the element type `Post`), so `p.publish` resolves to
`Post#publish`. NEGATIVE: `untyped.each { |q| q.foo }` (receiver `untyped` has
no binding) → `localBindings["q"]` is empty (still fans out — Increment-later).

- [ ] **Step 2: Run RED**

Run: `npx vitest run <test file> -t "block param"` Expected: FAIL —
`localBindings["p"]` empty (block params not bound today).

- [ ] **Step 3: Implement** — add the iterator set and a `block`/`do_block` case
      in the `collectLocalBindingsForChunk` walk callback (in
      `local-bindings.ts`, inside the existing `walk(root, (node) => { ... })`
      at line 237, before the `assignment` handling):

```ts
/**
 * Enumerable / collection methods that yield each element to a block. When the
 * iterated receiver has a known element type, the FIRST positional block param
 * is that element type (bd Increment B / B-block).
 */
export const RUBY_BLOCK_ITERATOR_METHODS = new Set([
  "each",
  "map",
  "collect",
  "select",
  "filter",
  "filter_map",
  "reject",
  "find",
  "detect",
  "find_all",
  "flat_map",
  "each_with_index",
  "each_with_object",
  "group_by",
  "sort_by",
  "min_by",
  "max_by",
  "partition",
]);
```

```ts
// Block-parameter element typing: `coll.each { |e| ... }` binds `e` to
// coll's resolved (element) type. The block's parent is the iterator `call`
// node. Only the FIRST positional param is the element (each_with_object /
// reduce later params are accumulators — skipped). VTA is sound only when
// the receiver already has a binding; unknown receiver → no binding.
if (node.type === "block" || node.type === "do_block") {
  const parent = node.parent;
  const callMethod = parent?.childForFieldName("method")?.text;
  const recvNode = parent?.childForFieldName("receiver");
  if (
    parent &&
    (parent.type === "call" || parent.type === "method_call") &&
    callMethod &&
    RUBY_BLOCK_ITERATOR_METHODS.has(callMethod) &&
    recvNode?.type === "identifier"
  ) {
    const elemType = resolveLocalBindingType(out, recvNode.text, line);
    const paramsNode = node.childForFieldName("parameters"); // block_parameters
    const firstParam = paramsNode?.namedChildren.find(
      (p) => p.type === "identifier",
    );
    if (elemType && firstParam) push(firstParam.text, elemType, line);
  }
  return;
}
```

(Confirm the block-parameters field name — tree-sitter-ruby exposes the `|p|`
list as the `block`/`do_block` node's child of type `block_parameters`; if
`childForFieldName("parameters")` returns null, fall back to
`node.namedChildren.find((c) => c.type === "block_parameters")` and read its
`identifier` children. Adjust to the real grammar and note it in the report.)

- [ ] **Step 4: Run GREEN**

Run: `npx vitest run <test file>` Expected: PASS (typed-collection block param →
element type; untyped → unbound).

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/language/ruby/walker/local-bindings.ts <test file>
git commit -m "feat(trajectory): type block params to iterated element type (increment B / B-block)"
```

---

### Task 3: var=CONST — class-valued bindings (additive contract change)

**Files:**

- Modify: `src/core/contracts/types/codegraph.ts` (LocalBinding +
  `resolveLocalBindingType` passthrough if needed)
- Modify: `src/core/domains/language/ruby/walker/local-bindings.ts`
- Modify:
  `src/core/domains/language/ruby/resolver/strategies/ruby-local-type.ts` and/or
  `src/core/domains/language/ruby/resolver/strategies/shared.ts`
  (`resolveTypeMethod` static branch)
- Test: ruby walker localBindings test + a resolver test under
  `tests/core/domains/language/ruby/resolver/strategies/`

**Interfaces:**

- Produces: `LocalBinding.valueKind?: "instance" | "class"` (absent ⇒
  `"instance"`). `var = CONST` (bare constant RHS) pushes
  `{ type: CONST, valueKind: "class" }`. The localType strategy, on a
  class-valued binding, resolves a STATIC method (symbolId `Type.method`)
  instead of an instance method (`Type#method`).

- [ ] **Step 1 (3a): Contract change + cross-language regression** — add the
      optional field, run the FULL suite to prove no other language regresses:

```ts
// contracts/types/codegraph.ts — LocalBinding (additive optional, default instance)
export interface LocalBinding {
  line: number;
  type: string;
  /**
   * Whether `type` is held as a CLASS (`var = User` → `var.find` resolves
   * `User.find`, a static method) or an INSTANCE (default; `var = User.new` →
   * `var.save` resolves `User#save`). Absent ⇒ `"instance"` so every existing
   * binding and every other language is unaffected (bd Increment B / var=CONST).
   */
  valueKind?: "instance" | "class";
}
```

Run: `npx vitest run` → all green (additive field, no consumer reads it yet).
Commit this isolated:

```bash
git add src/core/contracts/types/codegraph.ts
git commit -m "feat(types): additive LocalBinding.valueKind for class-valued bindings (increment B)"
```

- [ ] **Step 2 (3b): Walker — write the failing walker test** then bind
      `var = CONST`:

```ruby
# fixture
class Registry
  def lookup
    klass = User
    klass.find(1)
  end
end
```

Assert: `localBindings["klass"]` has `{ type: "User", valueKind: "class" }`. RED
first (no `var = CONST` handling). Then in `local-bindings.ts` single-assignment
branch (line 282-289), add the constant-RHS case BEFORE the copy-prop fallback:

```ts
if (lhs.type !== "identifier") return;
const varName = lhs.text;

// `var = CONST` — var holds the CLASS itself (not an instance). Bare constant
// RHS only (a call RHS is handled by constInstanceType above).
const rhsConst =
  rhs.type === "scope_resolution"
    ? readScopeResolution(rhs)
    : rhs.type === "constant"
      ? rhs.text
      : null;
if (rhsConst && YARD_CONST.test(rhsConst)) {
  push(varName, rhsConst, line);
  (out[varName]![out[varName]!.length - 1] as LocalBinding).valueKind = "class";
  return;
}

const type =
  constInstanceType(rhs) ??
  (rhs.type === "identifier"
    ? resolveLocalBindingType(out, rhs.text, line)
    : undefined);
if (type) push(varName, type, line);
```

(If `push` is more cleanly extended to take an optional `valueKind`, do that
instead of the post-mutation — keep it readable; note the choice in the report.)

- [ ] **Step 3 (3c): Resolver — write the failing resolver test** then branch on
      `valueKind`. Test asserts the STATIC symbolId:

`klass = User; klass.find` → target symbolId `User.find` (static); regression:
`obj = User.new; obj.find` → `User#find` (instance, unchanged).

In `ruby-local-type.ts` (or `resolveTypeMethod` in `shared.ts`), read the
binding's `valueKind`; when `"class"`, resolve the STATIC method (symbolId
`Type.method`) using the same constant→file + `lookupByShortName` path the
instance branch uses, but matching the singleton/static symbol shape. Follow the
existing instance resolution in `resolveTypeMethod` (`shared.ts:253`) and mirror
it for the static symbolId form — read that function and the symbol-table
`lookupByShortName` signature first; implement the minimal static variant.

- [ ] **Step 4: Run GREEN + full suite**

Run: `npx vitest run <walker test> <resolver test>` then `npx vitest run`.
Expected: PASS; class-valued → static method; instance path unchanged; full
suite green (cross-language regression clear).

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/language/ruby/walker/local-bindings.ts \
  src/core/domains/language/ruby/resolver/strategies/ruby-local-type.ts \
  src/core/domains/language/ruby/resolver/strategies/shared.ts <tests>
git commit -m "feat(trajectory): resolve class-valued (var=CONST) receivers to static methods (increment B / var=CONST)"
```

---

### Task 4: B1 — chain-association typing (heaviest)

**Files:**

- Modify: `src/core/domains/language/ruby/walker/walker.ts` (export
  `camelizeModelName`; build per-class association map via
  `associationModelConstant`; write to `FileExtraction`)
- Modify: `src/core/contracts/types/codegraph.ts` (FileExtraction +
  `CallContext` association-type field, mirroring `classFieldTypes`)
- Modify: `src/core/domains/language/ruby/walker/local-bindings.ts` (compound-
  receiver chain binding)
- Test: ruby walker test (association map) + resolver/provider test (chain edge)

**Interfaces:**

- Consumes: `associationModelConstant` (walker.ts:679 — already handles
  `class_name:`), `singularizeAssociation`, `camelizeModelName`,
  `RUBY_ASSOCIATION_MACROS`. Tasks 1–3 bindings (the chain ROOT must be typed).
- Produces: a per-class
  `associationTypes: Record<class, Record<accessor, modelType>>` on
  `FileExtraction`/`CallContext`; and compound-receiver bindings
  (`localBindings["event.user"] = User`) so the existing defer + localType
  strategy resolve `event.user.agents` exactly.

- [ ] **Step 1 (4a): association-map channel — failing walker test** then build
      it. Mirror `collectRubyIvarFieldTypes` (local-bindings.ts:75) + its
      `out.classFieldTypes` wiring (walker.ts:159).

Fixture + assert: `class Event; belongs_to :user; end` →
`associationTypes["Event"]["user"] === "User"`; with `class_name:` override
`belongs_to :author, class_name: "User"` →
`associationTypes["Event"]["author"] === "User"` (NOT `"Author"`).

Export `camelizeModelName` from `walker.ts`. Add
`collectRubyAssociationTypes(root)` (new export in `local-bindings.ts` or a
sibling) that, per class scope, for each association macro call
(`RUBY_ASSOCIATION_MACROS`), records
`{ accessorName(s) → associationModelConstant(node) }`. Wire it into
`extractFromRubyFile` and onto `FileExtraction.associationTypes`, then
`CallContext.associationTypes` (mirror the `classFieldTypes` plumbing exactly).

- [ ] **Step 2 (4b): compound-receiver chain binding — failing resolver/provider
      test** then implement. Test pins the EXACT target AND the class_name case:

`event : Event`, `Event belongs_to :user` (→User), `User has_many :agents`
(→Agent): `event.user.agents.each {...}` → the `agents` call on receiver
`event.user` resolves to `Agent` (target symbolId on an `Agent` method);
`event.author.name` with `class_name: "User"` → `User#name` NOT `Author#name`.

In `collectLocalBindingsForChunk` (after single-var/ivar types are known), walk
compound chain receivers left-to-right using `associationTypes`: given the root
var's type (from Tasks 1–3 bindings / YARD param / ivar) and the association
map, bind each prefix — `localBindings["event.user"] = User`,
`localBindings["event.user.agents"]` is the call receiver resolved by the
existing strategy. An unknown hop STOPS the walk (no binding → honest fan-out).
Cap the walk at the literal receiver's segment count (a self-referential
`has_many` must not loop).

- [ ] **Step 3: Run GREEN + full suite**

Run: `npx vitest run <walker test> <chain test>` then `npx vitest run`.
Expected: PASS; chain typed to the correct model; `class_name:` honored; unknown
hop unbound; no loop.

- [ ] **Step 4: Commit**

```bash
git add src/core/domains/language/ruby/walker/walker.ts \
  src/core/domains/language/ruby/walker/local-bindings.ts \
  src/core/contracts/types/codegraph.ts <tests>
git commit -m "feat(trajectory): type association-chain receivers via Rails DSL map (increment B / B1)"
```

---

### Task 5: B-suppress — external-chain receiver suppression (PARALLELIZABLE)

**Files:**

- Modify: `src/core/domains/language/ruby/resolver/strategies/shared.ts`
  (predicate + `EXTERNAL_CHAIN_TAILS`)
- Modify: `src/core/domains/language/ruby/resolver/strategies/index.ts` (barrel)
- Modify:
  `src/core/domains/language/ruby/resolver/strategies/ruby-dynamic-dispatch.ts`
  (guard, after the index-access guard)
- Modify: `src/core/domains/language/ruby/resolver/ruby-external-vocabulary.ts`
  (branch in `isQualifiedReceiverExternal`)
- Test:
  `tests/core/domains/language/ruby/resolver/strategies/strategies.test.ts`
  - `tests/core/domains/language/ruby/resolver/ruby-resolver-external-import.test.ts`

This mirrors the shipped Increment A (predicate + two consumers) EXACTLY —
disjoint from Tasks 1–4's files, so it may run in parallel.

**Interfaces:**

- Produces:
  `export function receiverChainTailIsExternal(receiver: string): boolean` —
  true when the receiver's chain ends in a provably-external core / runtime
  method. Consumed by the dispatch resolver (suppress) and the external
  vocabulary (reclassify).

- [ ] **Step 1: Write the failing tests** — in `strategies.test.ts` (predicate +
      dispatch suppression) and `ruby-resolver-external-import.test.ts`
      (classification). Mirror the mktkk `receiverIsIndexAccess` tests:

```ts
// predicate
expect(receiverChainTailIsExternal("req.headers")).toBe(true);
expect(receiverChainTailIsExternal("e.backtrace")).toBe(true);
expect(receiverChainTailIsExternal("type.constantize")).toBe(true);
expect(receiverChainTailIsExternal("event.user.agents")).toBe(false); // in-project assoc — NOT external
expect(receiverChainTailIsExternal("user")).toBe(false); // bare id
```

Dispatch + classification (mirror the file's real ctx/symbol-table builders):
`req.headers.to_h` (receiver `req.headers`) → `resolveDispatch` returns `[]` AND
`targetsExternalImport` returns `true`; `event.user.agents` (receiver
`event.user`) → still fans out / NOT external by this rule (regression guard).

- [ ] **Step 2: Run RED**

Run:
`npx vitest run .../strategies.test.ts .../ruby-resolver-external-import.test.ts -t "chain"`
Expected: FAIL — `receiverChainTailIsExternal` not exported; chains not
suppressed.

- [ ] **Step 3: Implement** — in `shared.ts`, mirror `AR_RELATION_BUILDERS` /
      `receiverIsIndexAccess`:

```ts
/**
 * Provably-external chain tails — Ruby-core / Rails-runtime methods that a chain
 * receiver dispatches on (`req.headers.to_h`, `e.backtrace.first`,
 * `type.constantize`). NARROW + unambiguous on purpose: in-project association
 * tails (`agents`, `user`) are absent, so `event.user.agents` is never
 * suppressed. High-frequency ambiguous tails (`.map`/`.each`/`.first`) are
 * EXCLUDED (deferred — they need a root-segment vocab gate). bd Increment B / B-suppress.
 */
const EXTERNAL_CHAIN_TAILS = [
  ".headers",
  ".backtrace",
  ".constantize",
  ".deconstantize",
  ".to_h",
  ".to_json",
  ".to_param",
  ".class_name",
];

/**
 * True when a chain receiver ends in a provably-external core/runtime method —
 * the receiver text contains one of {@link EXTERNAL_CHAIN_TAILS} as a suffix
 * segment. Text-shape, mirroring `receiverIsIndexAccess` /
 * `receiverLooksLikeArRelationChain`.
 */
export function receiverChainTailIsExternal(receiver: string): boolean {
  const t = receiver.trimEnd();
  return EXTERNAL_CHAIN_TAILS.some((tail) => t.endsWith(tail));
}
```

Export it from `strategies/index.ts` (alongside `receiverIsIndexAccess`). Add
the guard in `ruby-dynamic-dispatch.ts` immediately AFTER the index-access
guard:

```ts
if (receiverIsIndexAccess(r)) return [];
// Provably-external chain tail (`req.headers`, `type.constantize`): the element
// is core/runtime, no in-project target. Suppress; the external classifier
// reclassifies so recall is not falsely penalised (bd Increment B / B-suppress).
if (receiverChainTailIsExternal(r)) return [];
```

And the branch in `ruby-external-vocabulary.ts` `isQualifiedReceiverExternal`,
after the index-access branch:

```ts
if (receiverIsIndexAccess(receiver)) return true;
if (receiverChainTailIsExternal(receiver)) return true; // provably-external chain tail (B-suppress)
```

(Import `receiverChainTailIsExternal` via the same path the file imports
`receiverIsIndexAccess` — through the `strategies/index.js` barrel, the house
style confirmed in Increment A Task 3.)

- [ ] **Step 4: Run GREEN**

Run:
`npx vitest run .../strategies.test.ts .../ruby-resolver-external-import.test.ts`
Expected: PASS (external chain suppressed + external; `event.user.agents`
untouched).

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/language/ruby/resolver/strategies/shared.ts \
  src/core/domains/language/ruby/resolver/strategies/index.ts \
  src/core/domains/language/ruby/resolver/strategies/ruby-dynamic-dispatch.ts \
  src/core/domains/language/ruby/resolver/ruby-external-vocabulary.ts <tests>
git commit -m "feat(trajectory): suppress provably-external chain-tail receivers (increment B / B-suppress)"
```

---

### Task 6: Provider integration + full verification + huginn live-validation

**Files:**

- Test:
  `tests/core/domains/trajectory/codegraph/symbols/inproject-edge-recall.test.ts`
  (add end-to-end cases mirroring the existing driver — the same one Increment A
  used).

**Interfaces:**

- Consumes: Tasks 1–5.

- [ ] **Step 1: Provider-level end-to-end tests (RED-or-pass-on-write)** — one
      per additive slice, each pinning the EXACT target via run-stats / direct
      edge inspection. Mirror the `inproject-edge-recall.test.ts` driver
      (`streamFileBatch` / `finalizeSignals` / `getRunStats`, tmp DuckDB). For
      each: a fixture exercising the slice (relation-tail receiver; block-param
      receiver; association-chain receiver) yields an EXACT edge to the CORRECT
      model method, and the corresponding `dynamic` count drops vs an un-typed
      control. If pass-on-write (impl already in place), tighten the fixture so
      it genuinely exercises the new typing path; document RED-or-pass-on-write.

- [ ] **Step 2: Full verification**

Run: `npx tsc --noEmit` (0 errors); `npx vitest run` (all green — adjust any
existing test that asserted a now-typed receiver fans out, since that behavior
intentionally changed; do NOT rewrite a business-logic assertion — fixture-swap
only, escalate if found, per the Increment A precedent); `npx prettier --check`
on changed files.

- [ ] **Step 3: Commit the integration tests**

```bash
git add tests/core/domains/trajectory/codegraph/symbols/inproject-edge-recall.test.ts
git commit -m "test(trajectory): provider-level receiver type-inference edges end-to-end (increment B)"
```

- [ ] **Step 4: huginn live-validation (ONE force-reindex)**

Build worktree (`npm run build`); ASK the user to `/mcp reconnect tea-rags` and
WAIT (kill the stale `daemon/entry.js` so the fresh daemon loads new code);
force-reindex huginn
(`tea-rags index-codebase --project huginn --force --wait-enrichments --json`);
then assert via `get_index_status project=huginn` + direct RO edge query:

- ruby `exactRatio` UP; ruby `dynamic` edge count DOWN; recall UP-or-flat;
- **ruby EXACT edge count NOT reduced** (additive slices only convert
  dynamic→exact; B-suppress removes only dynamic);
- **CATEGORIZED NEW-EDGE SAMPLING (the wrong-type catch):** sample N new exact
  edges whose source call-site is a relation-tail / block-param / chain-assoc
  receiver and CONFIRM the target type is correct (e.g. a
  `Post.where(...).first` receiver's edge targets a `Post` method, not another
  class). ANY wrong-type edge is a blocking regression for the responsible
  slice.

- [ ] **Step 5: Close beads (worktree-only; NO merge/push)**

`bd close tea-rags-mcp-rxnoc` once the deltas + sampling confirm correctness.

## Self-Review

- **Spec coverage:** B2 (Task 1) ✓; B-block (Task 2) ✓; var=CONST incl. additive
  contract (Task 3) ✓; B1 chain-assoc (Task 4) ✓; B-suppress (Task 5) ✓;
  provider + live validation incl. new-edge sampling (Task 6) ✓. No spec section
  unmapped.
- **Placeholder scan:** B-block grammar field name and the var=CONST/B1 resolver
  static-method + FileExtraction plumbing are flagged as "read the real API
  first" (associationModelConstant, resolveTypeMethod, classFieldTypes wiring
  are the named templates) — these are explicit "verify against source"
  instructions, not silent TODOs, because the exact symbol-table /
  FileExtraction signatures must be read at implementation, not guessed.
- **Type consistency:** `LocalBinding.valueKind?: "instance" | "class"` used
  identically in Tasks 3/4. `RELATION_RETURNING_METHODS`,
  `RUBY_BLOCK_ITERATOR_METHODS`, `EXTERNAL_CHAIN_TAILS`,
  `receiverChainTailIsExternal`, `relationRootConst`, `associationTypes` named
  consistently across tasks. `constInstanceType` signature unchanged
  (`(node) => string | null`).
