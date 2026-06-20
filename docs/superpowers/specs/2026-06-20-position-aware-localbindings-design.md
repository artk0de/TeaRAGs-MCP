# Position-aware `localBindings` + Ruby RHS expansion

**Date:** 2026-06-20 **Epic:** tea-rags-mcp-7ukxt (P3: local type environment)
**Core task:** tea-rags-mcp-qo4n2 **Parent program:** tea-rags-mcp-cai0 (Ruby
resolver precision)

## Problem

`localBindings` maps an in-scope variable name to its inferred receiver type so
that `var.method()` calls resolve to the type's class (and the CHA cone
devirtualizes against it). Two deficiencies cap recall — P3 is the single
biggest **syntactic** recall lever in cai0 (~+25 `resolveSuccessRate`, 0.33 →
~0.58 range):

1. **Sparse RHS population.** The Ruby walker (`collectLocalBindingsForChunk`,
   `walker.ts:333`) binds a local's type only from `var = ClassName.new` and a
   small AR-finder set (`find/find_by/find_by!/create/create!/first/last/take`).
   Common instance-returning forms (`build`, `find!`), copy propagation
   (`var = other_var`), multiple assignment (`a, b = X.new, Y.new`), and
   param-default inference (`def f(x = User.new)`) are not captured.

2. **No flow-sensitivity.** The binding map is a flat
   `Record<varName, typeName>` with **last-write-wins** semantics across the
   whole chunk. A call that precedes a reassignment receives the _later_ type —
   a guess that contradicts the project's DROP-not-guess philosophy
   (`RubyLocalTypeSymbolResolutionStrategy` drops rather than guesses when a
   binding's file is unknown). Example:

   ```ruby
   def m
     x = A.new
     x.foo      # flat map says x : B → WRONG (resolves against B)
     x = B.new
     x.bar      # x : B → correct
   end
   ```

## Decision summary

Two design forks, both resolved in brainstorming:

- **Flow model:** position-aware. The binding contract carries the source line
  of each binding; each call site resolves against the most-recent binding on
  the path (`line <= call.startLine`). This subsumes sub-task lv4o3.
- **Scope:** uniform cross-language migration. `localBindings` is a **shared**
  contract (`ChunkExtraction` + `CallContext`); its value is read as a type
  string in **7** sites — the language-neutral `ConeDispatchResolver` plus the
  six per-language local-binding resolvers (python, go, ts, rust, java, ruby) —
  and written by **6** walkers. A single source of truth (no parallel
  `localBindingsFlow` field — that is the parallel-data-path anti-pattern
  forbidden by `imports-field-semantics.md`) means the contract changes for all
  languages; the non-Ruby languages get flow-sensitivity for free.

`const-ref` (`var = CONST` where `CONST` is a class) is **deferred**: a
const-ref binds the variable to the _class object_, so `var.find` is a
class-method call (`User.find`) and `var.new` is instantiation — semantics that
do not fit the instance-type map. It needs a class-valued binding kind and is
closer to the class-method-form work (va9ng/exmwr). Tracked as a new follow-up
task; sub-task ybyar narrows to copy-propagation only.

## Architecture

### 1. Contract (`contracts/types/codegraph.ts`) — BREAKING

```ts
export interface LocalBinding {
  /** 1-based source line where the binding is established. */
  line: number;
  /** Inferred instance type (class name), e.g. "User" or "Acme::Post". */
  type: string;
}
```

- `ChunkExtraction.localBindings?: Record<string, LocalBinding[]>` (was
  `Record<string, string>`).
- `CallContext.localBindings?: Record<string, LocalBinding[]>`.

`Record` (not `Map`) is preserved so the structure round-trips through the
NDJSON spill — an array of plain objects serializes cleanly via
`JSON.stringify`/`JSON.parse`, same constraint that originally rejected `Map`.

Pure resolver helper, colocated with the type (precedent: `pickSingleCandidate`,
`lastConstantSegment` already live in `contracts/types/codegraph.ts`):

```ts
/**
 * Most-recent binding for `varName` whose line is at or before `atLine`
 * (greatest `line <= atLine`). Returns undefined when the variable has no
 * binding established on or before that line — the call then falls through
 * (no local type), preserving DROP-not-guess.
 */
export function resolveLocalBindingType(
  bindings: Record<string, LocalBinding[]> | undefined,
  varName: string,
  atLine: number,
): string | undefined;
```

`<=` (not `<`): a variable's own calls are always on a strictly later line than
its binding statement (`x = A.new` on line N; `x.foo` on line > N — the only
call on line N is `A.new`, whose receiver is the constant `A`, not `x`). `<=` is
safe and tolerant of the rare same-line case.

### 2. Readers — 7 sites route through the helper

`ctx.localBindings?.[call.receiver]` →
`resolveLocalBindingType(ctx.localBindings, call.receiver, call.startLine)` in:

- `domains/language/cone-dispatch.ts:45` (shared, language-neutral)
- `domains/language/python/resolver/strategies/python-local-binding.ts:34`
- `domains/language/go/resolver/strategies/go-local-binding.ts:24`
- `domains/language/typescript/resolver/strategies/ts-local-binding.ts:27`
- `domains/language/rust/resolver/strategies/rust-local-binding.ts:27`
- `domains/language/java/resolver/strategies/java-local-binding.ts:22`
- `domains/language/ruby/resolver/strategies/ruby-local-type.ts:31`

`call.startLine` already exists on `CallRef`. No change to:

- `receiver-kind.ts` `classifyReceiverKind` — uses `hasOwnProperty`, which is
  shape-agnostic (key present ⇒ the receiver is a `localVar`, independent of
  per-line type).
- `provider.ts:1670` — passes `chunk.localBindings` through unchanged; the new
  shape propagates transparently.

### 3. Walkers — emission migration (6 languages)

Each walker's binding collection changes from `out[v] = type` to
`(out[v] ??= []).push({ line, type })`, where `line` is the assignment node's
1-based line (already available at the emission site). Non-Ruby walkers keep
their existing single-binding behavior — no new RHS forms, only the shape
wrapper. Existing per-language binding test **examples are preserved**; fixtures
adapt to the array shape (`{ x: "Foo" }` → `{ x: [{ line: N, type: "Foo" }] }`),
and the per-file `it`/`describe` count must be `>=` the base branch
(domains-language migration rule).

### 4. Ruby walker — core feature, extracted to `walker/local-bindings.ts`

`walker.ts` is a churn hotspot (`collectRubyCalls` is 227 lines). The binding
machinery is extracted into a new cohesive module
`domains/language/ruby/walker/local-bindings.ts` (same subdomain — deep import
within `ruby/walker/` is allowed). Moved as-is first, then extended.

Extracted symbols: `collectLocalBindingsForChunk`, `collectYardParamTypes`,
`collectYardReturnTypes`, `parseYardBracketType`, `AR_INSTANCE_FINDERS`, the
YARD regex constants.

**Relocation discipline (refactor-migration-test-order rule):** relocate code →
existing tests green (imports adapted) → redistribute binding tests into a
dedicated test file **last**. No new behavior during the move.

Then, TDD per feature:

- **Position-aware collection.** Walk assignment nodes in source order (the walk
  is DFS pre-order ⇒ source order) and `push({ line, type })` per binding. YARD
  `@param` bindings take the `def` line (the parameter is in scope from method
  entry).
- **P3.1 RHS widening (w6ysj).** Add `build` and `find!` to the
  instance-returning method set (`find`, `find_by`, `find_by!`, `create`,
  `create!`, `first`, `last`, `take` already present). Define one shared
  `INSTANCE_RETURNING_METHODS` constant — the single source of truth that va9ng
  later wires onto `ResolverConfig`.
- **P3.2 copy-propagation (ybyar, narrowed).** RHS that is a bare `identifier`
  matching an already-bound variable copies that variable's most-recent type
  (the last binding pushed for it before the current line). `const-ref` deferred
  to a new task.
- **P3.4 multiple-assignment + param-default (txkej).**
  - Multiple assignment `a, b = X.new, Y.new`: pair `left_assignment_list`
    identifiers against the RHS expression list positionally **only when lengths
    match** and each RHS is a recognized instance-returning form. Splat or
    uneven arity → skip the statement (no guessing).
  - Param-default inference: `def f(x = User.new)` binds `x : User` for the
    method body (line = `def` line). Block parameters and untyped bare
    parameters are skipped — they need container/element typing (VTA, sub-task
    wbj3), out of scope here.
- **lv4o3 flow-sensitivity.** Subsumed by the position-aware collection +
  `resolveLocalBindingType` at call sites. Closed as delivered by the core.
- **93b0q measurement.** Blocked on ykj7 (denominator fix); excluded from this
  spec, stays open.

## Data flow

```
Ruby source
  → walker/local-bindings.ts: collectLocalBindingsForChunk
      (source-order push of {line, type} per binding; YARD + .new + finders
       + copy-prop + multi-assign + param-default)
  → ChunkExtraction.localBindings: Record<varName, LocalBinding[]>
  → [NDJSON spill round-trip during cross-file resolution]
  → CallContext.localBindings
  → resolveLocalBindingType(bindings, receiver, call.startLine)
      ├─ RubyLocalTypeSymbolResolutionStrategy.attempt  (direct localType resolve)
      └─ ConeDispatchResolver.resolveDispatch           (CHA cone devirtualization)
```

## Error handling

- Unrecognized RHS forms (bare factory calls, chained Relation tails, unknown
  receiver shapes) produce **no binding** — never a guess.
- Length-mismatched multiple assignment, splat targets → statement skipped.
- A call with no binding established on or before its line →
  `resolveLocalBindingType` returns `undefined` → resolver falls through
  (CONTINUE), no edge invented.
- Reassignment to a different type is **not** a conflict to drop — it is exactly
  the flow-sensitive case each call site now resolves correctly by line.

## Testing strategy

- Relocation (Task 0) first, full suite green before any behavior change.
- Cross-language: adapt fixtures to the array shape; preserve every existing
  binding example; `it`/`describe` counts `>=` base per language test file.
- New Ruby unit tests (TDD red→green):
  - position-aware: a call before and a call after a reassignment resolve to
    different types within one method.
  - each new RHS form: `build`, `find!`, copy-prop, multi-assign (matched and
    mismatched arity), param-default.
  - `resolveLocalBindingType`: `<=` boundary, no-binding-before-line returns
    undefined, multiple bindings pick the greatest line ≤ call line.
- Unit + `npm run build` are sufficient for this spec. Live `resolveSuccessRate`
  validation (the ~+25 claim) is sub-task 93b0q, blocked on ykj7.

## Beads (plan-beads-sync)

Epic tea-rags-mcp-7ukxt:

- **w6ysj** (P3.1 RHS widening) — in scope.
- **ybyar** (P3.2) — narrowed to copy-propagation; const-ref split out.
- **lv4o3** (P3.3 flow-sensitivity) — subsumed by core position-aware; close as
  delivered.
- **txkej** (P3.4 multi-assign + param-default) — in scope.
- **93b0q** (P3.5 measurement) — excluded, blocked on ykj7.
- **NEW** — cross-language `localBindings` contract migration (reclassification
  of the position-aware-uniform decision).
- **NEW** — const-ref class-valued binding (deferred from ybyar).

## Out of scope

- const-ref class-valued bindings (deferred follow-up).
- Block-parameter / collection-element typing (VTA, sub-task wbj3).
- Chained Relation-tail return typing (`Model.where(...).first`).
- Bare factory return typing (`var = make_user()`) — no class name to attribute.
- Live recall measurement (93b0q, blocked on ykj7).
