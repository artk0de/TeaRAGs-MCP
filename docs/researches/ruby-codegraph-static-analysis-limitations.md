# Ruby Codegraph Static-Analysis Limitations

**Date:** 2026-06-06 **Status:** Reference **Scope:**
`src/core/domains/language/ruby/` — `walker/walker.ts`, `walker/name-of.ts`,
`resolver/strategies/`

---

## 1. Purpose

The Ruby codegraph builds its call/reference graph by walking the tree-sitter
AST — a purely **syntactic** pass. Several Ruby idioms compute the call target
(or the method definition itself) at **runtime**, so the AST carries no static
evidence of the edge. This document catalogues those idioms, why each is
unresolvable by AST walking, and the graph impact (missed edges / understated
`fanOut`).

These are **properties of Ruby semantics, not bugs in tea-rags.** None of them
should be re-opened as defects against the resolver. Where a heuristic recovers
a _subset_ of cases, that is called out explicitly with its boundary.

The practical consequence for users: chunks built around these idioms show
`fanOut ≈ 0` despite real coupling. Treat low fan-out on a dispatch hub
(registry, factory, const-remap engine) as a **recall gap**, not as evidence the
code is decoupled.

---

## 2. What IS resolved (so the gaps are precise)

Before the limitations, the cases the walker DOES recover statically — so the
boundary is unambiguous:

| Idiom                                                                                 | Handling                                                                       | Mechanism                                                                  |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `obj.send(:foo)` / `public_send("foo")` / `__send__` with a **literal** symbol/string | Unwrapped to a direct `obj.foo` call                                           | `RUBY_DYNAMIC_DISPATCH` set in `walker.ts`; `extractLiteralSymbolOrString` |
| `alias new old` (keyword) and `alias_method :new, :old` (class-body)                  | Synthetic redirect edge `new → old`                                            | `alias` node branch + `RUBY_DSL[...].redirectTarget` in `walker.ts`        |
| `define_method(:foo) { ... }` with a **literal** name                                 | Declares `foo` on the enclosing class                                          | `rubyDefineMethodEmission` in `name-of.ts`                                 |
| `include` / `extend` / `prepend` / `class Foo < Bar`                                  | Folded into `classAncestors` / `classPrependedAncestors` (forward inheritance) | `collectRubyClassAncestors` in `walker.ts`                                 |
| `users.each(&:save)` symbol-to-proc                                                   | Emits a `save` call edge                                                       | `extractBlockPassMethod` in `walker.ts`                                    |

Everything in section 3 is what remains **after** these recoveries.

---

## 3. Unresolvable idioms

### 3.1 `method_missing` / `respond_to_missing?`

**Why unresolvable.** The dispatched method name and target exist only at
runtime — `method_missing(name, *args)` synthesises behaviour for names that
were never written as `def`. There is no AST node naming the target.

**Impact.** Every call routed through a `method_missing` hub is graph-dark.
Callers of dynamically-handled methods show no edge to the handler; the handler
chunk shows no incoming fan-in from its real callers.

**Status.** Out of scope, intentional — noted as "pure runtime dispatch,
unrepresentable" in `name-of.ts`. No tracking issue; this is permanent.

### 3.2 `send` / `public_send` / `__send__` with a **dynamic** argument

**Why unresolvable.** `obj.send(verb)` where `verb` is a variable, method
return, or interpolated string has no literal name in the AST. Only the
literal-argument form is unwrapped (see section 2).

**Impact.** Dynamic-dispatch call sites emit no edge. Because the receiver is
set but the type is unknown, the `receiverSetDrop` guard
(`ruby-receiver-set-drop.ts`, bd `tea-rags-mcp-lttd`) deliberately **drops**
rather than guessing a same-named method on an unrelated class — correct
behaviour, but it means zero edge, not a wrong edge.

**Status.** Permanent for dynamic args (the literal case is already covered).

### 3.3 `define_method` / `define_singleton_method` with a **dynamic** name

**Why unresolvable.** `define_method("foo_#{x}") { ... }` or
`define_method(verb) { ... }` constructs the method name at runtime. The
literal-name form is recovered (section 2); only the dynamic form is dark.

**Impact.** The method symbol is never registered, so calls to it never resolve
— fan-in to the generated method is missed.

**Status.** Permanent for dynamic names — noted in `name-of.ts` as "dynamically
constructed names: `define_method(\"foo_#{x}\")` etc."

### 3.4 `Module#refine` + `using` (refinements)

**Why unresolvable.** Refinements are **lexically scoped** monkey-patches: a
method added by `refine String do ... end` is visible only in files/blocks that
`using` the refinement. Resolving the call target requires modelling the lexical
activation scope at each call site, which the syntactic walker does not track.

**Impact.** Calls to refined methods either miss the refinement edge or — worse
in principle — could bind to the unrefined original. The walker emits neither;
refinement-added methods are invisible to the symbol table.

**Status.** Out of scope, permanent.

### 3.5 `Module#prepend` — runtime method-resolution-order

**Why this is a _partial_ limitation.** `prepend Mod` IS captured structurally:
`collectRubyClassAncestors` records prepended modules in
`classPrependedAncestors` (bd `tea-rags-mcp-3jvn`), and the resolver checks
prepended modules first in MRO order. What remains unresolvable is the general
case where the prepend is itself conditional or dynamic
(`prepend(cond ? A : B)`), or where the prepended module is computed at runtime
— the literal-constant mixin is the only recovered form.

**Impact.** Static literal prepends resolve; computed/conditional prepends do
not, mirroring section 4.1's string-to-class problem.

---

## 4. Dynamic class-resolution family (taxdome probe, 2026-06-05)

A probe of a large Rails monolith surfaced a family of **string → class** and
**type-column → subclass** dispatch sites that are graph-dark for the same
syntactic reason: the target class is a runtime value, not an AST constant.
Tracking: `tea-rags-mcp-ec0p` (taxonomy), `tea-rags-mcp-jw9n` (speculative
type-aware resolution epic).

### 4.1 String → class resolution (`constantize` / `const_get` / `const_missing`)

**Why unresolvable.** `"User".constantize`, `Object.const_get(name)`,
`safe_constantize`, and a `const_missing` remap engine all turn a **string**
into a class object at runtime. The string may be built from a DB column, a
config value, or interpolation — no constant node exists for the AST to follow.

**Impact.** An entire app-wide const-remap engine can be graph-dark. In the
probe, a central `Object.const_missing` /
`Modularization.resolve_for_const_missing` module showed `fanOut ≈ 1` despite
remapping hundreds of constants across the codebase. Per-call `constantize!`
helpers are likewise edge-less.

**Status.** Not statically recoverable. Needs a separate heuristic or type-aware
pass — `tea-rags-mcp-ec0p` case (b), `tea-rags-mcp-jw9n`.

### 4.2 STI / polymorphic dispatch by type column

**Why unresolvable.** `type.constantize` and ActiveRecord's `sti_class_for`
compute the concrete subclass from a row's `type` column **at runtime**. The AST
sees only the base class and a string read.

**Why not recoverable today even in principle.** Recovering the target would
require a **reverse-inheritance / class-hierarchy** index — given a base class,
enumerate its subclasses. That structure does **not** currently exist: the
walker folds only **forward** `classAncestors` (a class → its parents) into file
edges. There is no `parent → children` map to drive STI target inference.

**Impact.** STI base-class dispatch points have no edge to any concrete
subclass; polymorphic `type`-driven routing is invisible.

**Status.** Blocked on a reverse-inheritance structure that does not exist —
`tea-rags-mcp-jw9n` / `tea-rags-mcp-ec0p`.

### 4.3 Registry constant-literal dispatch — **partially recovered**

**Recovered (`tea-rags-mcp-ki9v`, CLOSED).** A constant-assigned collection
literal with **bare constant values** — `CONST = { key => SomeClass }.freeze` or
`CONST = [Klass, ...]` — now emits a synthetic reference edge per value class.
`collectRegistryConstantValueRefs` in `walker.ts` walks the literal and pins
each `constant` / `scope_resolution` value to its declaring file via the
existing `constant` resolver (file-only edge). The registry chunk gains real
chunk `fanOut` to its N target classes.

**Still unresolvable: lambda-wrapped values.** When the registry value is
wrapped in a `lambda` / `proc` / `block` / `do`-block —
`CONST = { key => -> { SomeClass } }` — descent **stops** at the lambda node
(see the `lambda` / `block` / `do_block` / `method` guard in
`collectRegistryConstantValueRefs`). Those constants resolve at call time, a
type-aware concern, so no edge is emitted.

**Impact.** Bare-constant registries are now well-connected; lambda-wrapped
registries remain graph-dark.

**Status.** Bare-constant: DONE (`tea-rags-mcp-ki9v`). Lambda-wrapped: out of
scope, `tea-rags-mcp-jw9n`.

---

## 5. Summary table

| #   | Idiom                                         | Recovered?                     | Tracking            |
| --- | --------------------------------------------- | ------------------------------ | ------------------- |
| 3.1 | `method_missing` / `respond_to_missing?`      | No (permanent)                 | —                   |
| 3.2 | `send` / `public_send` — dynamic arg          | Literal only                   | —                   |
| 3.3 | `define_method` — dynamic name                | Literal only                   | —                   |
| 3.4 | `refine` + `using` (refinements)              | No (permanent)                 | —                   |
| 3.5 | `prepend` — dynamic/conditional               | Literal mixin only             | `tea-rags-mcp-3jvn` |
| 4.1 | `constantize` / `const_get` / `const_missing` | No                             | `ec0p`, `jw9n`      |
| 4.2 | STI / polymorphic `type.constantize`          | No (needs reverse-inheritance) | `jw9n`, `ec0p`      |
| 4.3 | Registry constant-literal dispatch            | Bare-constant yes, lambda no   | `ki9v`, `jw9n`      |

---

## 6. How to read low fan-out on these patterns

When `find_symbol` / `get_callees` reports near-zero `fanOut` on a chunk that
_looks_ like a dispatch hub (a registry hash, a factory, a `const_missing`
engine, an STI base class), assume a **recall gap from runtime dispatch**, not
decoupling. Cross-check the chunk source for the idioms above before concluding
the code is isolated.
