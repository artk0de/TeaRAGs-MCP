---
title: "Code-Graph Edge Resolution"
sidebar_position: 9
---

# Code-Graph Edge Resolution

How to take a parsed source tree and turn it into a **dependency graph** —
who imports whom, and who calls whom — for an arbitrary programming language,
starting from zero. This page is a methodology, not a feature description: it
catalogues the extraction and resolution techniques, the order to build them
in, and where each one stops working.

---

## Two graphs, two questions

A code graph is really two overlaid graphs at different granularities, and they
answer different questions:

- **File graph** (`file → file`): _which files depend on which?_ Edges are
  **imports** — one file references a symbol defined in another. Fan-in here is
  "how many files import me" (a popularity / blast-radius signal); fan-out is
  "how many files I pull in" (a coupling signal).
- **Symbol graph** (`symbol → symbol`): _which functions call which?_ Edges are
  **call sites** resolved to a target definition. Fan-out is the number of
  distinct outgoing calls from a method; fan-in is its callers.

The two are independent: a file can be a heavily-imported hub while its
individual methods make few calls, and vice-versa. Build and measure them
separately.

Everything below is about manufacturing **edges** for these two graphs from
syntax alone — and about being honest where syntax runs out.

---

## Phase 1 — Extraction (the walker)

Extraction walks the AST once and emits raw facts. It resolves nothing; it only
records what is syntactically present. Four kinds of fact matter.

### Definitions — the symbol table

For every file, emit the list of symbols it **defines**, fully qualified
(`Module::Class`, `package.Type`, `a/b#Method`). This is the reverse index the
resolver later searches: "the name `Foo` is defined in `path/foo`." Without an
authoritative symbol table, no reference can be pinned to a file.

Keep declaration and reference strictly separate. A class header, a type
parameter, an assignment target — these **declare**; they belong in the symbol
table, not in the edge stream. The same token in argument or receiver position
is a **reference** and does produce an edge. Confusing the two is the single
most common source of phantom self-edges.

### References — the import channel

File edges come from references. Languages fall into two regimes, and a serious
extractor handles both:

- **Explicit imports** — `import`, `require`, `use`, `#include`. The import
  statement names the dependency directly; resolution is a path or basename
  match.
- **Convention-based autoload** — many ecosystems (Rails-style Ruby, some
  Python, implicit-namespace systems) have **no import at the use site**. A bare
  reference to `User` depends on `User` being defined in a file whose path is
  derivable from the name by a naming rule. Here the _reference itself_ is the
  import, and resolution is name-to-path inference.

A subtle but high-value case: a constant/type name used **as a value** — inside
a collection literal, a registry table, a default argument — is still a real
dependency, even though it is never "called". Registries that map keys to
handler classes are pure coupling that a naive walker misses because the values
are not call nodes. Emit a reference for every such name; let resolution decide
if it points anywhere.

### Call sites — the symbol channel

For each call, emit `(receiver, member, enclosing-scope, source-text)`. The
receiver may be absent (a bare/same-scope call), a variable, a constant, or a
chain. The enclosing scope is what later attributes the edge to the right
method. Attribute each call to the **innermost** containing symbol only —
otherwise a call nested four scopes deep inflates the fan-out of all four.

### Synthesized edges — DSL and sugar

Real code generates methods and calls that have no literal `def`/`call` node:

- **Macro / DSL expansions** — delegation helpers, attribute accessors, aliases.
  The walker recognises the macro and synthesises the method symbol _and_ the
  edge it implies (an alias redirects to its target; a delegation forwards to
  the delegate's method).
- **Literal dynamic dispatch** — `obj.send(:save)`, `apply("save")`,
  reflective invocation **with a literal name argument** is semantically a
  direct call. Unwrap it to `receiver.save` and emit a normal edge. (A
  _computed_ name cannot be unwrapped — see "What stays unresolved".)
- **Block / function-reference shorthand** — `&:method`, method references,
  point-free callbacks desugar to a call with no static receiver.

Synthesised edges are where a walker earns its keep on framework-heavy code:
the difference between a graph that sees the framework and one that sees only
hand-written `def`s.

### Inheritance and mixins

Record each type's ancestors — superclass, mixed-in modules, interfaces
implemented. Extraction only **captures** these as a per-type list; the
resolver uses them later to walk method-lookup chains. Capturing them forward
(type → its ancestors) is cheap; the reverse direction (a base → its subtypes)
is a separate structure discussed below.

---

## Phase 2 — Resolution (the resolver)

Resolution takes raw call sites and pins each to a target. The robust shape is
an **ordered chain of single-purpose strategies** with a three-state outcome
per strategy:

- **resolved** — produce an edge, stop.
- **drop** — this call provably has no static target (e.g. `super` with no
  resolvable ancestor); stop **without** an edge.
- **continue** — not my case, fall through to the next strategy.

The explicit `drop` state is load-bearing. A guard that drops a genuinely
unresolvable call prevents a later, looser strategy from **fabricating a wrong
edge**. In graph terms a wrong edge is worse than a missing one: it corrupts
centrality and blast-radius for everything downstream. Precision beats recall
when the two conflict.

Typical strategies, in precedence order:

1. **Inherited-call / `super`** — resolve via the captured ancestor chain;
   drop if no ancestor defines the member.
2. **Locally-typed receiver** — the receiver is a variable whose type is known
   (see type inference below); look the member up on that type.
3. **Constant / type receiver** — `Klass.method`; resolve the constant to its
   file, then the member within it (walking ancestors if the class inherits
   the method).
4. **Explicit-import receiver** — the receiver names an imported module.
5. **Guard drops** — known-unresolvable receiver shapes (relation chains,
   unknown-type receiver sets) drop rather than fall through.
6. **Bare-name fallback** — last resort: a same-scope or global short-name
   lookup.

Two refinements pay off everywhere:

- **File-only edges.** When the receiver resolves to a _file_ but the exact
  member can't be pinned, still emit an edge to the file with a null symbol
  target. It feeds the file graph and counts toward coupling even without a
  precise symbol. Autoload regimes lean on this heavily.
- **Edge confidence.** Tag each edge as **exact** (a single resolved target) or
  **candidate-set** (one of several possible targets — see CHA). Carry the
  confidence so ranking can discount speculative edges instead of treating a
  10-way fan-out as equal to a direct call.

---

## The precision ladder for dynamic dispatch

After the basics, what remains unresolved is **dynamic dispatch** — a call
whose target depends on a runtime type or value. There are two independent axes
of attack. Build the structural one first; it is cheaper and fixes the most
important nodes.

### Axis A — Structural (no type inference)

This axis needs only the inheritance graph, made into a first-class,
**bidirectional** structure: forward (type → ancestors) for method lookup, and
**reverse (base → subtypes)** for polymorphic fan-out. The reverse index is the
piece most extractors lack, because they fold ancestors into file edges and
never make subtypes queryable.

- **Method resolution order.** Resolve `recv.m` by walking `recv`'s type up its
  linearised ancestor chain until a type defines `m`. Handles inherited and
  mixed-in methods.
- **Class Hierarchy Analysis (CHA).** When the receiver's _base_ type is known
  but the concrete type is not (a base-class variable, an interface, a
  subtype-keyed dispatch), expand the call to the **cone of all subtypes** that
  override `m`. One known base → fan-out to every concrete implementation. This
  is how you recover polymorphic and subtype-table dispatch without any type
  inference at all.
- **Rapid Type Analysis (RTA).** CHA over-approximates: it includes subtypes
  that are never instantiated. Collect every construction site in the program,
  then prune CHA cones to **instantiated** types only. This is a precision
  pass, not a recall pass — it sharpens fan-out and centrality, it does not
  resolve new calls.

Structural resolution has a peculiar economics: by **call-site count** it
covers a small slice (most code is not polymorphic dispatch), but the sites it
covers are the **highest-centrality hubs** — dispatchers, factories,
type-keyed routers — which are otherwise graph-dark. High value per node, low
value per percentage point.

### Axis B — Type inference

This axis supplies the receiver type that Axis A needs when it isn't
syntactic. Build it as a ladder of rising cost and falling return:

1. **Local type environment.** Bind variables to types from obvious
   assignments: `x = Foo.new` ⇒ `x : Foo`; field/instance-variable assignments;
   constructor calls. Per-scope, flow-sensitive-lite. This single rung resolves
   the bulk of mundane "method on a locally-typed receiver" calls and is the
   biggest recall lever of the whole ladder.
2. **Declared-type ingestion.** Parse the language's _existing_ type
   annotations as ground truth — signature files, gradual-typing sigs,
   structured doc-comment tags. Free, authoritative types where the author
   already wrote them; avoids inferring what is already declared.
3. **Interprocedural return-type inference.** A call's result type is the
   callee's return type, which depends on the callee's body — a recursive
   problem. Solve it as a worklist fixpoint over the call graph with bounded
   widening. Unblocks chained receivers (`a.b.c`) and values that flow through
   helper methods. This is the expensive rung.
4. **Container / element types (Variable Type Analysis).** Track element types
   of collections so iteration callbacks resolve (`list.map { x ⇒ x.m }`).
   Hardest without declared generics; usually worth it only with sig files or
   an external checker.

### Axis C — External type checker

For codebases that ship a real type system, delegate inference to the
language's own checker / language server and read its resolved types. Sound and
precise — but heavy (program-wide analysis, incremental reuse needed). The
syntactic ladder (A + B) remains the fallback for the large body of untyped
code where no checker applies.

---

## What stays unresolved

Some dispatch is undecidable from source and no layer recovers it. Recognise
it, document it, and stop chasing it:

- **Reflection by computed name** — `const_get(string)`, `getattr(obj, name)`,
  resolving a class from a runtime-built string. The target literally does not
  exist until runtime.
- **Missing-method / proxy hooks** — `method_missing`, `__getattr__`,
  `Proxy` traps. The "method" has no definition to point at.
- **Dynamic definition** — methods created from runtime data
  (`define_method(computed)`, `eval`).
- **Open-class / monkey-patch by computed target**, scoped refinements, and
  similar late-binding tricks.

These are a small fraction of call sites in practice, but they cluster in
framework internals and meta-programming layers — exactly the high-traffic
files. Mark such a near-zero fan-out as a **recall gap from runtime dispatch**,
not as genuine decoupling, so readers of the graph interpret the silence
correctly.

---

## Sequencing — what to build, in what order, and why

The phases have a natural dependency and value order. Do not build them in the
order they appear in a paper; build them in the order that moves the metric.

1. **Measure first.** Instrument the resolver to count, per call site, _why_ it
   resolved or didn't (same-scope, constant, locally-typed, unknown-receiver
   drop, dynamic). A single number — the share of call sites resolved — plus
   this breakdown tells you where the misses actually are. Without it you will
   over-invest in a rung that the codebase barely uses.
2. **Basics before everything.** Explicit imports, same-scope calls, constant
   resolution, the declaration/reference split. These cover the large mundane
   majority of edges and are cheap. Most of the gap from a cold start to a
   usable graph closes here.
3. **Structural axis before type inference.** The inheritance graph + CHA +
   RTA need no type machinery and fix the architecturally important hubs.
   High value per node; ship before the inference ladder.
4. **Type-inference ladder, cheapest rung first.** Local type environment, then
   declared-type ingestion, then interprocedural return types, then containers.
   Each rung feeds the next and costs more for less; stop when the
   resolution-rate curve flattens.
5. **External checker last** — an opt-in precision tier for typed codebases,
   never a prerequisite for the rest.

Validate every rung against a small fixture project that exercises the target
idiom, and re-measure the resolution rate.

---

## A worked example — Ruby / Rails

The frequency reality matters more than the technique catalogue: in production
code the overwhelming majority of call sites are ordinary, and the "heavy"
dynamic structures are a minority **by count** even though they dominate the
hard cases. The distribution below is a calibrated estimate for a typical Rails
monolith (shares are approximate, ±, and should be replaced with real numbers
from the "measure first" step):

```text
Construct (by share of call sites)                technique that covers it
--------------------------------------------------------------------------------
same-class / self / bare local      ~35-45%  ████████  basics: lexical scope
attr / association receiver  a.b.m  ~15-20%  ████      B1 local type env
constant receiver  Klass.method     ~10-15%  ███       basics: constant resolution
block-internal  list.map { x.m }     ~8-15%  ███       B4 container / VTA
super / inherited                     ~3-5%  █         A  method-resolution order
subtype-keyed / polymorphic dispatch  ~2-6%  █         A  CHA (+ RTA pruning)
delegation-generated methods          ~1-3%  ▌         macro synthesis + B1
reflection / missing-method / eval    ~2-5%  █         never (runtime-only)
```

Reading it: the recall headline is moved almost entirely by **basics + the
first rung of type inference** (the top three rows ≈ two-thirds of all call
sites). The **structural axis** (`super`, polymorphic dispatch) is a thin slice
by count — but those rows are the dispatch hubs whose graph centrality is far
above average, so they are worth doing early for graph _quality_ even though
they barely move the percentage. The bottom row is unrecoverable at any layer
and belongs in the limitations note, not the backlog.

The lesson generalises: **optimise the recall metric through basics + local
types; optimise graph quality on important nodes through the structural axis.**
They are different goals, and conflating them tempts you into building the
expensive inference rungs too early.

---

## Generating this chart for another language

The Ruby breakdown above is one instance of a repeatable exercise. To produce
the same construct-frequency-vs-technique chart for any language, run the
prompt below (paste it into an agent with read access to a representative
codebase in that language, or answer it from language expertise and then verify
against a real sample):

```text
You are mapping how a static code-graph resolver covers a given language.

Target language: <LANGUAGE>   (framework, if any: <FRAMEWORK>)

Produce a construct-frequency-vs-technique chart for METHOD CALL SITES.

1. Enumerate the distinct call-site SHAPES in this language by how their target
   is determined, e.g.:
     - same-scope / self / local function call
     - call on a locally-typed variable (assigned from a constructor/literal)
     - call on a field / attribute / association
     - call on an explicitly-imported or constant/type receiver
     - call inside a collection-iteration callback (element type needed)
     - inherited / super / interface-default call
     - polymorphic / subtype dispatch (base or interface receiver)
     - framework-generated method (macro / decorator / codegen)
     - reflection by computed name / missing-method hook / eval
   Add or remove shapes to fit THIS language's idioms.

2. For each shape, estimate its SHARE of all call sites in idiomatic production
   code (rough %, must sum to ~100). State that these are estimates and that
   real numbers come from instrumenting a resolver on a real codebase.

3. For each shape, name the RESOLUTION TECHNIQUE that covers it, from this set:
     - basics: lexical scope / explicit imports / constant resolution
     - B1 local type environment (assignment/field/constructor binding)
     - B2 declared-type ingestion (signature files / typed annotations)
     - B3 interprocedural return-type inference
     - B4 container / element types (variable type analysis)
     - A  inheritance graph: method-resolution order
     - A  class-hierarchy analysis (CHA) [+ RTA pruning]
     - macro / codegen synthesis at extraction time
     - never (runtime-only; document as a limitation)

4. Render an ASCII bar chart: one row per shape, sorted by share descending,
   columns = [construct] [~share %] [bar of block chars scaled to share]
   [technique]. Keep bars to a fixed width so rows align.

5. Below the chart, write 3-4 sentences: which techniques move the recall
   metric most (usually basics + B1), which cover few call sites but
   high-centrality hubs (usually the structural axis A), and which rows are
   unrecoverable. Flag any language-specific surprise (e.g. heavy macro use,
   gradual typing already present, pervasive reflection).

Constraints: estimate by call-site SHARE, not by number of distinct shapes.
Do not overstate the structural axis on raw recall. Be explicit that the
percentages are calibrated guesses pending measurement.
```

The output is directly actionable: it tells you, for that language, which rung
of the ladder to build first (the technique against the largest shares) and
which to defer or skip.
