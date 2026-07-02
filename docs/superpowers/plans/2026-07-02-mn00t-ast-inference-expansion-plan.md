# mn00t AST-Inference Type-Source Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> dinopowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand AST/Rails-convention receiver type inference so `||=`
memoization, bare relation assignments, and typed-collection element access
supply exact receiver types on un-annotated Rails code (bead
`tea-rags-mcp-mn00t`, epic `fxcjq`).

**Architecture:** Walker-side type-supply expansion only (spec Approach A). All
changes live in `ruby/walker/type-sources/ast-inference.ts` +
`ruby/walker/local-bindings.ts` + `dsl` data. Downstream resolution
(`typeOfReceiver`, typed-container index dispatch, `LocalBinding.typeRef`
channel) is already wired and MUST NOT be touched.

**Tech Stack:** TypeScript, tree-sitter-ruby AST, vitest.

**Spec:**
`docs/superpowers/specs/2026-07-02-mn00t-ast-inference-expansion-design.md`

## Global Constraints

- Hub chunks untouched: `ruby/walker/walker.ts::extractFromRubyFile`,
  `ruby/resolver/type-propagation.ts` (any chunk), `ruby/dsl/types.ts`,
  `contracts/` — zero edits.
- `constInstanceType(node: AstNode): string | null` signature is FROZEN (chunk
  fanIn 7) — new behavior goes into NEW sibling helpers.
- Existing tests are immutable: never rewrite/delete an existing
  `it`/`describe`; only ADD.
- `dsl/` stays pure data — no tree-sitter import, no `CallContext` (rule
  `ruby-dsl.md`).
- Only `||=` among operator assignments; `+=`/`-=`/`&&=` MUST NOT produce facts.
- Container facts are LOCAL-only. `recordIvarAssignment` MUST NOT record a
  relation/container RHS (string-valued `ivarTypes` would reduce it to a false
  instance type — spec F2 defer).
- Commits: conventional, scoped (`feat(language)` / `test(language)` per recent
  history), header ≤100 chars.
- Test runner: `npx vitest run <file>` from the worktree root.

---

### Task 1: `latestBinding`/`emitFact` upgrade to RubyTypeRef (behavior-preserving refactor)

**Files:**

- Modify:
  `src/core/domains/language/ruby/walker/type-sources/ast-inference.ts:119-241`
  (`extract`)
- Test: existing
  `tests/core/domains/language/ruby/walker/type-sources/ast-inference.test.ts`
  (green-gate only, no new tests — refactor task)

**Interfaces:**

- Consumes: `RubyTypeRef` from `contracts/types/language.js` (already imported
  transitively via `./types.js`).
- Produces: inside `extract` —
  `latestBinding: Map<string, { type: RubyTypeRef; line: number }>` and
  `emitFact(name: string, type: RubyTypeRef, line: number): void`. Tasks 2/4/5
  rely on exactly these shapes.

- [ ] **Step 1: Run existing walker tests — must be green before touching
      anything**

Run:
`npx vitest run tests/core/domains/language/ruby/walker/type-sources/ast-inference.test.ts tests/core/domains/language/ruby/resolver/type-propagation-container.test.ts`
Expected: PASS (baseline).

- [ ] **Step 2: Refactor `extract` internals**

In `extract` (`ast-inference.ts`), replace the string-typed binding map and the
two-arg fact emitter:

```ts
const latestBinding = new Map<string, { type: RubyTypeRef; line: number }>();
for (const [defLine, params] of collectYardParamTypes(input.code)) {
  for (const [name, type] of Object.entries(params)) {
    latestBinding.set(name, {
      type: { form: "instance", name: type },
      line: defLine,
    });
  }
}

const emitFact = (name: string, type: RubyTypeRef, line: number): void => {
  facts.push({
    kind: "local",
    source: "ast",
    symbolScope: [],
    name,
    line,
    type,
  });
  latestBinding.set(name, { type, line });
};
```

Update every call site inside `extract` (param defaults, block params,
multi-assign, `var = CONST`, `constInstanceType` branch, copy-prop):

- `emitFact(nameNode.text, type, line, "instance")` →
  `emitFact(nameNode.text, { form: "instance", name: type }, line)`
- `emitFact(varName, rhsConst, line, "class")` →
  `emitFact(varName, { form: "class", name: rhsConst }, line)`
- copy-prop / multi-assign identifier branch:
  `emitFact(target.text, prev.type, line)` (ref copied as-is).
- Block-param branch: `emitFact(firstParam.text, recvBinding.type, line)` — ref
  as-is for now (container unwrap lands in Task 4).

- [ ] **Step 3: Re-run the same tests — refactor is a no-op**

Run:
`npx vitest run tests/core/domains/language/ruby/walker/type-sources/ast-inference.test.ts tests/core/domains/language/ruby/resolver/type-propagation-container.test.ts tests/core/domains/language/ruby/walker/type-fact-store-typeref.test.ts`
Expected: PASS, zero test edits.

- [ ] **Step 4: Commit**

```bash
git add src/core/domains/language/ruby/walker/type-sources/ast-inference.ts
git commit -m "refactor(language): RubyTypeRef-valued latestBinding/emitFact in ast-inference extract"
```

---

### Task 2: F1a — `||=` local memoization in `extract`

**Files:**

- Modify: `src/core/domains/language/ruby/walker/type-sources/ast-inference.ts`
  (`extract` + new helper)
- Test:
  `tests/core/domains/language/ruby/walker/type-sources/ast-inference.test.ts`

**Interfaces:**

- Consumes: Task 1's `emitFact(name, RubyTypeRef, line)`.
- Produces: exported helper `isOrAssignment(node: AstNode): boolean` (used by
  Task 3 in local-bindings).

- [ ] **Step 1: Write the failing tests** (new `describe`, alongside the
      existing "constructor/factory instance bindings" conventions — parse with
      tree-sitter-ruby exactly as neighbors do)

```ts
describe("||= memoized local bindings (F1a)", () => {
  it("x ||= Const.find(id) emits an instance fact", () => {
    const facts = extractFacts(
      `def call\n  user ||= User.find(1)\n  user.save\nend\n`,
    );
    expect(facts).toContainEqual(
      expect.objectContaining({
        kind: "local",
        name: "user",
        type: { form: "instance", name: "User" },
      }),
    );
  });
  it("x ||= CONST emits a class fact", () => {
    const facts = extractFacts(`def call\n  klass ||= User\nend\n`);
    expect(facts).toContainEqual(
      expect.objectContaining({
        name: "klass",
        type: { form: "class", name: "User" },
      }),
    );
  });
  it("+= / &&= emit NO facts", () => {
    const facts = extractFacts(`def call\n  n += 1\n  y &&= User.new\nend\n`);
    expect(facts.filter((f) => f.name === "n" || f.name === "y")).toEqual([]);
  });
});
```

(`extractFacts` = the file's existing
parse-then-`rubyAstInferenceTypeSource.extract` helper; reuse it.)

- [ ] **Step 2: Run to verify failure**

Run:
`npx vitest run tests/core/domains/language/ruby/walker/type-sources/ast-inference.test.ts -t "F1a"`
Expected: FAIL — no facts emitted for `operator_assignment` nodes.

- [ ] **Step 3: Implement**

New helper next to `constInstanceType` (do NOT change `constInstanceType`):

```ts
/** `lhs ||= rhs` is the only operator assignment that BINDS a type: the
 *  memoization convention takes the RHS type for the happy-path receiver
 *  (nil branch ignored). `+=`/`-=`/`&&=` mutate or preserve — never bind. */
export function isOrAssignment(node: AstNode): boolean {
  return (
    node.type === "operator_assignment" &&
    node.children.some((c) => c.text === "||=")
  );
}
```

In `extract`, widen the assignment gate:

```ts
if (node.type !== "assignment" && !isOrAssignment(node)) return;
```

(The multi-assign branch stays under `node.type === "assignment"` implicitly —
`operator_assignment` has no `left_assignment_list`; the identifier-LHS branches
below work unchanged because `operator_assignment` exposes the same
`left`/`right` fields.)

- [ ] **Step 4: Run tests to verify pass**

Run:
`npx vitest run tests/core/domains/language/ruby/walker/type-sources/ast-inference.test.ts`
Expected: PASS (new + all existing).

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/language/ruby/walker/type-sources/ast-inference.ts tests/core/domains/language/ruby/walker/type-sources/ast-inference.test.ts
git commit -m "feat(language): ||= memoized local bindings in ruby ast-inference (mn00t F1a)"
```

---

### Task 3: F1b — `||=` memoized ivars in `recordIvarAssignment`

**Files:**

- Modify: `src/core/domains/language/ruby/walker/local-bindings.ts:137-161`
  (`recordIvarAssignment`)
- Test: `tests/core/domains/language/ruby/walker/local-bindings.test.ts`

**Interfaces:**

- Consumes: `isOrAssignment` from `./type-sources/ast-inference.js` (Task 2; the
  file already imports from that module).
- Produces: `collectRubyIvarFieldTypes` now yields `@ivar` entries for `||=`
  sites — same `Record<string, Record<string, string>>` shape, no signature
  change.

- [ ] **Step 1: Write the failing tests** (new `describe` in
      `local-bindings.test.ts`, reusing its existing parse helper conventions)

```ts
describe("collectRubyIvarFieldTypes — ||= memoization (F1b)", () => {
  it("@u ||= User.find(id) types the ivar", () => {
    const fields = collectFieldTypes(
      `class Session\n  def user\n    @user ||= User.find(@id)\n  end\nend\n`,
    );
    expect(fields["Session"]).toMatchObject({ "@user": "User" });
  });
  it("@n += 1 does NOT type the ivar", () => {
    const fields = collectFieldTypes(
      `class Counter\n  def bump\n    @n += 1\n  end\nend\n`,
    );
    expect(fields["Counter"]?.["@n"]).toBeUndefined();
  });
  it("@posts ||= Post.where(a: 1) does NOT type the ivar (container defer, spec F2)", () => {
    const fields = collectFieldTypes(
      `class Feed\n  def posts\n    @posts ||= Post.where(a: 1)\n  end\nend\n`,
    );
    expect(fields["Feed"]?.["@posts"]).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run:
`npx vitest run tests/core/domains/language/ruby/walker/local-bindings.test.ts -t "F1b"`
Expected: first `it` FAILS (operator_assignment rejected); the two negatives
pass vacuously.

- [ ] **Step 3: Implement**

In `recordIvarAssignment`, widen the node gate (RHS branches unchanged — they
already refuse relation RHS because `constInstanceType` needs a terminal
instance verb and `threadChainRhsType` threads only string-reducible chains):

```ts
if (n.type !== "assignment" && !isOrAssignment(n)) return;
```

(import `isOrAssignment` alongside the existing `constInstanceType` import.)

- [ ] **Step 4: Run tests to verify pass**

Run:
`npx vitest run tests/core/domains/language/ruby/walker/local-bindings.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/language/ruby/walker/local-bindings.ts tests/core/domains/language/ruby/walker/local-bindings.test.ts
git commit -m "feat(language): ||= memoized ivar field types in ruby local-bindings (mn00t F1b)"
```

---

### Task 4: F2 — bare relation assignment → container fact + block-param element unwrap

**Files:**

- Modify: `src/core/domains/language/ruby/walker/type-sources/ast-inference.ts`
  (new helper + `extract` branches)
- Test:
  `tests/core/domains/language/ruby/walker/type-sources/ast-inference.test.ts`

**Interfaces:**

- Consumes: `relationRootConst` (existing, unchanged), `RUBY_RELATION_RETURNING`
  (existing import), Task 1 shapes.
- Produces: exported helper
  `relationElementConst(node: AstNode): string | null`; container facts
  `{ form: "container", element: { form: "instance", name } }` on the existing
  `RubyTypeFact` local channel (store's INFRA-A `typeRef` path carries them — no
  store change).

- [ ] **Step 1: Write the failing tests**

```ts
describe("bare relation assignment → container facts (F2)", () => {
  it("posts = Post.where(...) emits a container fact with element Post", () => {
    const facts = extractFacts(
      `def call\n  posts = Post.where(active: true)\nend\n`,
    );
    expect(facts).toContainEqual(
      expect.objectContaining({
        name: "posts",
        type: {
          form: "container",
          element: { form: "instance", name: "Post" },
        },
      }),
    );
  });
  it("chained relation verbs keep the root element (Post.where(...).order(...))", () => {
    const facts = extractFacts(
      `def call\n  posts = Post.where(a: 1).order(:id)\nend\n`,
    );
    expect(facts).toContainEqual(
      expect.objectContaining({
        name: "posts",
        type: {
          form: "container",
          element: { form: "instance", name: "Post" },
        },
      }),
    );
  });
  it("identifier-rooted chains emit NO container fact (no guessing)", () => {
    const facts = extractFacts(`def call\n  rows = data.where(a: 1)\nend\n`);
    expect(facts.filter((f) => f.name === "rows")).toEqual([]);
  });
  it("posts.each { |p| } binds the block param to the ELEMENT type", () => {
    const facts = extractFacts(
      `def call\n  posts = Post.where(a: 1)\n  posts.each { |p| p.save }\nend\n`,
    );
    expect(facts).toContainEqual(
      expect.objectContaining({
        name: "p",
        type: { form: "instance", name: "Post" },
      }),
    );
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run:
`npx vitest run tests/core/domains/language/ruby/walker/type-sources/ast-inference.test.ts -t "F2"`
Expected: FAIL — no container facts today.

- [ ] **Step 3: Implement**

New helper below `relationRootConst` (mirrors `constInstanceType`'s structure;
`constInstanceType` itself is frozen):

```ts
/** A call chain that is STILL a relation (no terminal instanceReturning verb):
 *  `Post.where(...)`, `Post.where(...).order(...)`. Returns the root constant —
 *  the relation's ELEMENT type — or null. Identifier-rooted chains return null
 *  (no guessing; the root type is unknown at walk time). */
export function relationElementConst(node: AstNode): string | null {
  if (node.type !== "call" && node.type !== "method_call") return null;
  const method = node.childForFieldName("method");
  if (!method || !RUBY_RELATION_RETURNING.has(method.text)) return null;
  return relationRootConst(node);
}
```

In `extract`'s single-assignment section, after the `constInstanceType` branch:

```ts
const relElement = relationElementConst(rhs);
if (relElement) {
  emitFact(
    varName,
    { form: "container", element: { form: "instance", name: relElement } },
    line,
  );
  return;
}
```

In the block-param branch, unwrap containers when binding the first param:

```ts
const bound =
  recvBinding.type.form === "container"
    ? recvBinding.type.element
    : recvBinding.type;
if (firstParam) emitFact(firstParam.text, bound, line);
```

- [ ] **Step 4: Run tests to verify pass**

Run:
`npx vitest run tests/core/domains/language/ruby/walker/type-sources/ast-inference.test.ts tests/core/domains/language/ruby/walker/type-fact-store-typeref.test.ts`
Expected: PASS — container facts flow through the store's typeRef channel
untouched.

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/language/ruby/walker/type-sources/ast-inference.ts tests/core/domains/language/ruby/walker/type-sources/ast-inference.test.ts
git commit -m "feat(language): bare relation assignment emits container facts (mn00t F2)"
```

---

### Task 5: F3 — identifier-rooted element lift (`user = users.first`, `x = users[0]`)

**Files:**

- Modify: `src/core/domains/language/ruby/walker/type-sources/ast-inference.ts`
  (`extract` single-assignment section)
- Test:
  `tests/core/domains/language/ruby/walker/type-sources/ast-inference.test.ts`

**Interfaces:**

- Consumes: `CONTAINER_ELEMENT_RETURNING_METHODS` from
  `../../resolver/type-propagation.js` (module already imported for
  `CONTAINER_BLOCK_ITERATION_METHODS`), Task 4's container bindings in
  `latestBinding`.
- Produces: instance facts for element-returning access on container-bound
  locals.

- [ ] **Step 1: Write the failing tests**

```ts
describe("identifier-rooted element lift (F3)", () => {
  it("user = users.first lifts the element type", () => {
    const facts = extractFacts(
      `def call\n  users = User.where(a: 1)\n  user = users.first\n  user.save\nend\n`,
    );
    expect(facts).toContainEqual(
      expect.objectContaining({
        name: "user",
        type: { form: "instance", name: "User" },
      }),
    );
  });
  it("x = users[0] lifts via element_reference", () => {
    const facts = extractFacts(
      `def call\n  users = User.where(a: 1)\n  x = users[0]\nend\n`,
    );
    expect(facts).toContainEqual(
      expect.objectContaining({
        name: "x",
        type: { form: "instance", name: "User" },
      }),
    );
  });
  it("x = users.count does NOT lift (non-element method)", () => {
    const facts = extractFacts(
      `def call\n  users = User.where(a: 1)\n  x = users.count\nend\n`,
    );
    expect(facts.filter((f) => f.name === "x")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run:
`npx vitest run tests/core/domains/language/ruby/walker/type-sources/ast-inference.test.ts -t "F3"`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add `CONTAINER_ELEMENT_RETURNING_METHODS` to the existing `type-propagation.js`
import. In `extract`'s single-assignment section, after the
`relationElementConst` branch:

```ts
// Element lift: `user = users.first` / `x = users[0]` on a container-bound local.
const lifted = containerElementLift(rhs, latestBinding, line);
if (lifted) {
  emitFact(varName, lifted, line);
  return;
}
```

Helper (file-local, not exported — single consumer):

```ts
function containerElementLift(
  rhs: AstNode,
  bindings: ReadonlyMap<string, { type: RubyTypeRef; line: number }>,
  line: number,
): RubyTypeRef | null {
  const base =
    rhs.type === "element_reference"
      ? rhs.childForFieldName("object")
      : rhs.type === "call" || rhs.type === "method_call"
        ? rhs.childForFieldName("receiver")
        : null;
  if (base?.type !== "identifier") return null;
  if (rhs.type !== "element_reference") {
    const method = rhs.childForFieldName("method");
    if (!method || !CONTAINER_ELEMENT_RETURNING_METHODS.has(method.text))
      return null;
  }
  const binding = bindings.get(base.text);
  if (!binding || binding.line > line || binding.type.form !== "container")
    return null;
  return binding.type.element;
}
```

- [ ] **Step 4: Run tests to verify pass**

Run:
`npx vitest run tests/core/domains/language/ruby/walker/type-sources/ast-inference.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/language/ruby/walker/type-sources/ast-inference.ts tests/core/domains/language/ruby/walker/type-sources/ast-inference.test.ts
git commit -m "feat(language): container element lift for identifier-rooted access (mn00t F3)"
```

---

### Task 6: Verb audit — `instanceReturning` / `relationReturning` data completion

**Files:**

- Modify: `src/core/domains/language/ruby/dsl/rails.ts:138-172` (data only)
- Test:
  `tests/core/domains/language/ruby/dsl/catalogue-method-semantics.test.ts` (ADD
  new `it`s)

**Interfaces:**

- Consumes: nothing new.
- Produces: extended `RUBY_INSTANCE_RETURNING` / `RUBY_RELATION_RETURNING`
  composed sets (Tasks 2/4/5 pick them up automatically via `catalogue.ts`).

- [ ] **Step 1: Write the failing tests** (extend the existing
      `describe("composed method-semantics facets")` with NEW `it`s; existing
      `it`s untouched)

```ts
it("instanceReturning covers the full AR single-record finder surface (mn00t audit)", () => {
  for (const verb of [
    "find_or_create_by",
    "find_or_create_by!",
    "find_or_initialize_by",
    "create_or_find_by",
    "create_or_find_by!",
    "find_sole_by",
    "sole",
    "take!",
    "first!",
    "last!",
    "new",
  ]) {
    expect(RUBY_INSTANCE_RETURNING.has(verb), verb).toBe(true);
  }
});
it("relationReturning covers the full AR::QueryMethods chaining surface (mn00t audit)", () => {
  for (const verb of [
    "left_joins",
    "left_outer_joins",
    "or",
    "and",
    "merge",
    "rewhere",
    "reselect",
    "regroup",
    "unscoped",
    "only",
    "excluding",
    "without",
    "in_order_of",
    "strict_loading",
    "from",
    "extending",
    "annotate",
    "optimizer_hints",
  ]) {
    expect(RUBY_RELATION_RETURNING.has(verb), verb).toBe(true);
  }
});
```

Membership note for the implementer: verify each candidate against Rails 7
`ActiveRecord::QueryMethods`/`FinderMethods` docs before adding; gem verbs
(factory_bot etc.) belong in their own framework module per `ruby-dsl.md` —
never in `rails.ts`.

- [ ] **Step 2: Run to verify failure**

Run:
`npx vitest run tests/core/domains/language/ruby/dsl/catalogue-method-semantics.test.ts`
Expected: FAIL on the missing verbs.

- [ ] **Step 3: Add the verbs to `rails.ts`** (pure data — extend the two
      `new Set([...])` literals at lines 138 and 150 with the audited
      membership; keep alphabetical grouping by family as in the current
      literal).

- [ ] **Step 4: Run tests to verify pass**

Run:
`npx vitest run tests/core/domains/language/ruby/dsl/catalogue-method-semantics.test.ts tests/core/domains/language/ruby/walker/type-sources/ast-inference.test.ts`
Expected: PASS (walker tests confirm no regression from the widened sets).

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/language/ruby/dsl/rails.ts tests/core/domains/language/ruby/dsl/catalogue-method-semantics.test.ts
git commit -m "feat(language): complete AR finder/query verb audit in rails dsl (mn00t)"
```

---

### Task 7: Resolver-level integration test — container binding → exact edges end-to-end

**Files:**

- Create:
  `tests/core/domains/language/ruby/resolver/ast-container-binding.integration.test.ts`
- Test: itself.

**Interfaces:**

- Consumes: full walker + `RubyTypeFactStore` + resolver chain, following the
  harness conventions of
  `tests/core/domains/language/ruby/resolver/type-propagation-container.test.ts`
  (Part 2 describes) — same imports, same symbol-table stubs.

- [ ] **Step 1: Write the test** (this task is pure verification of the F2+F3
      pipeline — it must pass immediately if Tasks 4–5 are correct; if it fails,
      the failure is a REAL integration bug to fix before proceeding)

Scenarios (one `it` each, source strings inline exactly like
`type-propagation-container.test.ts` does):

1. `posts = Post.where(active: true)` then `posts[0].title` → resolves exact
   `Post#title` (index receiver through the typed-container path).
2. `posts = Post.where(active: true)` then `posts.each { |p| p.title }` →
   block-param call resolves exact `Post#title`.
3. `@user ||= User.find(1)` in a class, then `@user.name` in another method of
   the same class → resolves exact `User#name` via `classFieldTypes`.

- [ ] **Step 2: Run**

Run:
`npx vitest run tests/core/domains/language/ruby/resolver/ast-container-binding.integration.test.ts`
Expected: PASS. Any failure → fix the walker-side supply (Tasks 2–5 code), NOT
the resolver.

- [ ] **Step 3: Commit**

```bash
git add tests/core/domains/language/ruby/resolver/ast-container-binding.integration.test.ts
git commit -m "test(language): container-binding end-to-end integration coverage (mn00t)"
```

---

### Task 8: Quality gates + live validation on bench corpora

**Files:**

- No source edits. Gates + measurement only.

- [ ] **Step 1: Full quality gates**

Run: `npx vitest run && npx tsc --noEmit && npm run lint` Expected: all green,
coverage not below threshold (if the pre-commit coverage gate fails on a later
commit, delegate to the `coverage-expander` subagent per project rules).

- [ ] **Step 2: Build + link the worktree** (worktree build rules: check
      `git worktree list` — if >1 active worktree, ask before building; build
      and link are ONE unit)

```bash
npm run build && npm link
```

Then ask the user for `/mcp reconnect` and WAIT (rule: reconnect-after-build).

- [ ] **Step 3: Reindex bench corpora — USER-GATED, never auto**

```bash
tea-rags index-codebase --project bench-mastodon --wait-enrichments --force --json
tea-rags index-codebase --project huginn --wait-enrichments --force --json
```

- [ ] **Step 4: Measure against baselines** (via
      `mcp__tea-rags__get_index_status` codegraphResolve after reconnect)

| Metric                                | mastodon baseline | huginn baseline | Gate                                         |
| ------------------------------------- | ----------------- | --------------- | -------------------------------------------- |
| dynamic inProjectEdgeRecall           | 0.865 / 9749      | 0.660 / 3097    | must rise                                    |
| chain inProjectEdgeRecall             | 0.842 / 6075      | 0.488 / 914     | must not fall                                |
| index inProjectEdgeRecall             | 0.485 / 1641      | 0.333 / 1092    | primary target — visible rise                |
| edgeKinds.dynamic / exactRatio        | 60270 / 0.117     | —               | dynamic down, exactRatio up                  |
| externalSkipped + callsNoInProjectDef | 1268+241 (index)  | —               | MUST NOT grow (honest denominator, n2kpz L2) |

- [ ] **Step 5: On successful validation — commit is auto-authorized (project
      rule), update beads**

```bash
bd close tea-rags-mcp-mn00t --reason "landed: <measured deltas>"
bd comments add tea-rags-mcp-h4d5s -m "re-measure after mn00t: index recall <old> -> <new>"
```

Merge to main / push / relink: ONLY on explicit user request.
