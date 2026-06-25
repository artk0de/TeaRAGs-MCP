# Ruby External-Member Suppression (Increment D) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Suppress the Ruby dynamic-dispatch fan-out when an untyped receiver
calls an AR/core instance member (`id`/`update`/`destroy`/`to_json`…) whose true
target is an external base class, and reclassify the call as external so it is
neither a noise edge nor an in-project miss.

**Architecture:** Two-part suppression mirroring increments A (index-suppress)
and B-suppress (chain-tail). A curated flat Set
`ACTIVE_RECORD_INSTANCE_BUILTINS` lives in `dsl/rails-runtime.ts`; a direct
predicate `isExternalQualifiedMember` in `dsl/catalogue.ts`. Consumer 1 is a
guard in `RubyDynamicDispatchResolver.resolveDispatch` (suppress the fan-out).
Consumer 2 is an additive-optional
`ExternalVocabulary.isQualifiedMemberExternal` arm consulted by
`ExternalCallClassifier.targetsExternal` on the qualified branch (reclassify as
external, not a miss).

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), vitest. Source spec:
`docs/superpowers/specs/2026-06-24-ruby-external-member-suppression-design.md`.

## Global Constraints

- Each unit test pins the EXACT outcome (`resolveDispatch` returns `[]` AND/OR
  `targetsExternal` returns `true`) — never just non-empty. A wrong suppression
  is invisible in aggregate ratios.
- The `ExternalVocabulary` interface change is **additive-optional**
  (`isQualifiedMemberExternal?: (member: string) => boolean`, default-absent →
  `false`). NO non-Ruby implementer (TS etc.) may regress; Task 3 asserts this
  explicitly.
- Chain-order safety is an EXPLICIT test: a project method shadowing a V_core
  name, on a TYPED receiver, resolves exact via the strategy chain and never
  reaches the guard.
- The V_core member list in code MUST match spec §"V_core membership (v1)"
  verbatim. Disputed members
  (`as_json`/`count`/`select`/`find`/`where`/`create`) are EXCLUDED in v1.
- Branch: `worktree-ext-member-suppress`. Test runner: `npx vitest run <file>`.
  Pre-commit: prettier + (on src changes) tsc + full suite.
- All target files are artk0de single-owner deep-silo → each task flagged for
  owner pair-review at task-review time.

---

## File Structure

| File                                                                          | Responsibility                                                                                                                              | Task |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| `src/core/domains/language/ruby/dsl/rails-runtime.ts`                         | `+ACTIVE_RECORD_INSTANCE_BUILTINS` flat Set (qualified-untyped-receiver AR-core members), beside `RAILS_RUNTIME_BUILTINS` (bare-call axis). | 1    |
| `src/core/domains/language/ruby/dsl/catalogue.ts`                             | `+isExternalQualifiedMember(member)` direct predicate, beside `isExternalBareCall`.                                                         | 1    |
| `src/core/domains/language/ruby/dsl/index.ts`                                 | Export `isExternalQualifiedMember`.                                                                                                         | 1    |
| `src/core/domains/language/ruby/resolver/strategies/ruby-dynamic-dispatch.ts` | Consumer 1: guard before `lookupByShortName`.                                                                                               | 2    |
| `src/core/contracts/types/language.ts`                                        | `ExternalVocabulary` += additive-optional `isQualifiedMemberExternal?`.                                                                     | 3    |
| `src/core/domains/language/external-classifier.ts`                            | `targetsExternal` qualified branch consults the optional member predicate.                                                                  | 3    |
| `src/core/domains/language/ruby/resolver/ruby-external-vocabulary.ts`         | `RubyExternalVocabulary` implements `isQualifiedMemberExternal`.                                                                            | 3    |

Tests EXTEND existing suites (do not rewrite):
`tests/.../ruby/dsl/rails-runtime.test.ts`,
`tests/.../ruby/dsl/catalogue.test.ts`,
`tests/.../ruby/resolver/strategies/ruby-dynamic-dispatch.test.ts`,
`tests/.../ruby/resolver/ruby-external-vocabulary.test.ts`,
`tests/.../language/external-classifier.test.ts`, plus a provider-level test
under `tests/core/domains/trajectory/codegraph/`.

---

## Task 1: V_core Set + predicate (LOW-blast, isolated)

**Files:**

- Modify: `src/core/domains/language/ruby/dsl/rails-runtime.ts` (append a second
  exported Set)
- Modify: `src/core/domains/language/ruby/dsl/catalogue.ts:57-63` (add predicate
  beside `isExternalBareCall`)
- Modify: `src/core/domains/language/ruby/dsl/index.ts:1` (export the predicate)
- Test: `tests/core/domains/language/ruby/dsl/catalogue.test.ts`

**Interfaces:**

- Produces: `ACTIVE_RECORD_INSTANCE_BUILTINS: ReadonlySet<string>` (in
  `rails-runtime.ts`); `isExternalQualifiedMember(member: string): boolean` (in
  `catalogue.ts`, re-exported from `dsl/index.ts`).

**Proven templates (L1):** `RAILS_RUNTIME_BUILTINS` in the same file is the
exact Set shape; `isExternalBareCall` (`catalogue.ts:63`) is the exact predicate
shape — but use a DIRECT `.has()` (single source, per spec), not a
`FRAMEWORKS.some` fold.

- [ ] **Step 1: Write the failing membership test**

Append to `tests/core/domains/language/ruby/dsl/catalogue.test.ts`:

```ts
import { isExternalQualifiedMember } from "../../../../../../src/core/domains/language/ruby/dsl/index.js";

describe("isExternalQualifiedMember (AR-core instance members, qualified-untyped axis)", () => {
  it("is true for AR-core identity / write / serialization members", () => {
    for (const m of [
      "id",
      "update",
      "destroy",
      "to_json",
      "persisted?",
      "reload",
    ]) {
      expect(isExternalQualifiedMember(m)).toBe(true);
    }
  });
  it("is false for an excluded lifecycle / universal member", () => {
    for (const m of ["save", "save!", "present?", "to_s", "each", "class"]) {
      expect(isExternalQualifiedMember(m)).toBe(false);
    }
  });
  it("is false for a project method name", () => {
    expect(isExternalQualifiedMember("handle_details_post")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/domains/language/ruby/dsl/catalogue.test.ts`
Expected: FAIL — `isExternalQualifiedMember` is not exported.

- [ ] **Step 3: Add the Set to `rails-runtime.ts`**

Append after `RAILS_RUNTIME_BUILTINS` (keep the file's existing export):

```ts
/**
 * ActiveRecord / ActiveModel CORE INSTANCE members that exist on a framework
 * base class (`ActiveRecord::Base`, `ActiveModel`) and that the Rails idiom
 * does NOT override on a domain object as a public instance method invoked via
 * an explicit untyped receiver. A call `untyped_receiver.member` whose member
 * is one of these targets the external base class — fanning out to a
 * coincidental in-project def of the same name is wrong-type noise.
 *
 * This is the QUALIFIED-untyped-receiver axis (`agent.update`), distinct from
 * `RAILS_RUNTIME_BUILTINS` which is the BARE-call axis (`params`/`render`).
 * Consumed by `dsl/catalogue.ts:isExternalQualifiedMember` → the dynamic-dispatch
 * guard + the external classifier arm (bd tea-rags-mcp-i9id8).
 *
 * Chain-order safety: a project method that shadows one of these names resolves
 * first via the strategy chain and never reaches the guard, so this set never
 * mis-marks a real project method (same invariant as RAILS_RUNTIME_BUILTINS, bd
 * 5os8y). DELIBERATELY EXCLUDED: save/save!/present?/valid? (idiomatically
 * overridden) and to_s/each/map/select/first/last/size/class/count
 * (Object/Enumerable universals — need receiver-type discrimination).
 */
export const ACTIVE_RECORD_INSTANCE_BUILTINS: ReadonlySet<string> =
  new Set<string>([
    // identity / introspection
    "id",
    "to_param",
    "persisted?",
    "new_record?",
    "destroyed?",
    "attributes",
    "attribute_names",
    "errors",
    // persistence-write (non-`save`)
    "update",
    "update!",
    "update_attribute",
    "update_attributes",
    "update_column",
    "update_columns",
    "destroy",
    "destroy!",
    "delete",
    "touch",
    "increment!",
    "decrement!",
    "reload",
    "becomes",
    // serialization
    "to_json",
    "to_xml",
  ]);
```

- [ ] **Step 4: Add the predicate to `catalogue.ts`**

Add the import at the top of `catalogue.ts` (beside the other `./` imports) and
the predicate after `isExternalBareCall` (line 63):

```ts
import { ACTIVE_RECORD_INSTANCE_BUILTINS } from "./rails-runtime.js";
```

```ts
/**
 * Is `member` an AR/core instance method that, on an UNTYPED qualified receiver
 * (`agent.update`), targets an external base class rather than any in-project
 * def of the same name? Direct membership in the curated set — single source,
 * NOT a framework fold (the set is Rails/AR-specific). The dynamic-dispatch
 * guard + external classifier consult this (bd tea-rags-mcp-i9id8).
 */
export const isExternalQualifiedMember = (member: string): boolean =>
  ACTIVE_RECORD_INSTANCE_BUILTINS.has(member);
```

- [ ] **Step 5: Export from `dsl/index.ts`**

In `src/core/domains/language/ruby/dsl/index.ts`, add
`isExternalQualifiedMember` to the existing `catalogue.js` re-export line:

```ts
export {
  isExternalBareCall,
  isExternalQualifiedMember,
  RUBY_DSL,
} from "./catalogue.js";
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/core/domains/language/ruby/dsl/catalogue.test.ts`
Expected: PASS (all three new cases).

- [ ] **Step 7: Commit**

```bash
git add src/core/domains/language/ruby/dsl/rails-runtime.ts src/core/domains/language/ruby/dsl/catalogue.ts src/core/domains/language/ruby/dsl/index.ts tests/core/domains/language/ruby/dsl/catalogue.test.ts
git commit -m "feat(trajectory): AR-core instance-member vocab + isExternalQualifiedMember (increment D / i9id8)"
```

---

## Task 2: Consumer 1 — the fan-out guard (LOW-blast, deep-silo)

**Files:**

- Modify:
  `src/core/domains/language/ruby/resolver/strategies/ruby-dynamic-dispatch.ts`
  (import + one guard line in `resolveDispatch`, after the
  `receiverChainTailIsExternal` guard ~line 67, before `lookupByShortName`
  ~line 70)
- Test:
  `tests/core/domains/language/ruby/resolver/strategies/ruby-dynamic-dispatch.test.ts`

**Interfaces:**

- Consumes: `isExternalQualifiedMember` (Task 1).
- Produces: no new symbol — `resolveDispatch` now returns `[]` for an untyped
  receiver whose member ∈ V_core.

**Proven templates (L1):** the sibling guards `receiverIsIndexAccess(r)`
(increment A) and `receiverChainTailIsExternal(r)` (B-suppress) already in this
method — the new guard is a member-based sibling line.

- [ ] **Step 1: Write the failing test (mirror the existing suite's setup)**

Add to `tests/.../ruby/resolver/strategies/ruby-dynamic-dispatch.test.ts`.
Mirror the file's existing helper that builds the resolver + an
`InMemoryGlobalSymbolTable` seeded with same-named defs and a `CallContext`. The
new cases (an untyped receiver `agent` with no local binding, so the call
reaches the dynamic path):

```ts
it("suppresses fan-out for an AR-core member on an untyped receiver (V_core)", () => {
  // table seeded with an in-project `update` def so a fan-out WOULD occur
  const call = {
    callText: "agent.update",
    receiver: "agent",
    member: "update",
    startLine: 1,
  };
  expect(resolver.resolveDispatch(call, ctx)).toEqual([]);
});

it("does NOT suppress a project member on an untyped receiver (control)", () => {
  const call = {
    callText: "agent.handle_details_post",
    receiver: "agent",
    member: "handle_details_post",
    startLine: 1,
  };
  expect(resolver.resolveDispatch(call, ctx).length).toBeGreaterThan(0); // table seeds a def
});

it("does NOT suppress an EXCLUDED member (save / class stay fan-out)", () => {
  for (const member of ["save", "class"]) {
    const call = {
      callText: `agent.${member}`,
      receiver: "agent",
      member,
      startLine: 1,
    };
    expect(resolver.resolveDispatch(call, ctx).length).toBeGreaterThan(0); // table seeds a def
  }
});
```

(Use the suite's existing table/ctx/resolver builders; seed the symbol table
with in-project defs named `update`, `handle_details_post`, `save`, `class` so
the control/exclusion cases genuinely fan out absent the guard.)

- [ ] **Step 2: Run test to verify it fails**

Run:
`npx vitest run tests/core/domains/language/ruby/resolver/strategies/ruby-dynamic-dispatch.test.ts`
Expected: FAIL — `agent.update` fans out (returns a non-empty array) because the
guard does not exist yet.

- [ ] **Step 3: Add the guard**

In `ruby-dynamic-dispatch.ts`, add the import (beside the existing
`../../dsl/index.js`-style imports used elsewhere in the ruby module; this file
currently imports from `./shared.js` and `./ruby-ar-relation-guard.js` — add):

```ts
import { isExternalQualifiedMember } from "../../dsl/index.js";
```

Then, in `resolveDispatch`, immediately AFTER the
`receiverChainTailIsExternal(r)` guard and BEFORE the `lookupByShortName` line:

```ts
// AR/core instance member on an untyped receiver (`agent.update`): the true
// target is an external base class (ActiveRecord::Base, ActiveModel). Fanning
// out to a coincidental in-project def of the same name is wrong-type noise.
// Suppress; the external classifier (Consumer 2) reclassifies so recall is not
// penalised (bd tea-rags-mcp-i9id8). The receiver is already untyped here — all
// typed/constant/relation/index/external-chain receivers returned [] above.
if (isExternalQualifiedMember(call.member)) return [];
```

- [ ] **Step 4: Run test to verify it passes**

Run:
`npx vitest run tests/core/domains/language/ruby/resolver/strategies/ruby-dynamic-dispatch.test.ts`
Expected: PASS — `agent.update` → `[]`; control + excluded members still fan
out.

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/language/ruby/resolver/strategies/ruby-dynamic-dispatch.ts tests/core/domains/language/ruby/resolver/strategies/ruby-dynamic-dispatch.test.ts
git commit -m "feat(trajectory): suppress dynamic fan-out for AR-core members on untyped receivers (increment D / i9id8)"
```

---

## Task 3: Consumer 2 — the classifier arm (HIGH interface-blast — isolate)

**Files:**

- Modify: `src/core/contracts/types/language.ts:119-124` (`ExternalVocabulary`
  += additive-optional method)
- Modify: `src/core/domains/language/external-classifier.ts:21-25`
  (`targetsExternal` qualified branch)
- Modify: `src/core/domains/language/ruby/resolver/ruby-external-vocabulary.ts`
  (implement the method)
- Test: `tests/.../language/external-classifier.test.ts`,
  `tests/.../ruby/resolver/ruby-external-vocabulary.test.ts`

**Interfaces:**

- Consumes: `isExternalQualifiedMember` (Task 1).
- Produces:
  `ExternalVocabulary.isQualifiedMemberExternal?: (member: string) => boolean`;
  `RubyExternalVocabulary#isQualifiedMemberExternal`.

**Proven templates (L1):** increment A's index arm and B-suppress's chain-tail
arm — both added a branch to
`RubyExternalVocabulary.isQualifiedReceiverExternal`. This one adds a SEPARATE
optional method consulted by the neutral classifier (the receiver-vs-member axis
differs), keeping the change additive so non-Ruby vocabularies are untouched.

- [ ] **Step 1: Write the failing classifier test**

Add to `tests/.../language/external-classifier.test.ts`:

```ts
it("a qualified call to an external member is external even with an untyped receiver", () => {
  const vocab = {
    isBareCallExternal: () => false,
    isQualifiedReceiverExternal: () => false,
    isQualifiedMemberExternal: (m: string) => m === "update",
  };
  const classifier = new ExternalCallClassifier(vocab);
  const call = {
    callText: "agent.update",
    receiver: "agent",
    member: "update",
    startLine: 1,
  };
  expect(classifier.targetsExternal(call, ctx)).toBe(true);
});

it("a vocabulary WITHOUT isQualifiedMemberExternal still classifies exactly as before (no regression)", () => {
  const legacyVocab = {
    isBareCallExternal: () => false,
    isQualifiedReceiverExternal: () => false,
  };
  const classifier = new ExternalCallClassifier(legacyVocab);
  const call = {
    callText: "x.foo",
    receiver: "x",
    member: "foo",
    startLine: 1,
  };
  expect(classifier.targetsExternal(call, ctx)).toBe(false);
});
```

And to `tests/.../ruby/resolver/ruby-external-vocabulary.test.ts`:

```ts
it("isQualifiedMemberExternal is true for an AR-core member, false for a project method", () => {
  const vocab = new RubyExternalVocabulary();
  expect(vocab.isQualifiedMemberExternal("update")).toBe(true);
  expect(vocab.isQualifiedMemberExternal("handle_details_post")).toBe(false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
`npx vitest run tests/core/domains/language/external-classifier.test.ts tests/core/domains/language/ruby/resolver/ruby-external-vocabulary.test.ts`
Expected: FAIL — `isQualifiedMemberExternal` not on the interface / not
implemented; the classifier ignores the member.

- [ ] **Step 3: Extend the `ExternalVocabulary` interface (additive-optional)**

In `src/core/contracts/types/language.ts`, inside
`interface ExternalVocabulary`:

```ts
interface ExternalVocabulary {
  /** Is this no-receiver member a framework/runtime/builtin name (zero project defs)? */
  isBareCallExternal: (member: string) => boolean;
  /** Does this qualified receiver name a gem/stdlib symbol (no in-project target)? */
  isQualifiedReceiverExternal: (receiver: string, ctx: CallContext) => boolean;
  /**
   * Is this MEMBER, on an untyped qualified receiver, an external base-class
   * instance method (e.g. `agent.update` → ActiveRecord::Base#update)? Optional:
   * a vocabulary that does not distinguish the member axis omits it and the
   * classifier treats it as `false` (no behavior change). bd tea-rags-mcp-i9id8.
   */
  isQualifiedMemberExternal?: (member: string) => boolean;
}
```

- [ ] **Step 4: Wire the neutral classifier**

In `src/core/domains/language/external-classifier.ts`, replace the
`targetsExternal` body:

```ts
targetsExternal(call: CallRef, ctx: CallContext): boolean {
  if (call.receiver === null) return this.vocab.isBareCallExternal(call.member);
  return (
    this.vocab.isQualifiedReceiverExternal(call.receiver, ctx) ||
    (this.vocab.isQualifiedMemberExternal?.(call.member) ?? false)
  );
}
```

- [ ] **Step 5: Implement on `RubyExternalVocabulary`**

In `ruby-external-vocabulary.ts`, ensure `isExternalQualifiedMember` is imported
from `../dsl/index.js` (the file already imports from `../dsl/index.js`), and
add the method to the class:

```ts
isQualifiedMemberExternal(member: string): boolean {
  return isExternalQualifiedMember(member);
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run:
`npx vitest run tests/core/domains/language/external-classifier.test.ts tests/core/domains/language/ruby/resolver/ruby-external-vocabulary.test.ts`
Expected: PASS — external classification for the member axis; legacy vocab
unchanged.

- [ ] **Step 7: Add the chain-order-safety (shadow) test**

Add to `tests/.../ruby/resolver/strategies/ruby-dynamic-dispatch.test.ts` (or
the resolver-dispatch suite), proving a TYPED receiver with a project
`def update` resolves exact via the chain and never reaches the member guard:

```ts
it("chain-order safety: a project `update` on a TYPED receiver resolves exact, not suppressed", () => {
  // ctx.localBindings binds `obj` to a project type that defines `update`;
  // resolveDispatch must return [] here ONLY because the typed-local guard owns
  // it (early return at the localBindings check), NOT the member guard — verify
  // the exact chain resolves the call to the project Model#update edge.
  // (Use the suite's typed-receiver / cone fixture; assert the resolved exact edge.)
});
```

(Implement against the suite's existing typed-receiver fixture; the assertion is
that the resolved target is the in-project `Model#update`, demonstrating the
member guard is never consulted for a typed receiver.)

- [ ] **Step 8: Run the full ruby resolver + classifier suites**

Run: `npx vitest run tests/core/domains/language/` Expected: PASS — no non-Ruby
`ExternalVocabulary` implementer regresses (the additive-optional change
defaults to `false`).

- [ ] **Step 9: Commit**

```bash
git add src/core/contracts/types/language.ts src/core/domains/language/external-classifier.ts src/core/domains/language/ruby/resolver/ruby-external-vocabulary.ts tests/core/domains/language/external-classifier.test.ts tests/core/domains/language/ruby/resolver/ruby-external-vocabulary.test.ts tests/core/domains/language/ruby/resolver/strategies/ruby-dynamic-dispatch.test.ts
git commit -m "feat(contracts): member-aware external classification for AR-core members (increment D / i9id8)"
```

---

## Task 4: Provider integration + full verify + huginn live-validation

**Files:**

- Test: a provider-level test under `tests/core/domains/trajectory/codegraph/`
  mirroring the existing `inproject-edge-recall` driver.

**Interfaces:**

- Consumes: the whole feature (Tasks 1-3) end-to-end through the codegraph
  provider.

- [ ] **Step 1: Write the provider-level integration test**

Mirror the `inproject-edge-recall` driver: index a small Ruby fixture containing
`agent.update` (untyped receiver, in-project `update` def present elsewhere)
plus a control `agent.handle_details_post`. Assert, via the run stats / edges:

```
# the V_core call: suppressed + reclassified
agent.update      → externalSkipped >= 1, dynamic edge for `update` absent, NOT noInProjectDef
# the control: unchanged
agent.handle_details_post → still a dynamic edge (fan-out unchanged)
```

- [ ] **Step 2: Run it to verify it fails, then passes**

Run: `npx vitest run <new-provider-test-file>` Expected: with Tasks 1-3 merged,
PASS; if run before, the `agent.update` assertion FAILS (it fans out).

- [ ] **Step 3: Full verification**

Run: `npx tsc --noEmit` (expect 0) and `npx vitest run` (expect full suite
green). Pre-commit will also run these.

- [ ] **Step 4: huginn live-validation (user-gated build + reindex)**

This requires building + linking the worktree and a huginn force-reindex — BOTH
user-gated (parallel worktrees + shared index + ollama). Do NOT auto-run. When
the user authorizes:

```bash
cd /Users/artk0re/Dev/Tools/tea-rags-mcp/.claude/worktrees/ruby-lsp-spike
npm run build && npm link        # then ask for /mcp reconnect, WAIT
tea-rags index-codebase --project huginn --wait-enrichments --force --json
```

Assert from the JSON + a categorized removed-edge sample (mirror increments
A/B):

- exactRatio ↑ (target ≈ +2pp from the post-A 0.361 baseline), dynamic ↓ by ≈
  the curated count (~409 on the prior measure).
- **ZERO exact-edge loss** (suppression only ever touched dynamic edges).
- Dynamic-bucket `externalSkipped` ↑, `noInProjectDef` not increased
  (reclassification, not new misses).
- Every removed edge is a V_core member on an untyped receiver; **NO
  `save`/`save!`/`present?` edge removed**.
- Every other receiverKind
  (bareCall/constant/ivar/selfMember/localVar/super/chain) byte-identical
  before/after.

- [ ] **Step 5: Close the bead (after successful live-validation only)**

```bash
bd close tea-rags-mcp-i9id8 --reason="<measured exactRatio delta, dynamic delta, zero exact-edge loss>"
```

Worktree-only — NO merge / NO push without an explicit user request.

---

## Self-Review

**Spec coverage:** §Mechanism/the-hole → Task 3 (classifier member axis).
§V_core membership → Task 1 (verbatim Set). §Architecture (flat Set in dsl,
direct predicate, two consumers) → Tasks 1-3. §Soundness/chain-order → Task 3
Step 7 (explicit shadow test). §Testing → Tasks 1-3 unit pins. §Validation →
Task 4. §Out-of-scope (Slice 2) → not implemented (correct). No gaps.

**Placeholder scan:** Task 2 Step 1 and Task 3 Step 7 reference "the suite's
existing fixture/builders" rather than inlining the full ctx/table helper — this
is deliberate (the helpers exist in the target test files and the implementer
extends them in place; reproducing them verbatim risks drift from the real
suite). The assertions and the exact CallRef shapes ARE given. No "TBD"/"handle
edge cases"/empty-test placeholders.

**Type consistency:** `isExternalQualifiedMember(member: string): boolean`
consistent across Tasks 1/2/3.
`ACTIVE_RECORD_INSTANCE_BUILTINS: ReadonlySet<string>` consistent.
`isQualifiedMemberExternal?` optional-on-interface ↔
non-optional-on-RubyExternalVocabulary (a class may implement an optional member
as required — valid). `targetsExternal(call: CallRef, ctx: CallContext)` matches
the existing signature. `CallRef` literal shape
`{ callText, receiver, member, startLine }` matches
`external-classifier.test.ts`.

---

## Execution Handoff

REQUIRED SUB-SKILL: dinopowers:subagent-driven-development (the wrapper, NOT raw
superpowers) — fresh subagent per task + two-stage review, RED-first. Tasks
1→2→3 are sequential (3 consumes 1; 2 consumes 1); Task 4 is the integration +
live-validation gate.
