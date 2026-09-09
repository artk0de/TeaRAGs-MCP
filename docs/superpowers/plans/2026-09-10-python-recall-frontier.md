# Python Recall Frontier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two receiver kinds the final E0 measurement leaves on the
floor — `chain` at 0.004–0.008 and `localVar` at 0.21–0.40 — plus the one
bare-call family that a strict-ambiguity CONTINUE throws away. Row-level
attribution of every `missed` row on five corpora (below) says the hole is not
one mechanism but six, and that three of them carry 88 % of it: a `self.<attr>`
whose field type was assigned by an ANCESTOR's `__init__` (polar 1,528 rows), a
local bound to the RESULT of a call the project already types (polar 470, netbox
130), and a bare call to a `def` in the caller's own file that loses to
cross-file short-name ambiguity (polar 416, netbox 24, ugnest 12, httpx 7, flask
5). Naming-convention receiver typing and iteration variables are the long tail.
Unannotated return inference — the mechanism this seam was named for — is real
but small once measured, and it ships as the kernel relocation that the other
tasks build on. This is E2 seam 5.

**Architecture:** One kernel relocation, one new walker channel, four resolver
changes, and a facet-pass source. The kernel gains a return-inference engine
(`kernel/return-inference.ts`) with the terminal-expression fold and the
single-nominal-collapse rule; Ruby's `body-last-expr` type source keeps every
export it has and becomes a thin adapter over it; Python supplies a
return-statement collector and an expression→`TypeRef` mapper and joins the
facet pass as the third source `ast`, already reserved in
`PYTHON_TYPE_SOURCE_ORDER`. The walker gains ONE channel, `localCallBindings`,
naming the callee expression a local was assigned from — the resolver folds that
callee at resolve time, which is the only layer where a CROSS-FILE return type
is knowable. `memberTypeOf` learns to walk the C3 MRO seam 4 built when a class
field misses on the receiver's own class. Two new strategies join the chain:
`moduleReceiver` (a module path or module alias as receiver) and
`namingConvention` (subtype-gated, relocated from Ruby). `globalShortName` grows
a same-file arm ahead of its ambiguity guard.

**Tech Stack:** TypeScript (NodeNext, `strict`), vitest, tsx for the corpus
harnesses. New code in `src/core/domains/language/kernel/`,
`src/core/domains/language/python/walker/passes/`,
`src/core/domains/language/python/resolver/` and its `strategies/`.

**Spec:**
`docs/superpowers/specs/2026-09-03-python-codegraph-unification-program-design.md`
— "Relocation protocol", "Decision records", the E2 row for receiver typing.
Measurement baseline:
`docs/superpowers/specs/2026-09-03-python-codegraph-e0-measurement-design.md` →
"Final measurement record". Sibling seams:
`docs/superpowers/plans/2026-09-09-python-inheritance-resolution.md` (seam 4 —
`classAncestors`, the C3 linearizer, `resolvePythonInheritedMember`, and the
plan format this one reuses),
`docs/superpowers/plans/2026-09-09-receiver-type-propagation-kernel.md` (seam 3
— the chain fold and `ReceiverTypePorts` every task here extends),
`docs/superpowers/plans/2026-09-08-python-import-file-mapper.md` (the `project`
/ `external` / `unknown` verdict the boundary rules rest on).

---

## Decision record

### E2 seam 5 — the Python recall frontier (`9fgdi`)

**1. The attribution, measured before anything was designed.** Fresh row dumps
from integration HEAD `45d0830eb`, seeded jedi oracle, final chain, five corpora
(`ORACLE_MODULE=scripts/py-codegraph-jedi-oracle.ts` + `dump-rows.mts`; row
files under `/Users/artk0re/.claude/jobs/dffe3647/tmp/recall/`). Every
`verdict=="missed"` row was bucketed by the mechanism that WOULD have typed its
receiver, by opening the caller in `tea-rags-bench/corpora/<corpus>/<relPath>`
and reading the binding site. Counts are ROWS (a site in two overlapping chunks
is emitted twice), which is what every rate the oracle prints is computed over.

| corpus × kind (missed) | R1b call-return local | R2 naming conv. | R3 iteration var | R4a inherited field | R4a own field | R4b/c module recv | R5 framework (E3) | R8 same-file def | R6/R7 other |
| ---------------------- | --------------------- | --------------- | ---------------- | ------------------- | ------------- | ----------------- | ----------------- | ---------------- | ----------- |
| netbox `chain` 247     | —                     | 5               | —                | —                   | 1             | **99**            | **141**           | —                | 1           |
| netbox `localVar` 175  | **130**               | —               | —                | —                   | —             | **45**            | —                 | —                | 0           |
| netbox `dynamic` 51    | 1                     | 5               | **18**           | —                   | —             | —                 | —                 | —                | 27          |
| netbox `bareCall` 24   | —                     | —               | —                | —                   | —             | —                 | —                 | **24**           | 0           |
| polar `chain` 1,596    | 24                    | 7               | 9                | **1,528**           | 19            | —                 | —                 | —                | 9           |
| polar `localVar` 503   | **470**               | 11              | 16               | —                   | —             | —                 | —                 | —                | 6           |
| polar `dynamic` 378    | 42                    | 21              | 28               | —                   | —             | 15                | —                 | —                | 272         |
| polar `bareCall` 420   | —                     | —               | —                | —                   | —             | —                 | —                 | **416**          | 4           |
| polar `index` 48       | —                     | 46              | —                | —                   | —             | —                 | —                 | —                | 2           |
| polar `super` 21       | —                     | —               | —                | —                   | —             | —                 | —                 | —                | 21          |
| polar `constant` 12    | —                     | —               | —                | —                   | —             | —                 | —                 | —                | 12          |
| polar `selfMember` 4   | —                     | —               | —                | —                   | —             | —                 | —                 | —                | 4           |
| ugnest `localVar` 13   | —                     | **11**          | —                | —                   | —             | —                 | —                 | —                | 2           |
| ugnest `bareCall` 12   | —                     | —               | —                | —                   | —             | —                 | —                 | **12**           | 0           |
| ugnest `dynamic` 5     | —                     | 2               | —                | —                   | —             | —                 | —                 | —                | 3           |
| ugnest `chain` 4       | —                     | —               | —                | **4**               | —             | —                 | —                 | —                | 0           |
| ugnest `constant` 3    | —                     | 2               | —                | —                   | —             | —                 | —                 | —                | 1           |
| flask `chain` 27       | 1                     | —               | —                | **11**              | —             | —                 | —                 | —                | 15          |
| flask `dynamic` 17     | 1                     | 2               | —                | —                   | —             | —                 | —                 | —                | 14          |
| flask `localVar` 7     | —                     | —               | —                | —                   | —             | —                 | —                 | —                | 7           |
| flask `bareCall` 5     | —                     | —               | —                | —                   | —             | —                 | —                 | **5**            | 0           |
| httpx `chain` 16       | 1                     | 1               | —                | 3                   | **10**        | —                 | —                 | —                | 1           |
| httpx `localVar` 16    | **15**                | —               | 1                | —                   | —             | —                 | —                 | —                | 0           |
| httpx `dynamic` 14     | 7                     | 4               | 3                | —                   | —             | —                 | —                 | —                | 0           |
| httpx `bareCall` 7     | —                     | —               | —                | —                   | —             | —                 | —                 | **7**            | 0           |

Reproduce with `/Users/artk0re/.claude/jobs/dffe3647/tmp/recall/classify.mts`
(`npx tsx classify.mts <corpus>`), which is the bucketing above in code.

**Denominators** (`match` / `match + missed`, same dumps), for reading the
projections in decision 9:

| corpus | bareCall    | chain    | localVar | dynamic     | constant    | super   | index | selfMember  |
| ------ | ----------- | -------- | -------- | ----------- | ----------- | ------- | ----- | ----------- |
| netbox | 5,024/5,048 | 1/248    | 47/222   | 1,462/1,513 | 26/26       | 221/221 | 0/1   | 1,032/1,032 |
| polar  | 7,552/7,972 | 14/1,610 | 373/876  | 1,413/1,791 | 1,297/1,309 | 528/549 | 0/48  | 2,063/2,067 |
| ugnest | 355/367     | 0/4      | 6/19     | 9/14        | 293/296     | —       | —     | 78/78       |
| flask  | 153/158     | 2/29     | 17/24    | 4/21        | 1/1         | 4/4     | 0/1   | 121/122     |
| httpx  | 251/258     | 6/22     | 43/59    | 1/15        | —           | 8/8     | —     | 112/112     |

**2. R4a — an inherited class field is 95 % of polar's `chain` hole and the
single largest number in the table.** 1,528 of polar's 1,596 `chain` misses are
`self.client.build_request(...)` / `self.client.send_request(...)` inside the
generated Polar SDK. `self.client` is assigned in
`sdk/python/polar/base.py:179`,
`SyncServiceBase.__init__(self, client: SyncClientBase)`, and every calling
class is a SUBCLASS of that base living in another file. `classFieldTypes` is
keyed by the class SHORT name of the class that ASSIGNED the field, so
`classFieldTypes["CustomersService"]` has no `client` entry and
`pythonMemberTypeOf` returns `undefined` on hop 1. Seam 4 already built the walk
this needs — `classAncestors`, the C3 linearizer, `resolvePythonInheritedMember`
— and applied it to METHODS only. Applying the same MRO to FIELDS is Task 4, and
it is the highest-yield change in the plan. ugnest 4/4, flask 11/27 and httpx
3/16 are the same shape at small n.

**3. R1b — the local is never bound, though the return type already exists.**
polar 470 `localVar` + 42 `dynamic`, netbox 130, httpx 15. The dominant RHS is
`Cls.method(...)`: 338 of the polar rows, 319 of them
`repository = SubscriptionRepository.from_session(session)`, where
`RepositoryBase.from_session` is annotated `-> Self`
(`server/polar/kit/repository/base.py:165`) and the annotation facet ALREADY
publishes `structuredReturnTypes["RepositoryBase.from_session"]`. Nothing reads
it for this site, because nothing binds `repository`. The walker cannot: the
callee is cross-file, and a per-file pass has no return types for another file's
classes. So the binding must be LAZY — the walker records the callee EXPRESSION,
the resolver folds it. That is the new `localCallBindings` channel (Task 3), and
it is why R1b is a separate task from R1a.

**4. R1a — unannotated return inference is real but small, and it is the kernel
relocation.** Where R1b's callee is unannotated the fold needs a return fact
that does not exist: `update`, `get_benefit_strategy`, `next` on polar all
answer `annotated=false`. Ruby already infers those from a method body
(`ruby/walker/type-sources/body-last-expr.ts`), and its ENGINE — the scoped
descent, the terminal-expression selection, the single-assignment binding scan,
and the "one nominal arm or silence" collapse — is neutral. Its MAPPING is not:
`Const.new`, `.freeze`/`.tap` passthrough, `is_a?` coercion ternaries and the
Gemfile catalogue are all Ruby. So the engine relocates and the mapping stays
(Task 1), Python supplies a `return`-statement collector and a Python expression
mapper (Task 2). Python differs in one structural way that the kernel must
carry: Ruby reads ONE tail expression, Python has N `return` statements and the
collapse rule has to see all of them.

**5. R8 — a same-file `def` loses to cross-file ambiguity, and the fix is
free.** `bareCall` misses are ONE mechanism on every corpus: polar 416/420,
netbox 24/24, ugnest 12/12, httpx 7/7, flask 5/5, all with
`oracleTargetRelPath == relPath`. `validate_email(email)` at
`server/polar/kit/email.py:25` has `def validate_email` fourteen lines above it;
`globalShortName` calls `lookupByShortName("validate_email")`, gets N
project-wide definitions, and `pickSingleCandidate` in strict mode CONTINUEs to
nothing. Python's own name resolution prefers module scope over anything
cross-file, so a module-level `def`/`class` in the CALLER's file is not a guess
— it is the answer the interpreter would give. Restricting the arm to
module-level targets keeps that guarantee: 372 of polar's 416 and 18 of netbox's
24 name a top-level symbol; the remainder name `Cls#m` in the same file, where
the caller's enclosing class is the evidence and `globalShortName` already owns
it. Task 8 ships the module-level arm only.

**6. R4b/c — a module is not a value, and netbox spends 144 rows on it.**
`utilities.fields.ColorField(...)` (99 netbox `chain` rows) and
`layout.SimpleLayout(...)` (45 netbox `localVar`, 15 polar `dynamic`) both have
a MODULE in receiver position — dotted in the first case, aliased by
`from utilities.forms import rendering as layout` in the second. The chain fold
declines both by construction: `pythonSingleHopType` answers for `self`, a
constructor call and a local binding, and a module is none of those. The import
mapper already turns a module path into a file (seam:
`python-import-file-mapper`), so this is a lookup, not an inference — Task 5.

**7. R2 — naming convention, subtype-gated, relocated from Ruby.** 105 rows
across the five corpora, concentrated where nothing else can speak: ugnest
`localVar` 11/13, polar `index` 46/48 (`items[0].method()` — the element type is
unknowable, the NAME is not), polar `dynamic` 21. Ruby's implementation is
`RubyConventionReceiverSymbolResolutionStrategy` over `conventionReceiverType`
(`ruby/resolver/ruby-unbound-receiver-types.ts:110`), whose gates are (a) the
camelized class EXISTS, (b) it has NO declared subtypes, (c) the member PINS a
symbol. All three are neutral; the camelize spelling and the receiver regex are
per-language. Task 6 relocates the gate and adds a Python `namingConvention`
strategy AFTER `chainType`, BEFORE `importedName`. It ships only if the phantom
bar holds — see decision 10.

**8. R3 — iteration variables.** netbox `dynamic` 18, polar 53 across three
kinds, httpx 4. `for x in self.items:` with `items: list[Item]` types `x` as
`Item`, and the container→element mapping already exists
(`PYTHON_CONTAINER_FIRST` / `PYTHON_CONTAINER_LAST`,
`python-type-annotation.ts:63`). Task 7 adds a `local` fact at the loop line.
Comprehension variables are in scope only where `walkPythonScopes` can name the
enclosing def — a module-level comprehension has no `methodName` coordinate and
is skipped.

**9. R5 is E3 and R6/R7 are the floor.** netbox's 141 `chain` rows are Django
manager chains (`ObjectType.objects.with_feature(...)` →
`ObjectTypeManager#with_feature`): the `objects` attribute is synthesised by the
metaclass and no file declares it. That is the framework-vocabulary epic,
counted here and designed there. R6/R7 is 372 rows, of which polar's 272
`dynamic` is the bulk — `getattr`, union receivers, and receivers bound inside a
branch. Nothing in this plan targets them.

**10. Precision is the gate, and the plan is willing to drop a task.** ugnest
carries 0 phantoms today and it stays at 0. The bar per task is: gross `lost` (a
row that was `match` before and is not after) = 0, and phantom rows not up by
more than +0.5 pp of that corpus's edge count. R8, R4a, R4b/c and R1b are
answer-narrowing changes (they pin a symbol nothing was pinning, or they replace
a CONTINUE), so a phantom regression there means a bug. R2 is a GUESS, Ruby
measured its edge accuracy at 100 % only because gate 3 kills the wrong guesses
at the terminal, and Python has no `hierarchy` snapshot on the Python path — the
subtype gate reads `classAncestors` instead. If Task 6's A/B breaks the phantom
bar on any corpus, the strategy is REMOVED, not tuned: the plan says so up front
so the executor does not spend a day defending it.

**11. Where the ceiling actually is, per kind, after everything here lands.**
This is the statistical ceiling the program is aiming at, stated as what remains
STRUCTURALLY unreachable:

| Kind         | Left after R1–R4 + R8                         | Why it is a floor                                                                                                                         |
| ------------ | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `bareCall`   | polar 4, others 0                             | cross-file bare names with genuine project-wide ambiguity; only an import-aware module-scope model (E3) narrows them                      |
| `selfMember` | polar 4, flask 1                              | already 0.998–1.0; the residue is decorator-rewritten defs                                                                                |
| `constant`   | polar 12, ugnest 1                            | `Cls.member` where `Cls` is re-exported through a package `__init__` more than one hop deep                                               |
| `super`      | polar 21                                      | `super()` inside a class whose base is a generic `Protocol[…]` subscript — no nominal base to walk                                        |
| `chain`      | netbox 142, polar 40, flask 15, httpx 1       | netbox's is 141 Django-manager rows = E3 framework vocabularies; the rest is union / branch-bound receivers                               |
| `localVar`   | netbox 0, polar 6, ugnest 2, flask 7, httpx 0 | receivers assigned inside a conditional with two different types, and `x = some_external_call()`                                          |
| `dynamic`    | netbox 27, polar 272, httpx 0                 | `getattr(obj, name)()`, `**kwargs`-driven dispatch, and receivers whose type is decided by a runtime registry — statistically unreachable |
| `index`      | polar 2                                       | element types of heterogeneous containers                                                                                                 |

So the honest end state is: every kind except `chain` and `dynamic` sits at or
above 0.99 on every corpus, `chain` is capped by E3 on Django-shaped code and by
branch typing elsewhere, and `dynamic` on polar is a hard floor at ~0.85 that
only a flow-sensitive engine would move. Nothing in this plan claims otherwise.

---

## Global Constraints

- **Precision first.** Every new answer is single-nominal or silent. A mixed
  arm, a union, a container, a class the run does not declare, or a name in the
  builtin/stdlib vocabulary produces NOTHING. No task may convert an existing
  `agreeExternal` into a project edge.
- **Relocation protocol.** A body moving into `kernel/` moves byte-identically
  where it is neutral. If a line cannot move unchanged, the CUT moves — the
  neutral part goes, the rest stays behind a port. Ruby keeps every export it
  has today; `ruby/` files may change ONLY as byte-identical relocations plus
  the adapter that re-exports.
- **Ruby parity is a gate, not a hope.** Tasks touching `kernel/` run the full
  Ruby resolver and walker suites and compare row-for-row against the pre-task
  tree. Any diff fails the task.
- **Business-logic tests are immutable.** Existing tests are never rewritten.
  The only permitted edit is a pin that now has a different, better answer — and
  that edit carries a bead comment naming the row and the corpus.
- **Python tests likewise.** Moving a test file is fine; rewriting its
  assertions is not.
- **Perf budget, measured on netbox.** Wall ≤ +25 %, RSS ≤ +20 % against the
  pre-task tree. Return inference runs ONCE per `def` in pass 1; nothing in this
  plan may add per-call-site AST work.
- **Env flags.** No new env flags. `CODEGRAPH_PY_LOCAL_TYPE_TRACKING` already
  gates `param` / `local` facts and gates the new ones the same way.
- **Commits.** `refactor(language): … (9fgdi)` for relocations,
  `feat(language): … (9fgdi)` for new capability. Body wrapped at ≤ 100 columns.
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` trailer.
- **Execution.** A fresh Opus executor per task, each in its own worktree. Tool
  calls ≤ 8 min; writes ≤ 120 lines per call.

---

## File Structure

```text
src/core/domains/language/
├── kernel/
│   ├── return-inference.ts              NEW  T1  terminal-expression fold + collapse
│   ├── naming-convention.ts             NEW  T6  camelize + existence + subtype gate
│   ├── receiver-type-propagation.ts     EDIT T4  ReceiverTypePorts gains `fieldTypeOf`
│   └── type-facts.ts                    EDIT T3  TypeFact gains kind "callLocal"
├── ruby/
│   ├── walker/type-sources/body-last-expr.ts   EDIT T1  adapter over the kernel engine
│   └── resolver/ruby-unbound-receiver-types.ts EDIT T6  adapter over the kernel gate
└── python/
    ├── walker/
    │   ├── walker.ts                    EDIT T3  emit `localCallBindings`
    │   └── passes/
    │       ├── annotation-type-facts.ts        EDIT T2/T3/T7  register the ast source
    │       ├── python-ast-type-source.ts       NEW  T2  return-statement inference
    │       ├── python-return-expression.ts     NEW  T2  expression → TypeRef mapper
    │       ├── python-def-scope-walk.ts        EDIT T7  onForStatement visitor hook
    │       ├── python-annotation-type-source.ts EDIT T7 iteration-variable facts
    │       └── python-type-channels.ts         EDIT T3  publish localCallBindings
    └── resolver/
        ├── python-receiver-type-ports.ts       EDIT T4  MRO-walking field lookup
        ├── python-chain-factory.ts             EDIT T5/T6  two new strategies
        └── strategies/
            ├── python-local-binding.ts         EDIT T3  one-hop call binding
            ├── python-self-field.ts            EDIT T4  inherited field
            ├── python-module-receiver.ts       NEW  T5  module path / alias receiver
            ├── python-naming-convention.ts     NEW  T6  subtype-gated convention
            ├── python-global-short-name.ts     EDIT T8  same-file module-level arm
            └── shared.ts                       EDIT T4  pythonInheritedFieldType
```

Tests mirror the tree under `tests/unit/domains/language/{kernel,ruby,python}/`.

---

## Context the implementer needs

**The Python source order** (`python/walker/passes/annotation-type-facts.ts:32`)
already reserves the slot this plan fills:

```ts
export const PYTHON_TYPE_SOURCE_ORDER: readonly string[] = [
  PYTHON_ANNOTATION_SOURCE, // "annotations"
  PYTHON_DOCSTRING_SOURCE, // "docstring"
  "ast", // ← Task 2 makes this a real source
];
```

Lower index wins. `TypeFactStore.fromFacts` dedupes by
`coordinateKey = kind|scope|methodName|name|line`, so an `ast` return fact on a
def that also carries an annotation loses — which is the point.

**`structuredReturnTypes` keys are Python symbolIds.** `pythonTypeChannels`
rewrites the kernel's `Scope::Class#method` into `Scope.Class#method`
(`pythonStructuredReturnKey`), so the key a consumer reads is exactly what
`DefaultSymbolIdComposer` produced for the callee: `Cls#member` for an instance
method, `Cls.member` for a `@classmethod` / `@staticmethod`, and the bare name
for a top-level `def`. NEVER re-compose a key from parts.

**`classFieldTypes` is keyed by class SHORT name** and merged last-write-wins
across same-short-named classes (`python-type-channels.ts`, mirroring
`collectPythonClassFieldTypes`). This is why Task 4 walks class KEYS
(file-qualified) and reads `classFieldTypes[shortNameOf(ancestorKey)]`.

**The chain fold's ports** (`kernel/receiver-type-propagation.ts:25`) today:

```ts
export interface ReceiverTypePorts {
  singleHopType: (
    receiver: string,
    atLine: number,
    ctx: CallContext,
  ) => TypeRef | undefined;
  seedHead: (
    head: string,
    firstLink: string | undefined,
    ctx: CallContext,
  ) => { type: TypeRef; consumedMembers: 0 | 1 } | undefined;
  memberTypeOf: (
    recv: TypeRef,
    member: string,
    ctx: CallContext,
  ) => TypeRef | undefined;
  maxHops: () => number;
}
```

Python builds them per resolver in `createPythonReceiverTypePorts(mapper)`; the
factory closes over the `PythonImportFileMapper` so the memo is shared. Task 4
adds the ancestor linearizer to that closure the same way.

**Class keys and the MRO** (seam 4, `strategies/shared.ts`):

```ts
pythonClassKey(relPath, classFq)          // `${relPath}::${classFq}`
parsePythonClassKey(key)                  // → { relPath, classFq } | null
pythonBoundClassKey(bareName, relPath, ctx)  // exactly-one declaration in that file
resolvePythonInheritedMember(classKey, member, ctx, mode, linearizer, options?)
  // → { target: SymbolResolutionTarget | null; closure: AncestorClosure }
```

`AncestorClosure` is `"closed" | "external" | "unknown"`: a hierarchy read to
the end without the member is evidence of ABSENCE, one that left the project is
not. `PythonAncestorLinearizerCache#for(ctx)` returns `undefined` on a walker-v2
index that carries no `classAncestors` — every new consumer must keep its
pre-seam behaviour on that branch.

**The chain order** (`python-chain-factory.ts`) after this plan:

```text
1 super  2 selfField  3 selfMember  4 localBinding  5 chainType
6 moduleReceiver (T5)  7 namingConvention (T6)  8 importedName  9 globalShortName
```

`moduleReceiver` goes before `namingConvention` because a module alias is a FACT
and the convention is a guess; both go after `chainType` so every typed channel
wins first, and before `importedName` so a module receiver is never mistaken for
an imported value binding.

**Container element types** already exist (`python-type-annotation.ts`):
`PYTHON_CONTAINER_FIRST` (list/set/tuple/
Sequence/Iterable/Iterator/Generator/Collection/…) and `PYTHON_CONTAINER_LAST`
(dict/Mapping/Counter/… — the VALUE type). `pythonTypeRefFromNode` returns
`{ form: "container", element }` for those, and `pythonNominalReceiverName`
collapses a ref to one class name or `undefined`.

**The harnesses.** Row dumps:

```bash
ORACLE_MODULE=<worktree>/scripts/py-codegraph-jedi-oracle.ts \
DUMP_OUT=<out>/<corpus>.ndjson \
npx tsx /Users/artk0re/.claude/jobs/dffe3647/tmp/flask-lost/dump-rows.mts \
  --corpus <corpus> --quiet
```

netbox ≈ 3 min, polar ≈ 5 min (run those two in background), ugnest / flask /
httpx inline. A row carries `receiverKind`, `verdict`, `answeredBy`,
`chainTargetSymbolId`, `oracleTargetRelPath`, `oracleTargetSymbolId`. The A/B is
`diff-rows.mjs` in the same directory, run BEFORE-vs-AFTER on identical corpora;
`gross lost` is the count of rows whose verdict went `match` → not `match`.

---

## Task 1 — Relocate the return-inference engine into the kernel

**Files:** `src/core/domains/language/kernel/return-inference.ts` (new),
`src/core/domains/language/ruby/walker/type-sources/body-last-expr.ts` (edit),
`tests/unit/domains/language/kernel/return-inference.test.ts` (new).

**Interfaces:** `ReturnInferencePorts<TNode, TCtx>`,
`inferReturnTypeName<TNode, TCtx>(defNode, ctx, ports): string | null`.

The engine owns four neutral rules and nothing else: (a) every terminal
expression is mapped, (b) a bare BINDING arm indirects through its assignment
events and needs EXACTLY one plain event, (c) any arm that yields nothing kills
the whole inference, (d) two arms that disagree kill it too. What a terminal
expression IS, what an expression's type IS, and which node types bind a name
all stay with the language.

- [ ] Write the failing kernel test first —
      `tests/unit/domains/language/kernel/return-inference.test.ts`. Use a
      hand-built fake node type (`{ id: string; kind: string }`) and fake ports
      so the test names the RULES, not a grammar:

```ts
import { describe, expect, it } from "vitest";

import {
  inferReturnTypeName,
  type ReturnInferencePorts,
} from "../../../../../src/core/domains/language/kernel/return-inference.js";

interface FakeNode {
  readonly id: string;
  readonly kind: "expr" | "binding";
  readonly type?: string;
}
type Ctx = {
  terminals: FakeNode[];
  events: Record<string, (FakeNode | null)[]>;
};

const ports: ReturnInferencePorts<FakeNode, Ctx> = {
  terminalExpressions: (_def, ctx) => ctx.terminals,
  typeOfExpression: (node) => node.type ?? null,
  isBinding: (node) => node.kind === "binding",
  bindingName: (node) => node.id,
  assignmentEvents: (_def, name, ctx) => ctx.events[name] ?? [],
};
const def: FakeNode = { id: "def", kind: "expr" };

describe("inferReturnTypeName", () => {
  it("returns the single nominal type when every arm agrees", () => {
    const ctx: Ctx = {
      terminals: [
        { id: "a", kind: "expr", type: "Foo" },
        { id: "b", kind: "expr", type: "Foo" },
      ],
      events: {},
    };
    expect(inferReturnTypeName(def, ctx, ports)).toBe("Foo");
  });
  it("is silent when two arms disagree", () => {
    const ctx: Ctx = {
      terminals: [
        { id: "a", kind: "expr", type: "Foo" },
        { id: "b", kind: "expr", type: "Bar" },
      ],
      events: {},
    };
    expect(inferReturnTypeName(def, ctx, ports)).toBeNull();
  });
  it("is silent when any arm is untyped", () => {
    const ctx: Ctx = {
      terminals: [
        { id: "a", kind: "expr", type: "Foo" },
        { id: "b", kind: "expr" },
      ],
      events: {},
    };
    expect(inferReturnTypeName(def, ctx, ports)).toBeNull();
  });
  it("is silent on no terminal expressions at all", () => {
    expect(
      inferReturnTypeName(def, { terminals: [], events: {} }, ports),
    ).toBeNull();
  });
  it("indirects a binding arm through its one plain assignment", () => {
    const ctx: Ctx = {
      terminals: [{ id: "r", kind: "binding" }],
      events: { r: [{ id: "v", kind: "expr", type: "Foo" }] },
    };
    expect(inferReturnTypeName(def, ctx, ports)).toBe("Foo");
  });
  it("is silent when a binding is assigned twice", () => {
    const ctx: Ctx = {
      terminals: [{ id: "r", kind: "binding" }],
      events: {
        r: [
          { id: "v", kind: "expr", type: "Foo" },
          { id: "w", kind: "expr", type: "Foo" },
        ],
      },
    };
    expect(inferReturnTypeName(def, ctx, ports)).toBeNull();
  });
  it("is silent when the binding's single event is non-plain", () => {
    const ctx: Ctx = {
      terminals: [{ id: "r", kind: "binding" }],
      events: { r: [null] },
    };
    expect(inferReturnTypeName(def, ctx, ports)).toBeNull();
  });
  it("is silent when a binding has no assignment in the body", () => {
    const ctx: Ctx = { terminals: [{ id: "r", kind: "binding" }], events: {} };
    expect(inferReturnTypeName(def, ctx, ports)).toBeNull();
  });
  it("does not recurse a binding whose assignment is another binding", () => {
    const ctx: Ctx = {
      terminals: [{ id: "r", kind: "binding" }],
      events: {
        r: [{ id: "s", kind: "binding" }],
        s: [{ id: "v", kind: "expr", type: "Foo" }],
      },
    };
    expect(inferReturnTypeName(def, ctx, ports)).toBeNull();
  });
});
```

- [ ] Run it, see nine failures (module does not exist).

- [ ] Create `src/core/domains/language/kernel/return-inference.ts`:

```ts
/**
 * The language-neutral half of return-type inference (E2 seam 5, bd
 * tea-rags-mcp-9fgdi) — relocated from
 * `ruby/walker/type-sources/body-last-expr.ts`, whose Ruby-specific mapping
 * (`Const.new`, `.freeze`/`.tap` passthrough, `is_a?` coercion ternaries, the
 * Gemfile catalogue) stayed behind as ports.
 *
 * Four rules, and they are the whole precision story:
 *
 *  1. EVERY terminal expression is mapped. Ruby hands one (the body's last
 *     expression); Python hands N (one per `return` statement). A def with no
 *     terminal expression at all infers nothing.
 *  2. A terminal that is a BARE BINDING (a local, a Ruby `@ivar`) indirects
 *     through its assignment events inside the same body and needs EXACTLY one
 *     PLAIN event — zero means the value came from somewhere the body cannot
 *     see, more than one means it was reassigned, and a `null` event is the
 *     language reporting an operator- or multiple-assignment it will not vouch
 *     for. Indirection is ONE hop: a binding assigned from another binding is
 *     silence, not a second lookup.
 *  3. An arm that maps to nothing kills the whole inference. A def that returns
 *     `Foo` on one branch and an opaque call on another has no single type,
 *     and guessing `Foo` would poison every downstream chain hop.
 *  4. Two arms naming different types kill it too. This is the union rule
 *     stated where it is cheapest: the engine never widens.
 */
export interface ReturnInferencePorts<TNode, TCtx> {
  /** The expressions whose value the def yields. Empty ⇒ no inference. */
  terminalExpressions: (defNode: TNode, ctx: TCtx) => readonly TNode[];
  /** The nominal type name an expression evaluates to, or `null` when not statically known. */
  typeOfExpression: (node: TNode, ctx: TCtx) => string | null;
  /** Is this node a bare name binding whose assignment should be consulted? */
  isBinding: (node: TNode) => boolean;
  /** The name a binding node carries. */
  bindingName: (node: TNode) => string;
  /**
   * One entry per assignment EVENT to `name` inside `defNode`, in source order.
   * A plain `name = EXPR` carries its RHS; every event the language will not
   * vouch for (operator assignment, multiple-assignment target, augmented
   * target) carries `null`.
   */
  assignmentEvents: (
    defNode: TNode,
    name: string,
    ctx: TCtx,
  ) => readonly (TNode | null)[];
}

/**
 * The single nominal type a def returns, or `null` (silence). See the rules on
 * {@link ReturnInferencePorts}.
 */
export function inferReturnTypeName<TNode, TCtx>(
  defNode: TNode,
  ctx: TCtx,
  ports: ReturnInferencePorts<TNode, TCtx>,
): string | null {
  const terminals = ports.terminalExpressions(defNode, ctx);
  if (terminals.length === 0) return null;
  let agreed: string | null = null;
  for (const terminal of terminals) {
    const name = armTypeName(defNode, terminal, ctx, ports);
    if (name === null) return null;
    if (agreed === null) agreed = name;
    else if (agreed !== name) return null;
  }
  return agreed;
}

/** One terminal arm's type: direct, or one hop through a single plain assignment. */
function armTypeName<TNode, TCtx>(
  defNode: TNode,
  terminal: TNode,
  ctx: TCtx,
  ports: ReturnInferencePorts<TNode, TCtx>,
): string | null {
  if (!ports.isBinding(terminal)) return ports.typeOfExpression(terminal, ctx);
  const events = ports.assignmentEvents(
    defNode,
    ports.bindingName(terminal),
    ctx,
  );
  if (events.length !== 1) return null;
  const rhs = events[0];
  if (rhs === null || ports.isBinding(rhs)) return null;
  return ports.typeOfExpression(rhs, ctx);
}
```

- [ ] Run the kernel test — nine green.
- [ ] Rewrite `body-last-expr.ts` as an adapter. Delete `singleAssignmentConst`
      wholesale and replace `emitServiceReturnFact`'s body with the call below;
      keep `lastBodyExpression`, `tailInstanceConst`, `coercionTernaryConst`,
      `constNameOf`, `isBindingNode`, `collectServiceReturnFacts`,
      `SERVICE_ENTRY_METHODS`, `RECEIVER_PASSTHROUGH_TAIL_METHODS`,
      `TYPE_GUARD_PREDICATES` and `CONST_NAME` byte-identical, and keep the
      whole module docstring — appending one paragraph naming the relocation.

```ts
// body-last-expr.ts — the Ruby half of the ports, and the only new code here.
import {
  inferReturnTypeName,
  type ReturnInferencePorts,
} from "../../../kernel/return-inference.js";

/** Ruby's answers for the kernel's return-inference engine. Built per file (it closes over the catalogue). */
function rubyReturnInferencePorts(
  catalogue: RubyDslCatalogue,
): ReturnInferencePorts<AstNode, null> {
  return {
    // Ruby's terminal is the body's LAST expression — exactly one, or none.
    terminalExpressions: (defNode) => {
      const body = defNode.childForFieldName("body");
      if (!body) return [];
      const last = lastBodyExpression(body);
      return last === null ? [] : [last];
    },
    typeOfExpression: (node) => tailInstanceConst(node, catalogue),
    isBinding: (node) => isBindingNode(node),
    bindingName: (node) => node.text,
    assignmentEvents: (defNode, name) => {
      const body = defNode.childForFieldName("body");
      return body === null ? [] : rubyAssignmentEvents(body, name);
    },
  };
}

/**
 * One entry per assignment event to `bindingName` in this body — the SCAN that
 * used to live inside `singleAssignmentConst`, byte-identical minus its
 * cardinality check (now rule 2 in `kernel/return-inference.ts`).
 *
 * Nested def/class/module start a new scope; blocks do NOT — blocks share the
 * method's local scope, and ivars are not block-scoped at all, so a
 * reassignment inside one is a reassignment.
 */
function rubyAssignmentEvents(
  body: AstNode,
  bindingName: string,
): (AstNode | null)[] {
  const events: (AstNode | null)[] = [];
  const scan = (n: AstNode): void => {
    if (
      n.type === "method" ||
      n.type === "singleton_method" ||
      n.type === "class" ||
      n.type === "module"
    )
      return;
    if (n.type === "assignment") {
      const lhs = n.childForFieldName("left");
      if (isBindingNode(lhs) && lhs?.text === bindingName) {
        events.push(n.childForFieldName("right"));
      } else if (
        lhs?.type === "left_assignment_list" &&
        lhs.namedChildren.some((t) => t.text === bindingName)
      ) {
        events.push(null); // multiple-assignment target — not a clean single-assign
      }
    } else if (n.type === "operator_assignment") {
      const lhs = n.childForFieldName("left");
      if (isBindingNode(lhs) && lhs?.text === bindingName) events.push(null); // `+=` / `||=`
    }
    for (const child of n.children) scan(child);
  };
  for (const child of body.children) scan(child);
  return events;
}

/** Emit the return fact for one service-entry def, if its body last expression is a conservative shape. */
function emitServiceReturnFact(
  defNode: AstNode,
  scope: readonly string[],
  catalogue: RubyDslCatalogue,
  out: RubyTypeFact[],
): void {
  const nameNode = defNode.childForFieldName("name");
  if (!nameNode || !SERVICE_ENTRY_METHODS.has(nameNode.text)) return;
  const constName = inferReturnTypeName(
    defNode,
    null,
    rubyReturnInferencePorts(catalogue),
  );
  if (constName === null) return;
  out.push({
    kind: "return",
    source: "body-last-expr",
    symbolScope: [...scope],
    methodName: nameNode.text,
    type: { form: "instance", name: constName },
  });
}
```

- [ ] **Ruby parity gate.** Run the Ruby walker and resolver suites:
      `npx vitest run tests/unit/domains/language/ruby`. Every existing
      `body-last-expr` test must pass UNEDITED — the ivar case, the
      coercion-ternary case, the reassignment silence case, the `.freeze`/`.tap`
      tails. Zero diffs.
- [ ] Run the Ruby offline recall harness against `mastodon` and confirm the
      resolve rate is bit-identical to the pre-task tree. A single row of drift
      fails the task: this is a relocation.
- [ ] `npx tsc --noEmit` clean; `npm run test:coverage` exit 0.
- [ ] Commit:
      `refactor(language): relocate return inference into the kernel (9fgdi)`.

---

## Task 2 — Python's `ast` return source

**Files:**
`src/core/domains/language/python/walker/passes/python-return-expression.ts`
(new),
`src/core/domains/language/python/walker/passes/python-ast-type-source.ts`
(new), `.../annotation-type-facts.ts` (edit),
`tests/unit/domains/language/python/walker/python-ast-type-source.test.ts`
(new).

**Interfaces:** `PYTHON_AST_SOURCE = "ast"`,
`pythonAstTypeSource: InlineTypeSource<PythonTypeSourceInput>`,
`pythonReturnExpressionType(node, scope): string | null`.

The source emits `kind:"return"` facts for defs the annotation source declined,
ranked last by `PYTHON_TYPE_SOURCE_ORDER`, landing in `structuredReturnTypes`
through the channel that already exists. Five expression shapes, and silence
everywhere else.

- [ ] Failing test first. Parse real Python with the project's tree-sitter
      harness (copy the setup from
      `tests/unit/domains/language/python/walker/python-annotation-type-source.test.ts`)
      and assert on the emitted facts:

```ts
it("infers a constructor return", () => {
  const facts = extract(`
class Factory:
    def build(self):
        return Widget()
`);
  expect(facts).toContainEqual(
    expect.objectContaining({
      kind: "return",
      source: "ast",
      symbolScope: ["Factory"],
      methodName: "build",
      type: { form: "instance", name: "Widget" },
    }),
  );
});
it("infers self as the enclosing class", () => {
  /* `return self` inside Builder#with_x → instance Builder */
});
it("infers cls(...) as the enclosing class", () => {
  /* @classmethod def make(cls): return cls(x) */
});
it("infers a typed self field", () => {
  /* `session: Session` in the class body; `return self.session` */
});
it("infers a same-file annotated callee one hop", () => {
  /* `def make() -> Widget`; `return make()` */
});
it("is silent when two returns disagree", () => {
  /* return Widget() / return Gadget() */
});
it("is silent on a bare return", () => {
  /* `return Widget()` on one branch, `return` on the other */
});
it("is silent on a def with no return statement", () => {});
it("is silent on a generator", () => {
  /* body contains `yield` */
});
it("is silent on a nested def's returns", () => {
  /* inner `def helper(): return Widget()` must not type the outer */
});
it("loses to an annotation on the same def", () => {
  // `def build(self) -> Gadget: return Widget()` → the store keeps `Gadget`.
});
```

- [ ] Create `python-return-expression.ts`:

```ts
/**
 * The Python half of the kernel's return-inference ports (E2 seam 5, bd
 * tea-rags-mcp-9fgdi): which expression shapes name a class, and nothing else.
 *
 * Five shapes, each one measured on the corpora rather than imagined:
 *   `Widget()`        a constructor call            → Widget
 *   `self`            a fluent method               → the enclosing class
 *   `cls` / `cls(…)`  a `@classmethod` factory      → the enclosing class
 *   `self.session`    a field the class TYPES       → that field's class
 *   `make()`          a SAME-FILE annotated callee  → its declared return
 *
 * The last one is deliberately same-file-only. A per-file walker pass has no
 * return types for another file's defs, and inventing a channel to defer the
 * hop would duplicate what `localCallBindings` (Task 3) does properly at
 * resolve time. One hop, no recursion: a same-file callee whose OWN return is
 * itself inferred is silence, because the pass has no fixpoint and a wrong
 * return type poisons every downstream chain hop.
 */
import type { AstNode } from "../../../../../contracts/types/ast.js";
import { pythonBareTypeName } from "./python-type-annotation.js";

/** What the enclosing def can see: its class, that class's typed fields, and the file's annotated defs. */
export interface PythonReturnScope {
  /** Enclosing class short name; undefined at module level (`self` / `cls` are then meaningless). */
  readonly selfClass: string | undefined;
  /** `<field> → <class>` for the enclosing class, from its annotated assignments. */
  readonly fieldTypes: ReadonlyMap<string, string>;
  /** `<bare def name> → <declared return class>` for TOP-LEVEL defs in this file. */
  readonly fileReturnTypes: ReadonlyMap<string, string>;
}

/** A single capitalized identifier — Python's class-name convention. */
const PYTHON_CLASS_NAME = /^[A-Z]\w*$/;

export function pythonReturnExpressionType(
  node: AstNode,
  scope: PythonReturnScope,
): string | null {
  if (node.type === "identifier") {
    if (node.text === "self" || node.text === "cls")
      return scope.selfClass ?? null;
    return null; // a bare local is the kernel engine's binding case, not ours
  }
  if (node.type === "attribute") {
    const object = node.childForFieldName("object");
    const attribute = node.childForFieldName("attribute");
    if (
      object?.type !== "identifier" ||
      object.text !== "self" ||
      attribute === null
    )
      return null;
    return scope.fieldTypes.get(attribute.text) ?? null;
  }
  if (node.type === "await")
    return pythonReturnExpressionType(node.namedChildren[0] ?? node, scope);
  if (node.type !== "call") return null;
  const fn = node.childForFieldName("function");
  if (fn === null) return null;
  if (fn.type === "identifier") {
    if (fn.text === "cls") return scope.selfClass ?? null;
    if (PYTHON_CLASS_NAME.test(fn.text)) return fn.text;
    return scope.fileReturnTypes.get(fn.text) ?? null;
  }
  // `mod.Widget()` — the dotted spelling of a constructor; the LAST segment decides.
  if (fn.type === "attribute" || fn.type === "dotted_name") {
    const bare = pythonBareTypeName(fn.text);
    return PYTHON_CLASS_NAME.test(bare) ? bare : null;
  }
  return null;
}
```

- [ ] Create `python-ast-type-source.ts`:

```ts
/**
 * The `ast` type source (E2 seam 5, bd tea-rags-mcp-9fgdi) — a def's return
 * type inferred from its own `return` statements, through the kernel engine.
 *
 * Ranked LAST in `PYTHON_TYPE_SOURCE_ORDER`, so an annotation or a docstring on
 * the same def always wins; the store's coordinate dedupe does that for free.
 * It exists for the 30-odd percent of project defs that carry no annotation at
 * all, whose return type is what `localCallBindings` (Task 3) needs to fold.
 */
import type { AstNode } from "../../../../../contracts/types/ast.js";
import {
  inferReturnTypeName,
  type ReturnInferencePorts,
} from "../../../kernel/return-inference.js";
import type { InlineTypeSource, TypeFact } from "../../../kernel/type-facts.js";
import type { PythonTypeSourceInput } from "./python-annotation-type-source.js";
import {
  isPythonClassFormDef,
  pythonAnnotationExpression,
  walkPythonScopes,
} from "./python-def-scope-walk.js";
import {
  pythonReturnExpressionType,
  type PythonReturnScope,
} from "./python-return-expression.js";
import {
  pythonNominalReceiverName,
  pythonTypeRefFromNode,
} from "./python-type-annotation.js";

export const PYTHON_AST_SOURCE = "ast";

/** Nodes that open a new function scope — a `return` inside one belongs to IT, not to the outer def. */
const PYTHON_NESTED_SCOPES = new Set([
  "function_definition",
  "class_definition",
  "lambda",
]);

/** Every `return` in this def's own scope, as the expression it yields (the statement itself when bare). */
function pythonReturnTerminals(defNode: AstNode): AstNode[] {
  const out: AstNode[] = [];
  const body = defNode.childForFieldName("body");
  if (body === null) return out;
  const scan = (n: AstNode): void => {
    if (PYTHON_NESTED_SCOPES.has(n.type)) return;
    // A generator's `return` does not name what the caller receives.
    if (n.type === "yield") {
      out.length = 0;
      out.push(n);
      return;
    }
    if (n.type === "return_statement") {
      const arg = n.namedChild(0);
      out.push(arg ?? n); // a BARE `return` yields None; the mapper answers null for the statement
      return;
    }
    for (const child of n.namedChildren) scan(child);
  };
  for (const child of body.namedChildren) scan(child);
  return out;
}

/** Assignment events to `name` in this def's own scope. Augmented / multiple targets contribute `null`. */
function pythonAssignmentEvents(
  defNode: AstNode,
  name: string,
): (AstNode | null)[] {
  const events: (AstNode | null)[] = [];
  const body = defNode.childForFieldName("body");
  if (body === null) return events;
  const scan = (n: AstNode): void => {
    if (PYTHON_NESTED_SCOPES.has(n.type)) return;
    if (n.type === "assignment") {
      const lhs = n.namedChild(0);
      if (lhs?.type === "identifier" && lhs.text === name)
        events.push(n.childForFieldName("right"));
      else if (
        lhs?.type === "pattern_list" &&
        lhs.namedChildren.some((t) => t.text === name)
      )
        events.push(null);
    } else if (n.type === "augmented_assignment") {
      const lhs = n.namedChild(0);
      if (lhs?.type === "identifier" && lhs.text === name) events.push(null);
    } else if (n.type === "for_statement") {
      const target = n.childForFieldName("left");
      if (target?.text === name) events.push(null); // rebound each iteration
    }
    for (const child of n.namedChildren) scan(child);
  };
  for (const child of body.namedChildren) scan(child);
  return events;
}

function pythonReturnPorts(
  scope: PythonReturnScope,
): ReturnInferencePorts<AstNode, null> {
  return {
    terminalExpressions: (defNode) => pythonReturnTerminals(defNode),
    typeOfExpression: (node) => pythonReturnExpressionType(node, scope),
    isBinding: (node) =>
      node.type === "identifier" && node.text !== "self" && node.text !== "cls",
    bindingName: (node) => node.text,
    assignmentEvents: (defNode, name) => pythonAssignmentEvents(defNode, name),
  };
}
```

- [ ] Add the two pre-scans and the `extract` in the same file. `fieldTypes` and
      `fileReturnTypes` are built ONCE per file, before the emitting walk, so
      the pass stays O(defs) and the perf budget holds:

```ts
/** Per-class `<field> → <class>` from annotated class-body and `self.x: T` assignments. */
function collectPythonFieldTypes(
  root: AstNode,
): Map<string, Map<string, string>> {
  const byClass = new Map<string, Map<string, string>>();
  walkPythonScopes(root, {
    onAnnotatedAssignment: (site) => {
      const owner = site.classChain[site.classChain.length - 1];
      if (owner === undefined) return;
      const typeField = site.node.childForFieldName("type");
      if (typeField === null) return;
      const ref = pythonTypeRefFromNode(
        pythonAnnotationExpression(typeField),
        owner,
      );
      const nominal =
        ref === undefined ? undefined : pythonNominalReceiverName(ref);
      if (nominal === undefined) return;
      const lhs = site.node.namedChild(0);
      const name =
        lhs?.type === "identifier" && site.methodName === undefined
          ? lhs.text
          : lhs?.type === "attribute" &&
              lhs.childForFieldName("object")?.text === "self"
            ? (lhs.childForFieldName("attribute")?.text ?? null)
            : null;
      if (name === null) return;
      (byClass.get(owner) ?? byClass.set(owner, new Map()).get(owner)!).set(
        name,
        nominal,
      );
    },
  });
  return byClass;
}

/** `<top-level def name> → <declared return class>` — the one-hop table. */
function collectPythonFileReturnTypes(root: AstNode): Map<string, string> {
  const out = new Map<string, string>();
  walkPythonScopes(root, {
    onDef: (site) => {
      if (site.classChain.length > 0) return;
      const returnType = site.node.childForFieldName("return_type");
      if (returnType === null) return;
      const ref = pythonTypeRefFromNode(
        pythonAnnotationExpression(returnType),
        undefined,
      );
      const nominal =
        ref === undefined ? undefined : pythonNominalReceiverName(ref);
      if (nominal !== undefined) out.set(site.name, nominal);
    },
  });
  return out;
}
```

```ts
function extractPythonAstFacts(input: PythonTypeSourceInput): TypeFact[] {
  const fieldTypes = collectPythonFieldTypes(input.root);
  const fileReturnTypes = collectPythonFileReturnTypes(input.root);
  const facts: TypeFact[] = [];
  walkPythonScopes(input.root, {
    onDef: (site) => {
      // An annotated def is the `annotations` source's; re-emitting would only
      // lose the coordinate dedupe race and cost a walk.
      if (site.node.childForFieldName("return_type") !== null) return;
      const selfClass = site.classChain[site.classChain.length - 1];
      const scope: PythonReturnScope = {
        selfClass,
        fieldTypes:
          (selfClass === undefined ? undefined : fieldTypes.get(selfClass)) ??
          new Map(),
        fileReturnTypes,
      };
      const name = inferReturnTypeName(
        site.node,
        null,
        pythonReturnPorts(scope),
      );
      if (name === null) return;
      const fact: TypeFact = {
        kind: "return",
        source: PYTHON_AST_SOURCE,
        symbolScope: [...site.classChain],
        methodName: site.name,
        type: { form: "instance", name },
      };
      if (isPythonClassFormDef(site.decorators)) fact.classForm = true;
      facts.push(fact);
    },
  });
  return facts;
}

export const pythonAstTypeSource: InlineTypeSource<PythonTypeSourceInput> = {
  name: PYTHON_AST_SOURCE,
  extract: extractPythonAstFacts,
};
```

- [ ] Register it in `annotation-type-facts.ts`. Replace the `"ast"` string
      literal in the order constant with the imported name and append the source
      — the rank does not move, it just stops being a promise:

```ts
export const PYTHON_TYPE_SOURCE_ORDER: readonly string[] = [
  PYTHON_ANNOTATION_SOURCE,
  PYTHON_DOCSTRING_SOURCE,
  PYTHON_AST_SOURCE,
];

export const PYTHON_INLINE_TYPE_SOURCES: readonly InlineTypeSource<PythonTypeSourceInput>[] =
  [pythonAnnotationTypeSource, pythonDocstringTypeSource, pythonAstTypeSource];
```

- [ ] Run the new test — eleven green. Run the whole Python walker suite
      unedited.
- [ ] **A/B ×5.** Fresh BEFORE dumps from the pre-task tree, AFTER dumps from
      this one. Gate: gross `lost` = 0, phantom delta ≤ +0.5 pp of edges on
      every corpus, ugnest phantom stays 0. Record the `structuredReturnTypes`
      count delta per corpus in the bead — this task's yield is a CHANNEL, and
      most of its recall arrives in Task 3.
- [ ] **Chain tally ×5, drift 0.** **netbox perf A/B**: wall ≤ +25 %, RSS ≤ +20
      %.
- [ ] `npm run test:coverage` exit 0. Commit:
      `feat(language): infer Python return types from return statements (9fgdi)`.

---

## Task 3 — Bind a local to the result of a call (R1b)

**Files:** `src/core/contracts/types/codegraph-resolution.ts` (edit — the
`CallContext` field), `src/core/contracts/types/codegraph-extraction.ts` (edit —
the `FileExtraction` / `ChunkExtraction` channel),
`src/core/domains/language/python/walker/walker.ts` (edit),
`.../passes/python-type-channels.ts` (edit),
`.../resolver/strategies/python-local-binding.ts` (edit),
`.../resolver/python-receiver-type-ports.ts` (edit),
`tests/unit/domains/language/python/resolver/python-local-binding.test.ts` (edit
— ADD cases, never rewrite), plus the run-state absorb in
`src/core/domains/trajectory/codegraph/symbols/run-state.ts` (edit).

**Interfaces:**

```ts
/** `NAME = <callee>(…)` — the callee EXPRESSION, folded at resolve time. */
export interface LocalCallBinding {
  readonly line: number;
  /** Raw callee text as written: `Repo.from_session`, `self.factory.build`, `make`. */
  readonly callee: string;
}
// ChunkExtraction / CallContext: `localCallBindings?: Record<string, LocalCallBinding[]>`
```

This is the largest `localVar` lever (polar 470, netbox 130, httpx 15) and it
exists because the type is knowable only where both files are in scope. The
walker records the SPELLING; the resolver folds it with the machinery seam 3
already built.

- [ ] Failing resolver test first, in the existing file, as ADDED cases:

```ts
it("binds a local to a classmethod's return type through the MRO", () => {
  // ctx: localCallBindings { repository: [{ line: 10, callee: "SubscriptionRepository.from_session" }] }
  //      classAncestors  { "repo/sub.py::SubscriptionRepository": ["repo/base.py::RepositoryBase"] }
  //      structuredReturnTypes { "RepositoryBase.from_session": { form: "instance", name: "RepositoryBase" } }
  // call: receiver "repository", member "update", line 12
  // expect: resolved → RepositoryBase#update in repo/base.py
});
it("prefers a real localBindings entry over a call binding", () => {
  /* both present → the walker's type wins */
});
it("ignores a call binding declared BELOW the call site", () => {
  /* line 30 binding, line 12 call → CONTINUE */
});
it("takes the NEAREST call binding above the call site", () => {
  /* two bindings, 5 and 20; call at 25 → the line-20 one */
});
it("CONTINUEs when the callee folds to nothing", () => {
  /* callee "opaque.thing" with no facts */
});
it("DROPs when the folded type is external", () => {
  /* callee returns an httpx.Client */
});
it("does not fold a callee more than one hop", () => {
  /* callee is itself a chain needing two return lookups */
});
```

- [ ] Add the contract. In `codegraph-local-binding.ts`, beside `LocalBinding`:

```ts
/**
 * A local bound to the RESULT of a call, recorded as the callee SPELLING
 * because its type is not knowable in a per-file pass (bd tea-rags-mcp-9fgdi).
 *
 * `repository = SubscriptionRepository.from_session(session)` types `repository`
 * as whatever `from_session` returns — a fact that lives in ANOTHER file's
 * `structuredReturnTypes` and on a class the caller reaches only through the
 * MRO. The walker therefore records `callee: "SubscriptionRepository.from_session"`
 * and the resolver folds it once, at the one layer where the whole symbol table
 * is in scope.
 */
export interface LocalCallBinding {
  /** 1-based line of the assignment. */
  readonly line: number;
  /** The callee as written, arguments stripped: `Repo.from_session`, `self.factory.build`, `make`. */
  readonly callee: string;
}
```

      Add `localCallBindings?: Record<string, LocalCallBinding[]>` to
      `ChunkExtraction` (`codegraph-extraction.ts`) and to `CallContext`
      (`codegraph-resolution.ts`), each with a doc comment pointing here. In
      `run-state.ts`, absorb it exactly where `localBindings` is absorbed —
      per-chunk, no run-global merge.

- [ ] Collect it in a new facet pass,
      `python/walker/passes/python-local-call-bindings.ts`. It mirrors
      `typeFactChannels`'s chunk attribution so a binding lands on the chunk
      whose line range contains it:

```ts
/** `NAME = <callee>(…)` sites, per chunk (E2 seam 5, bd tea-rags-mcp-9fgdi). */
const PYTHON_NESTED_SCOPES = new Set([
  "function_definition",
  "class_definition",
  "lambda",
]);

/** The callee spelling of a call node, or null when it is not a plain dotted name. */
function pythonCalleeSpelling(call: AstNode): string | null {
  const fn = call.childForFieldName("function");
  if (fn === null) return null;
  if (
    fn.type !== "identifier" &&
    fn.type !== "attribute" &&
    fn.type !== "dotted_name"
  )
    return null;
  const text = fn.text;
  // A spelling with a call, an index or a newline in it is a CHAIN, not a name;
  // the fold would have to re-parse it and this channel does not do that.
  return /^[A-Za-z_][\w]*(\.[A-Za-z_][\w]*)*$/.test(text) ? text : null;
}

function collectPythonLocalCallBindings(
  root: AstNode,
): Map<string, LocalCallBinding[]> {
  const out = new Map<string, LocalCallBinding[]>();
  const scan = (n: AstNode, inFunction: boolean): void => {
    if (n.type === "assignment" && inFunction) {
      const lhs = n.namedChild(0);
      const rhs = n.childForFieldName("right");
      const call = rhs?.type === "await" ? (rhs.namedChild(0) ?? rhs) : rhs;
      if (lhs?.type === "identifier" && call?.type === "call") {
        const callee = pythonCalleeSpelling(call);
        if (callee !== null) {
          const line = n.startPosition.row + 1;
          (out.get(lhs.text) ?? out.set(lhs.text, []).get(lhs.text)!).push({
            line,
            callee,
          });
        }
      }
    }
    for (const child of n.namedChildren)
      scan(child, inFunction || PYTHON_NESTED_SCOPES.has(n.type));
  };
  for (const child of root.namedChildren) scan(child, false);
  for (const list of out.values()) list.sort((a, b) => a.line - b.line);
  return out;
}
```

      The pass returns `{ chunks: [...] }` with `localCallBindings` filtered to
      each chunk's `[startLine, endLine]`, `calls: []`, and no record for a
      chunk with none — the same "empty is absent" discipline
      `typeFactChannels` holds. Gate the whole pass on
      `pythonLocalTypeTrackingEnabled()`, like `param` / `local` facts.

- [ ] Fold it in the resolver. Add to `strategies/shared.ts`:

```ts
/**
 * The type of the call a local was bound from — ONE hop (bd tea-rags-mcp-9fgdi).
 *
 * The callee's receiver is folded by the shared chain engine (so
 * `self.factory.build` works), then its return type is read off the class the
 * fold produced, through the MRO — which is the whole point, since
 * `SubscriptionRepository.from_session` is declared on `RepositoryBase`.
 * A bare callee (`make(…)`) reads the file-flat `functionReturnTypes` channel
 * only when the symbol table pins exactly one project def of that name.
 *
 * ONE hop by construction: the returned ref is never itself re-folded. A
 * fixpoint over return types is a different seam and would need a cycle guard
 * this does not have.
 */
export function pythonCallBindingType(
  callee: string,
  atLine: number,
  ctx: CallContext,
  ports: ReceiverTypePorts,
): TypeRef | undefined {
  const cut = callee.lastIndexOf(".");
  if (cut < 0) return undefined; // bare callees are Task 8's evidence, not this one's
  const receiverText = callee.slice(0, cut);
  const member = callee.slice(cut + 1);
  const receiverType = propagateReceiverType(receiverText, atLine, ctx, ports);
  if (receiverType === undefined) return undefined;
  return ports.memberTypeOf(receiverType, member, ctx);
}
```

- [ ] Teach `pythonSingleHopType` a bare CLASS head. `Repo.from_session` folds
      only if `Repo` types to something, and today a capitalized identifier with
      no parentheses answers `undefined` — the constructor branch requires them.
      Add, immediately after the `self` branch in
      `python-receiver-type-ports.ts`:

```ts
// A bare class name in receiver position: `Repo.from_session(…)` — CLASS form,
// so `memberTypeOf` reads the `Cls.member` spelling a @classmethod produces.
// Gated on the class resolving to a PROJECT file: `os.Path` in a project that
// never imports `os` is not evidence, it is a coincidence of capitalisation.
if (
  PYTHON_CLASS_HEAD.test(receiver) &&
  resolveTypeFile(receiver, ctx, mapper) !== null
) {
  return { form: "class", name: receiver };
}
```

- [ ] Consume it in `PythonLocalBindingSymbolResolutionStrategy#attempt`, AFTER
      the existing `resolveLocalBindingType` miss and before the `CONTINUE`, so
      a real walker binding always wins:

```ts
  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (!call.receiver) return CONTINUE;
    const localType = resolveLocalBindingType(ctx.localBindings, call.receiver, call.startLine);
    if (localType) return this.resolveOnBoundType(localType, call.member, ctx);
    const bound = nearestPythonCallBinding(ctx.localCallBindings, call.receiver, call.startLine);
    if (bound === undefined) return CONTINUE;
    const type = pythonCallBindingType(bound.callee, bound.line, ctx, this.ports);
    if (type === undefined || (type.form !== "class" && type.form !== "instance")) return CONTINUE;
    return this.resolveOnBoundType(type.name, call.member, ctx);
  }
```

      `nearestPythonCallBinding` is the `resolveLocalBinding` rule verbatim —
      the LAST entry whose `line <= atLine`, `undefined` when none. Put it next
      to `resolveLocalBinding` in `codegraph-local-binding.ts` so the two
      position rules cannot drift. The strategy now needs the ports, so build
      them in its constructor exactly as `chainType` does
      (`this.ports = createPythonReceiverTypePorts(mapper)`).

- [ ] **Dependency.** polar's dominant case
      (`SubscriptionRepository.from_session` declared on `RepositoryBase`) needs
      the MRO read that Task 4 adds to `memberTypeOf`. Execute Task 4 FIRST if
      you are running serially; Task 3's unit tests stand on their own either
      way, but its A/B numbers are only meaningful with Task 4 in the tree.
- [ ] Run the Python resolver suite — every existing `localBinding` test passes
      UNEDITED, including the `serializer.is_valid()` DROP.
- [ ] **A/B ×5** (with Task 4 present). Expect `localVar` recall netbox 0.21 →
      ~0.79, polar 0.43 → ~0.96, httpx 0.73 → ~1.0. Gate: gross `lost` = 0,
      phantom delta ≤ +0.5 pp, ugnest phantom 0.
- [ ] **Chain tally ×5, drift 0. netbox perf A/B** — this task adds ONE map
      lookup per unbound receiver and folds only on a hit; wall ≤ +25 %, RSS ≤
      +20 %.
- [ ] `npm run test:coverage` exit 0. Commit:
      `feat(language): bind Python locals to their call's return type (9fgdi)`.

---

## Task 4 — Inherited class fields and inherited returns (R4a)

**Files:** `.../resolver/strategies/shared.ts` (edit),
`.../resolver/python-receiver-type-ports.ts` (edit),
`.../resolver/strategies/python-self-field.ts` (edit),
`.../resolver/python-chain-factory.ts` (edit — hand the linearizer to
`chainType`),
`tests/unit/domains/language/python/resolver/python-chain-type.test.ts` (edit —
ADD cases).

**Interfaces:**

```ts
export function pythonInheritedMemberType(
  bareType: string,
  member: string,
  form: "class" | "instance",
  ctx: CallContext,
  mapper: PythonImportFileMapper,
  linearizer: AncestorLinearizer<CallContext> | undefined,
): TypeRef | undefined;
```

The single largest number in the attribution: polar's 1,528 `chain` rows are
`self.client.<member>()` where `client` is assigned in a base class's `__init__`
in another file. Seam 4 built the MRO for METHODS; this applies the same walk to
FIELDS and to `structuredReturnTypes`, inside `memberTypeOf` — the one place
both channels are read.

- [ ] Failing tests first, added to the `chainType` test file:

```ts
it("reads a class field declared on an ANCESTOR", () => {
  // classFieldTypes { SyncServiceBase: { client: "SyncClientBase" } }
  // classAncestors  { "svc/customers.py::CustomersService": ["sdk/base.py::SyncServiceBase"] }
  // call: receiver "self.client", member "build_request", callerScope ["CustomersService"]
  // expect resolved -> BuildRequestMixin#build_request, found up SyncClientBase's own MRO
});
it("prefers the receiver's OWN field over an ancestor's", () => {});
it("reads a structured return declared on an ANCESTOR", () => {
  // structuredReturnTypes { "RepositoryBase.from_session": instance RepositoryBase }
  // receiver type class SubscriptionRepository -> memberTypeOf("from_session") = instance RepositoryBase
});
it("yields nothing when the hierarchy leaves the project", () => {});
it("keeps the pre-seam behaviour with no linearizer", () => {});
it("does not walk for a container or union receiver", () => {});
```

- [ ] Add the walk to `strategies/shared.ts`:

```ts
/**
 * What `member` yields on a receiver of type `bareType`, consulting the whole
 * MRO rather than just the class the receiver names (bd tea-rags-mcp-9fgdi).
 *
 * This is the FIELD and RETURN counterpart of `resolvePythonInheritedMember`,
 * and it exists because of one measured shape: polar's generated SDK assigns
 * `self.client` in `SyncServiceBase.__init__` and calls it from 60-odd
 * subclasses in other files. `classFieldTypes` is keyed by the SHORT name of
 * the class that ASSIGNED the field, so the subclass has no entry and the fold
 * stops on hop 1 — 1,528 rows, 95 % of that corpus's `chain` hole.
 *
 * Order per class, own class first: the FIELD channel (narrower — it names the
 * class that owns the attribute), then the RETURN channel under the spelling
 * the receiver form dictates. First answer wins; the walk stops there.
 *
 * A run with no linearizer (a walker-v2 index carrying no `classAncestors`)
 * reads the own class only, which is exactly today's behaviour.
 */
export function pythonInheritedMemberType(
  bareType: string,
  member: string,
  form: "class" | "instance",
  ctx: CallContext,
  mapper: PythonImportFileMapper,
  linearizer: AncestorLinearizer<CallContext> | undefined,
): TypeRef | undefined {
  const separator = form === "class" ? "." : "#";
  const onClass = (shortName: string, classFq: string): TypeRef | undefined => {
    const fieldType = ctx.classFieldTypes?.[shortName]?.[member];
    if (fieldType !== undefined) return { form: "instance", name: fieldType };
    return ctx.structuredReturnTypes?.[`${classFq}${separator}${member}`];
  };
  const own = onClass(bareType, bareType);
  if (own !== undefined) return own;
  if (linearizer === undefined) return undefined;

  const targetFile = resolveTypeFile(bareType, ctx, mapper);
  if (targetFile === null) return undefined;
  const classKey = pythonBoundClassKey(bareType, targetFile, ctx);
  if (classKey === null) return undefined;
  for (const ancestorKey of linearizer.linearize(classKey, ctx)) {
    if (ancestorKey === classKey) continue;
    const parsed = parsePythonClassKey(ancestorKey);
    if (parsed === null) continue;
    const shortName = parsed.classFq.split(".").pop() ?? parsed.classFq;
    const hit = onClass(shortName, parsed.classFq);
    if (hit !== undefined) return hit;
  }
  return undefined;
}
```

      Match `linearize`'s real signature to seam 4's `AncestorLinearizer`
      (`python-ancestor-policy.ts`); if it returns a closure record rather than
      a bare list, iterate the `keys` it exposes and ignore the closure — a
      field lookup has no absence verdict to report.

- [ ] Rewire `pythonMemberTypeOf` to call it, and thread the linearizer through
      the ports factory the way the mapper is already threaded:

```ts
function pythonMemberTypeOf(
  recv: TypeRef,
  member: string,
  ctx: CallContext,
  mapper: PythonImportFileMapper,
  linearizers: PythonAncestorLinearizerCache | undefined,
): TypeRef | undefined {
  if (recv.form !== "class" && recv.form !== "instance") return undefined;
  return pythonInheritedMemberType(
    recv.name,
    member,
    recv.form,
    ctx,
    mapper,
    linearizers?.for(ctx),
  );
}

export function createPythonReceiverTypePorts(
  mapper: PythonImportFileMapper,
  linearizers?: PythonAncestorLinearizerCache,
): ReceiverTypePorts {
  return Object.freeze({
    singleHopType: (receiver, atLine, ctx) =>
      pythonSingleHopType(receiver, atLine, ctx, mapper),
    seedHead: (head, firstLink, ctx) =>
      pythonSeedHead(head, firstLink, ctx, mapper),
    memberTypeOf: (recv, member, ctx) =>
      pythonMemberTypeOf(recv, member, ctx, mapper, linearizers),
    maxHops: pythonMaxHops,
  });
}
```

      `linearizers` stays OPTIONAL so every existing construction site compiles
      untouched and keeps the own-class-only read. `python-chain-factory.ts`
      passes the cache it already builds:
      `new PythonChainTypeSymbolResolutionStrategy(cfg, mapper, linearizers)`.
      The strategy takes it as a third constructor parameter and forwards it.

- [ ] Do the same for `PythonSelfFieldSymbolResolutionStrategy`. It reads
      `ctx.classFieldTypes?.[enclosing]?.[field]` directly
      (`python-self-field.ts:34`); replace that read with
      `pythonInheritedMemberType(enclosing, field, "instance", ctx, mapper, linearizer)`
      and narrow to `form === "instance"`. Everything below it — the file
      resolution, the DROP verdict — is unchanged. Its constructor gains the
      same optional linearizer parameter and the factory passes it.
- [ ] Run the Python resolver suite. Every existing `selfField` and `chainType`
      test passes UNEDITED.
- [ ] **A/B ×5.** Expect `chain` recall polar 0.009 → ~0.96, ugnest 0 → 1.0,
      flask 0.07 → ~0.45, httpx 0.27 → ~0.45; netbox `chain` barely moves (its
      hole is R4b and E3). Gate: gross `lost` = 0, phantom delta ≤ +0.5 pp,
      ugnest phantom 0.
- [ ] **Chain tally ×5, drift 0. netbox perf A/B.** The MRO walk runs only on a
      MISS of the own-class read, and the linearizer is memoised per run; wall ≤
      +25 %, RSS ≤ +20 %.
- [ ] `npm run test:coverage` exit 0. Commit:
      `feat(language): read Python class fields and returns up the MRO (9fgdi)`.

---

## Task 5 — Module receivers (R4b / R4c)

**Files:** `.../resolver/strategies/python-module-receiver.ts` (new),
`.../resolver/strategies/index.ts` (edit),
`.../resolver/python-chain-factory.ts` (edit),
`tests/unit/domains/language/python/resolver/python-module-receiver.test.ts`
(new).

**Interfaces:** `PythonModuleReceiverSymbolResolutionStrategy`
(`name = "moduleReceiver"`), placed at slot 6 — after `chainType`, before
`namingConvention` and `importedName`.

netbox spends 144 rows on a MODULE in receiver position:
`utilities.fields.ColorField(...)` (99 `chain` rows, mostly generated Django
migrations) and `layout.SimpleLayout(...)` (45 `localVar` rows, from
`from utilities.forms import rendering as layout`), plus 15 polar `dynamic`
rows. The chain fold declines both by construction — a module is not `self`, not
a constructor call, and not a local binding — and the import mapper already
turns a module path into a file, so this is a LOOKUP.

- [ ] Failing tests first:

```ts
it("resolves a dotted module path receiver to a class in that module", () => {
  // imports: `from utilities import fields` / `import utilities.fields`
  // call: receiver "utilities.fields", member "ColorField"
  // expect resolved -> netbox/utilities/fields.py :: ColorField
});
it("resolves an aliased module receiver", () => {
  // `from utilities.forms import rendering as layout`; receiver "layout", member "SimpleLayout"
});
it("CONTINUEs when the receiver is a bound local, not a module", () => {});
it("CONTINUEs when the module maps outside the project", () => {
  /* `os.path` -> external */
});
it("CONTINUEs when the module file declares no such member", () => {});
it("does not answer when the member is lowercase and ambiguous in that file", () => {
  // strict mode: two `def get` in the module -> pickSingleCandidate CONTINUEs
});
```

- [ ] Create `python-module-receiver.ts`:

```ts
/**
 * A MODULE in receiver position (E2 seam 5, bd tea-rags-mcp-9fgdi) —
 * `utilities.fields.ColorField(…)` and `layout.SimpleLayout(…)`.
 *
 * Neither shape is a value, so every typed pass above declines it:
 * `pythonSingleHopType` answers for `self`, a constructor call and a local
 * binding, and a module is none of the three. Measured on netbox: 99 `chain`
 * rows spell the module path in full (generated Django migrations import
 * `utilities.fields` and construct from it), 45 `localVar` rows use an alias
 * (`from utilities.forms import rendering as layout`), and polar adds 15 more.
 *
 * The evidence is entirely in the caller's own import list, which is why this
 * is a lookup rather than an inference: the receiver text must MATCH an import
 * this file makes, that import must map to a PROJECT file, and that file must
 * declare exactly one symbol under the member's name. Any of the three failing
 * is a CONTINUE — never a DROP, because a module receiver the mapper cannot
 * place is not evidence that the call is foreign, and `importedName` below
 * still has its own say.
 *
 * Placed AFTER `chainType` so a genuinely typed receiver always wins (a local
 * named `layout` bound to a class shadows the alias, and Python agrees), and
 * BEFORE `importedName` so a module receiver is never re-read as a value
 * binding.
 */
export class PythonModuleReceiverSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "moduleReceiver";
  constructor(
    private readonly cfg: ResolverConfig,
    private readonly mapper: PythonImportFileMapper = new PythonImportFileMapper(),
  ) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    const { receiver } = call;
    if (receiver === null || receiver === "self") return CONTINUE;
    // A receiver the walker BOUND is a value; `localBinding` owns it and a
    // module alias never lands in that channel.
    if (resolveLocalBindingType(ctx.localBindings, receiver, call.startLine))
      return CONTINUE;
    if (!PYTHON_MODULE_RECEIVER.test(receiver)) return CONTINUE;

    const moduleFile = this.moduleFileFor(receiver, ctx);
    if (moduleFile === null) return CONTINUE;
    const declared = ctx.symbolTable
      .lookupByShortName(call.member)
      .filter((def) => def.relPath === moduleFile);
    const hit = pickSingleCandidate(declared, this.cfg.mode);
    return hit
      ? resolved({ targetRelPath: hit.relPath, targetSymbolId: hit.symbolId })
      : CONTINUE;
  }

  /** The project file the receiver names as a module, or null. */
  private moduleFileFor(receiver: string, ctx: CallContext): string | null {
    for (const imp of ctx.imports) {
      const binding = findPythonImportBinding([imp], receiver);
      if (binding === null) continue;
      const file = mapPythonImportToFile(binding.modulePath, ctx, this.mapper);
      if (file !== null) return file;
    }
    return null;
  }
}

/** A dotted lowercase path or a single lowercase alias — never a class, never a call. */
const PYTHON_MODULE_RECEIVER = /^[a-z_]\w*(\.[a-z_]\w*)*$/;
```

      `findPythonImportBinding` and the mapper call must be the EXISTING
      helpers; if `findPythonImportBinding` does not expose a module path for
      an `import a.b` / `from a import b` / `... as alias` form, extend it
      there rather than re-parsing import text here — `importedName` reads the
      same table and the two must not disagree about what an import binds.

- [ ] Wire it into `python-chain-factory.ts` at slot 6 and update the pass-order
      comment in `python-resolver.ts`.
- [ ] **A/B ×5.** Expect netbox `chain` 0.004 → ~0.41 and netbox `localVar` to
      pick up its 45; polar `dynamic` +15. Gate: gross `lost` = 0, phantom delta
      ≤ +0.5 pp, ugnest phantom 0.
- [ ] **Chain tally ×5, drift 0. netbox perf A/B** — the regex rejects most
      receivers before any lookup; wall ≤ +25 %, RSS ≤ +20 %.
- [ ] `npm run test:coverage` exit 0. Commit:
      `feat(language): resolve Python module receivers (9fgdi)`.

---

## Task 6 — Naming-convention receiver typing (R2), subtype-gated

**Files:** `src/core/domains/language/kernel/naming-convention.ts` (new),
`.../ruby/resolver/ruby-unbound-receiver-types.ts` (edit — adapter),
`.../python/resolver/strategies/python-naming-convention.ts` (new),
`.../python/resolver/python-chain-factory.ts` (edit),
`tests/unit/domains/language/kernel/naming-convention.test.ts` (new),
`tests/unit/domains/language/python/resolver/python-naming-convention.test.ts`
(new).

**Interfaces:**

```ts
export interface NamingConventionPorts<TCtx> {
  /** `blog_post` -> `BlogPost`. Per-language: Ruby camelizes, Python does the same but on a narrower alphabet. */
  camelize: (receiverName: string) => string;
  /** Does the run DECLARE this class? The existence gate. */
  classExists: (className: string, ctx: TCtx) => boolean;
  /** Does it have DESCENDANTS? A polymorphic base named by a variable carries a concrete subtype. */
  hasSubtypes: (className: string, ctx: TCtx) => boolean;
}
export function conventionClassNameFor<TCtx>(
  receiverName: string,
  ctx: TCtx,
  ports: NamingConventionPorts<TCtx>,
): string | undefined;
```

105 rows across five corpora, concentrated where nothing else can speak: ugnest
`localVar` 11/13, polar `index` 46/48 (`prices[0].get_amount()` — the element
type is unknowable, the NAME is not), polar `dynamic` 21, netbox 10. Ruby's two
gates are neutral and relocate; the third (the member must PIN a symbol) is the
strategy's and is restated on the Python side.

- [ ] Kernel test first — three rules, fake ports:

```ts
it("answers the camelized class when it exists and has no subtypes", () => {});
it("is silent when the class does not exist", () => {});
it("is silent when the class has subtypes", () => {});
it("is silent on an empty camelization", () => {
  /* receiver "_" -> "" */
});
```

- [ ] Create `kernel/naming-convention.ts`:

```ts
/**
 * Naming-convention receiver typing, the neutral half (E2 seam 5, bd
 * tea-rags-mcp-9fgdi) — relocated from
 * `ruby/resolver/ruby-unbound-receiver-types.ts`, where it was measured on
 * taxdome as 11 % of the entire recall hole (bd tea-rags-mcp-wob7g).
 *
 * `payment` is a `Payment` because that is the dominant naming discipline of
 * every OO language, not a Rails idiom. Two gates, both measured rather than
 * argued, and BOTH are the whole precision story:
 *
 *  1. the camelized class must EXIST in the run. A name that camelizes to
 *     nothing the project declares means something else entirely, and a
 *     fabricated receiver type poisons every downstream hop.
 *  2. it must have NO subtypes. A class with descendants is a polymorphic base,
 *     and a variable named after it carries a CONCRETE subtype at runtime —
 *     `actor` in an app whose `Actor` is specialised by Guest / Employee is an
 *     `Employee`. That shape is where EVERY measured convention error came from.
 *
 * What this does NOT own is the terminal: the caller must still refuse to emit
 * an edge when the guessed class does not declare the member. That gate is
 * per-language (it needs the language's MRO) and each caller documents it.
 */
export interface NamingConventionPorts<TCtx> {
  /* as above */
}

export function conventionClassNameFor<TCtx>(
  receiverName: string,
  ctx: TCtx,
  ports: NamingConventionPorts<TCtx>,
): string | undefined {
  const className = ports.camelize(receiverName);
  if (className.length === 0) return undefined;
  if (!ports.classExists(className, ctx)) return undefined;
  if (ports.hasSubtypes(className, ctx)) return undefined;
  return className;
}
```

- [ ] Ruby adapter. `conventionClassName` becomes the `classExists` port
      (`ctx.symbolTable.lookupByShortName(name).length > 0`), `camelizeScope`
      becomes `camelize`, `hasDeclaredSubtypes` becomes `hasSubtypes` — all
      three bodies byte-identical, moved into a frozen module-level
      `RUBY_NAMING_CONVENTION_PORTS`. `conventionReceiverType` keeps its
      signature, its receiver regex, its keyword set and its doc comment, and
      its body becomes:

```ts
export function conventionReceiverType(
  receiver: string,
  ctx: CallContext,
): RubyTypeRef | undefined {
  if (
    CONVENTION_RECEIVER_KEYWORDS.has(receiver) ||
    !CONVENTION_RECEIVER.test(receiver)
  )
    return undefined;
  const name = conventionClassNameFor(
    receiver.replace(/^@{1,2}/, ""),
    ctx,
    RUBY_NAMING_CONVENTION_PORTS,
  );
  return name === undefined ? undefined : { form: "instance", name };
}
```

      `scopedReceiverType` keeps calling the same ports through
      `conventionClassNameFor` so the two tiers still cannot drift on what
      "the class exists" means. **Ruby parity gate:** the full Ruby suite
      unedited, plus a mastodon harness run bit-identical to the pre-task tree.

- [ ] Python strategy. Failing tests first:

```ts
it("types a bare receiver as its camelized class and pins the member", () => {
  // receiver "datasource", member "sync"; symbolTable declares DataSource#sync
  // expect resolved -> DataSource#sync
});
it("finds an INHERITED member on the guessed class", () => {
  /* through resolvePythonInheritedMember */
});
it("CONTINUEs when the class has subtypes", () => {});
it("CONTINUEs when the class does not exist", () => {});
it("CONTINUEs when the guessed class declares no such member", () => {
  /* gate 3 — never a file-only edge */
});
it("CONTINUEs for a receiver in the external vocabulary", () => {
  /* `request`, `session`, `logger` */
});
it("CONTINUEs when a real type fact already answers", () => {
  /* localBindings entry present */
});
it("never DROPs", () => {});
```

- [ ] Create `python-naming-convention.ts`:

```ts
/**
 * Naming-convention receiver typing for Python (E2 seam 5, bd
 * tea-rags-mcp-9fgdi) — `datasource.sync()` resolves to `DataSource#sync`.
 *
 * The neutral gates live in `kernel/naming-convention.ts`; this file supplies
 * Python's three answers and the terminal.
 *
 *  - `camelize`: `snake_case` -> `CamelCase`, and nothing else. A receiver
 *    already spelled `CamelCase` is a CONSTANT and belongs to `importedName`.
 *  - `classExists`: exactly one project declaration of that short name. Ruby
 *    accepts several because Zeitwerk makes the FQ recoverable; Python has no
 *    such guarantee, so two same-named classes in two packages are ambiguous
 *    and the convention declines.
 *  - `hasSubtypes`: any `classAncestors` VALUE whose bare last segment equals
 *    the candidate. The channel seam 4 built is the hierarchy evidence Python
 *    has; there is no `ctx.hierarchy` snapshot on this path.
 *
 * Gate 3, the terminal, is Ruby's and is restated verbatim in intent: the
 * member must PIN a symbol on the guessed class or its MRO. A class that
 * resolves but declares no such member emits NOTHING — no file-only edge. On
 * taxdome that gate is what made the Ruby tier shippable (372 wrong guesses
 * died silently at the terminal; edge accuracy 100 %), and it is the reason
 * this strategy can sit in the chain at all.
 *
 * Never DROPs. A DROP would claim the receiver's type is known-and-foreign,
 * which is exactly what a convention guess cannot establish.
 *
 * **Shipping condition.** This is the one GUESS in the plan. If the row-level
 * A/B shows phantom up by more than +0.5 pp of edges on ANY corpus, or ugnest
 * moving off 0, the strategy is REMOVED — not tuned, not gated further. That
 * decision was taken before it was written.
 */
export class PythonNamingConventionSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "namingConvention";
  constructor(
    private readonly cfg: ResolverConfig,
    private readonly vocabulary: PythonExternalVocabulary,
    private readonly mapper: PythonImportFileMapper = new PythonImportFileMapper(),
    private readonly linearizers?: PythonAncestorLinearizerCache,
  ) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    const receiver = pythonConventionReceiverName(call.receiver);
    if (receiver === null) return CONTINUE;
    if (this.vocabulary.isExternalName(receiver)) return CONTINUE;
    // A real fact wins: this pass speaks only for receivers nothing typed.
    if (resolveLocalBindingType(ctx.localBindings, receiver, call.startLine))
      return CONTINUE;

    const className = conventionClassNameFor(
      receiver,
      ctx,
      PYTHON_NAMING_CONVENTION_PORTS,
    );
    if (className === undefined) return CONTINUE;
    const targetFile = resolveTypeFile(className, ctx, this.mapper);
    if (targetFile === null) return CONTINUE;
    const classKey = pythonBoundClassKey(className, targetFile, ctx);
    if (classKey === null) return CONTINUE;
    const linearizer = this.linearizers?.for(ctx);
    if (linearizer === undefined) return CONTINUE;
    const { target } = resolvePythonInheritedMember(
      classKey,
      call.member,
      ctx,
      this.cfg.mode,
      linearizer,
    );
    // Gate 3: a class that owns nothing under this name emits NOTHING.
    return target === null || target.targetSymbolId === null
      ? CONTINUE
      : resolved(target);
  }
}

/**
 * The receiver texts the convention acts on: a bare snake_case name, or the
 * HEAD of an index access (`prices[0]` -> `prices` -> `Price`, polar's 46
 * `index` rows). Everything else — dotted chains, calls, `self`, CamelCase,
 * dunders — is another pass's.
 */
function pythonConventionReceiverName(receiver: string | null): string | null {
  if (receiver === null) return null;
  const head = /^([a-z_][a-z0-9_]*)(\[[^\]]*\])?$/.exec(receiver)?.[1] ?? null;
  if (
    head === null ||
    head.startsWith("__") ||
    head === "self" ||
    head === "cls"
  )
    return null;
  return head;
}

const PYTHON_NAMING_CONVENTION_PORTS: NamingConventionPorts<CallContext> =
  Object.freeze({
    camelize: (snake) =>
      snake
        .split("_")
        .filter((s) => s.length > 0)
        .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
        .join(""),
    classExists: (className, ctx) =>
      ctx.symbolTable.lookupByShortName(className).length === 1,
    hasSubtypes: (className, ctx) => {
      for (const bases of Object.values(ctx.classAncestors ?? {})) {
        for (const base of bases) {
          const bare = base.split("::").pop()?.split(".").pop();
          if (bare === className) return true;
        }
      }
      return false;
    },
  });
```

      `hasSubtypes` scans a run-global record on every candidate. Build the
      descendant SET once per `ctx.classAncestors` identity and memoise it in
      the strategy — a `WeakMap<object, Set<string>>` keyed by the record — or
      the netbox perf budget will not hold.

- [ ] Wire it in at slot 7 and update the pass-order comment.
- [ ] **A/B ×5, and read it strictly.** Expect ugnest `localVar` 0.32 → ~0.89,
      polar `index` 0 → ~0.96, polar `dynamic` +21, netbox +10. Gate: gross
      `lost` = 0, phantom delta ≤ +0.5 pp of edges on EVERY corpus, ugnest
      phantom exactly 0. **Fail on any of those ⇒ delete the strategy, keep the
      kernel relocation and the Ruby adapter, record the numbers in the bead.**
- [ ] **Chain tally ×5, drift 0. netbox perf A/B.** `npm run test:coverage`
      exit 0. Commit:
      `feat(language): naming-convention receiver typing for Python (9fgdi)`.

---

## Task 7 — Iteration variables (R3)

**Files:** `.../python/walker/passes/python-def-scope-walk.ts` (edit — one
visitor hook), `.../python/walker/passes/python-iteration-facts.ts` (new),
`.../python/walker/passes/annotation-type-facts.ts` (edit — register),
`tests/unit/domains/language/python/walker/python-iteration-facts.test.ts`
(new).

**Interfaces:** `PythonForStatementSite { node, classChain, methodName, line }`
added to `PythonScopeVisitor` as `onForStatement?`;
`pythonIterationTypeSource: InlineTypeSource<PythonTypeSourceInput>` emitting
`kind:"local"` facts under `PYTHON_AST_SOURCE`.

netbox `dynamic` 18, polar 53 across three kinds, httpx 4.
`for item in self.items:` with `items: list[Item]` types `item` as `Item`, and
the container→element mapping already exists.

- [ ] Failing tests first:

```ts
it("types a loop variable from an annotated field", () => {
  // class Basket: items: list[Item]        for item in self.items: item.price()
  // expect local fact { name: "item", line: <for line>, type: instance Item }
});
it("types a loop variable from an annotated parameter", () => {
  /* def f(xs: Sequence[Row]) */
});
it("types a loop variable from an annotated local", () => {});
it("types a dict loop variable as the KEY type", () => {
  /* for k in mapping: with dict[K, V] -> K */
});
it("types a .values() loop variable as the VALUE type", () => {});
it("declines .items()", () => {
  /* a 2-tuple target, not a single nominal */
});
it("declines a tuple target", () => {
  /* for a, b in pairs: */
});
it("declines an un-annotated iterable", () => {});
it("declines a container whose element is a union", () => {});
it("scopes a comprehension variable to its enclosing def", () => {});
it("skips a module-level comprehension", () => {
  /* no methodName coordinate */
});
```

- [ ] Add the hook to `walkPythonScopes`. In `descend`, before the trailing
      recursion, and WITHOUT an early return — a `for` body holds defs and
      assignments the other visitors still need:

```ts
if (node.type === "for_statement") {
  visitor.onForStatement?.({
    node,
    classChain: [...classChain],
    methodName: fnStack[fnStack.length - 1],
    line: node.startPosition.row + 1,
  });
}
```

      Comprehensions carry `for_in_clause`, not `for_statement`; add the same
      call for `"for_in_clause"` so a comprehension variable reaches the same
      emitter with its enclosing def's `methodName`. A clause whose
      `methodName` is `undefined` is at module level and the emitter skips it.

- [ ] Create `python-iteration-facts.ts`. It pre-scans annotated names per scope
      exactly as Task 2 pre-scans field types, then reads the loop:

```ts
/**
 * Iteration-variable typing (E2 seam 5, bd tea-rags-mcp-9fgdi) —
 * `for item in self.items:` where `items: list[Item]` binds `item` as an
 * `Item` at the loop line.
 *
 * The container -> element mapping is the one the annotation parser already
 * uses (`PYTHON_CONTAINER_FIRST` takes the FIRST argument, mappings take the
 * LAST), read here in the ITERATION direction: iterating a `dict[K, V]` yields
 * its KEYS, so a dict binding takes the FIRST argument, while `.values()`
 * takes the last. `.items()` yields a 2-tuple and is declined — a tuple target
 * is not a single nominal receiver and this seam does not destructure.
 *
 * Emitted under the `ast` source, so an explicit `for item in items:  # item: Item`
 * annotation (rare, but legal via a following `item: Item` statement) outranks it.
 */
function pythonIterationElementRef(
  iterable: AstNode,
  scope: PythonIterationScope,
): TypeRef | undefined {
  let node = iterable;
  let takeValues = false;
  if (node.type === "call") {
    const fn = node.childForFieldName("function");
    const attribute =
      fn?.type === "attribute"
        ? fn.childForFieldName("attribute")?.text
        : undefined;
    if (attribute !== "values") return undefined; // `.items()` and every other call: declined
    takeValues = true;
    node = fn?.childForFieldName("object") ?? node;
  }
  const containerRef = pythonIterableRefOf(node, scope);
  if (containerRef?.form !== "container") return undefined;
  const element = takeValues
    ? (containerRef.value ?? containerRef.element)
    : containerRef.element;
  return pythonNominalReceiverName(element) === undefined ? undefined : element;
}
```

      `pythonIterableRefOf` resolves `self.<attr>` through the pre-scanned
      field map, a bare name through the pre-scanned param/local map for the
      enclosing def, and answers `undefined` for everything else. If today's
      `TypeRef` container form carries only `element` (the mapping VALUE for
      `dict`), then iterating a dict cannot recover the KEY type — in that case
      DECLINE dict iteration entirely and say so in the docstring rather than
      widening `TypeRef`. Verify which it is before writing the test for the
      dict case, and make the test match the code you can honestly write.

- [ ] Emit the fact. Target must be a bare `identifier` (a `pattern_list` /
      `tuple_pattern` target is declined), the coordinate is
      `{ kind: "local", source: PYTHON_AST_SOURCE, symbolScope: classChain,     methodName, name: target.text, line: <for line>, type: element }`,
      gated on `input.trackLocalTypes` exactly as `param` / `local` facts are.
- [ ] Register `pythonIterationTypeSource` in `PYTHON_INLINE_TYPE_SOURCES`. It
      shares the `ast` rank with Task 2's source, and the two never collide: one
      emits `return` facts, the other `local`.
- [ ] **A/B ×5.** Expect netbox `dynamic` +18, polar +53, httpx +4. Gate: gross
      `lost` = 0, phantom delta ≤ +0.5 pp, ugnest phantom 0.
- [ ] **Chain tally ×5, drift 0. netbox perf A/B.** `npm run test:coverage`
      exit 0. Commit:
      `feat(language): type Python iteration variables from their container (9fgdi)`.

---

## Task 8 — A bare call to a def in the caller's own file (R8)

**Files:** `.../python/resolver/strategies/python-global-short-name.ts` (edit),
`tests/unit/domains/language/python/resolver/python-global-short-name.test.ts`
(edit — ADD cases).

**Interfaces:** none new. One arm inside
`PythonGlobalShortNameSymbolResolutionStrategy#attempt`, ahead of the existing
`pickSingleCandidate`.

Every corpus's `bareCall` hole is this one mechanism: polar 416/420, netbox
24/24, ugnest 12/12, httpx 7/7, flask 5/5, all with
`oracleTargetRelPath == relPath`. `validate_email(email)` at
`server/polar/kit/email.py:25` has `def validate_email` fourteen lines above it,
and `lookupByShortName` answers with every project-wide definition of that name,
so strict mode CONTINUEs to nothing.

- [ ] Failing tests first:

```ts
it("prefers a module-level def in the caller's own file over cross-file ambiguity", () => {
  // symbolTable: validate_email in kit/email.py AND in api/schemas.py
  // ctx.callerFile = "kit/email.py", call: receiver null, member "validate_email"
  // expect resolved -> kit/email.py :: validate_email
});
it("prefers a module-level CLASS in the caller's own file", () => {
  /* `Config()` with `class Config` above */
});
it("does not answer with a same-file METHOD", () => {
  // only `Cls#helper` in this file -> falls through to the existing arm
});
it("does not answer for a receiver-bound call", () => {
  /* receiver "obj" -> CONTINUE, unchanged */
});
it("still answers self-member calls the old way", () => {
  /* receiver "self" -> unchanged */
});
it("falls through unchanged when the caller's file declares nothing of that name", () => {});
it("picks nothing when the caller's own file declares TWO module-level defs of the name", () => {
  // a redefinition: the LAST one wins at runtime, but the resolver has no order
  // guarantee across chunks, so it declines rather than guessing.
});
```

- [ ] Add the arm. It goes AFTER the receiver gate and BEFORE the existing
      lookup, so nothing about the receiver contract changes:

```ts
  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (call.receiver !== null && call.receiver !== "self") return CONTINUE;
    const fallback = ctx.symbolTable.lookupByShortName(call.member);
    // ── Module scope wins, because Python says so (bd tea-rags-mcp-9fgdi) ──
    // A bare call names the module's own binding before it names anything a
    // sibling package happens to spell the same way; the interpreter resolves
    // local -> enclosing -> MODULE -> builtins and never consults another file.
    // So a module-level `def` / `class` in the CALLER's file is not a guess —
    // it is the answer, and it must win over the cardinality guard below, which
    // otherwise throws the whole site away. Measured: 372 of polar's 416 and 18
    // of netbox's 24 `bareCall` misses name exactly such a symbol.
    //
    // MODULE-LEVEL only. A same-file `Cls#helper` is a method, and a bare call
    // to it is only legal from inside `Cls` — evidence the enclosing scope
    // carries and this arm does not read. Those fall through unchanged.
    const sameFile = fallback.filter((def) => def.relPath === ctx.callerFile && isModuleLevel(def));
    if (sameFile.length === 1) {
      return resolved({ targetRelPath: sameFile[0].relPath, targetSymbolId: sameFile[0].symbolId });
    }
    const hit = pickSingleCandidate(fallback, this.cfg.mode);
    if (hit) return resolved({ targetRelPath: hit.relPath, targetSymbolId: hit.symbolId });
    return CONTINUE;
  }
```

      `isModuleLevel` is `def.scope.length === 0` if the symbol-table entry
      carries a `scope`; otherwise test the symbolId for the absence of `#` and
      `.`. Use whichever the `GlobalSymbolTable` entry actually exposes — read
      `contracts/types/codegraph-symbols.ts` before writing it, and put the
      helper next to the strategy rather than in `shared.ts` (one caller).

- [ ] **A/B ×5.** Expect `bareCall` recall: netbox 0.995 → ~0.999, polar 0.947 →
      ~0.994, ugnest 0.967 → ~1.0, flask 0.968 → ~1.0, httpx 0.973 → ~1.0. Gate:
      gross `lost` = 0, phantom delta ≤ +0.5 pp, ugnest phantom 0. This arm
      NARROWS an answer that was previously nothing, so a phantom rise here
      means the module-level filter is wrong — fix the filter, do not relax the
      gate.
- [ ] **Chain tally ×5, drift 0. netbox perf A/B** — one array filter on a list
      the strategy already fetched. `npm run test:coverage` exit 0. Commit:
      `feat(language): resolve Python bare calls to same-file module defs (9fgdi)`.

---

## Task 9 — Gates, navigators, capability text

**Files:** `src/core/domains/language/CLAUDE.md` (edit),
`src/core/domains/language/python/CLAUDE.md` (edit or new),
`src/core/domains/language/python/capability.ts` (edit — descriptor text),
`.claude/rules/domains-language.md` (edit if the relocation protocol needs a new
line).

- [ ] **Full-suite gate.** `npm run build`, then `npm run test:coverage` exit 0.
      No threshold is lowered; a shortfall goes to the `coverage-expander`
      subagent (`subagent_type: "coverage-expander"`,
      `run_in_background: true`), which writes tests only.
- [ ] **Final A/B ×5 on the integrated tree**, BEFORE dumps taken from
      `45d0830eb`. Report per corpus, per receiverKind: recall before, recall
      after, phantom before, phantom after, gross `lost`. Gross `lost` must be 0
      and ugnest phantom must be 0. Record the table in the bead — it is the
      evidence the epic-completion gate asks for.
- [ ] **Ruby parity, final.** Full Ruby suite plus a mastodon harness run,
      bit-identical to `45d0830eb`. Tasks 1 and 6 both cut into Ruby; this is
      the check that neither drifted.
- [ ] **netbox perf, final.** Wall ≤ +25 %, RSS ≤ +20 % against `45d0830eb`,
      measured on the same machine in the same session. Return inference and the
      two pre-scans run ONCE per file in pass 1; if the wall moved more than
      that, the suspect is the `hasSubtypes` descendant scan in Task 6 (memoise
      it) or the `localCallBindings` walk in Task 3 (it must not descend nested
      scopes twice).
- [ ] **Navigators.** `python/CLAUDE.md` gains: the `ast` source's silence
      contract, the fact that `localCallBindings` is folded at RESOLVE time and
      why, the MRO-through-`memberTypeOf` rule and its own-class-first order,
      and the module-scope-wins rule for bare calls. Each one LINKS to the
      path-scoped rule rather than restating it, and each fact appears once.
      `language/CLAUDE.md` gains one line naming `kernel/return-inference.ts`
      and `kernel/naming-convention.ts` as the two new relocated engines, beside
      the existing `ancestor-walk` and `receiver-type-propagation` entries.
- [ ] **Capability descriptor.** Python's `capability.ts` advertises what the
      resolver can answer; add the four new receiver shapes (call-bound local,
      inherited field, module receiver, same-file bare call) and — only if it
      shipped — the naming convention. Do not advertise a strategy the A/B
      deleted.
- [ ] **Beads.** One comment per task on `9fgdi` carrying its A/B table. Any
      test pinned to a now-different answer names the row and the corpus in that
      comment. If Task 6 was dropped, its bead comment records the phantom
      numbers that dropped it — that measurement is the deliverable, not a
      failure.
- [ ] Commit: `docs(language): record the Python recall-frontier seam (9fgdi)`.

---

## What this plan does not make concrete

- **The dict-iteration element type (Task 7).** Whether `TypeRef`'s container
  form can carry a mapping's KEY as well as its VALUE was not verified; the task
  says to check and to decline dict iteration if it cannot. The 46 polar `index`
  rows the convention answers are unaffected either way.
- **`findPythonImportBinding`'s module-path field (Task 5).** The strategy needs
  a module path for an `import a.b` / `... as alias` form; whether the existing
  helper exposes one was not read. The task says to extend it there rather than
  re-parse import text, so `importedName` and `moduleReceiver` cannot disagree
  about what an import binds.
- **`AncestorLinearizer#linearize`'s exact return shape (Task 4).** The code
  assumes an iterable of class keys starting with the class itself. Seam 4's
  `python-ancestor-policy.ts` is the authority; adapt the loop, not the rule.
- **Where `localCallBindings` is absorbed in `run-state.ts`.** "Beside
  `localBindings`, per chunk" is the instruction; the exact line was not read.
- **Whether R1a (Task 2) pays for itself on its own.** Its recall arrives
  through Task 3, and the A/B for Task 2 in isolation may read as noise. The
  gate on it is therefore the channel-size delta plus zero regression, not a
  recall number.
