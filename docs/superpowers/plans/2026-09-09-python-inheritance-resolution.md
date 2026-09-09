# Python Inheritance Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teach the Python resolver that a member can live on an ANCESTOR. Three
call shapes currently stop at the class they can see — `self.member()`
(`selfMember`), `Cls.member()` (`constant`, resolved by `importedName`), and
`super().member()` — and each one walks a hierarchy that the walker records as
at most ONE base per class. The language-neutral half of the ancestor walk moves
out of Ruby into `src/core/domains/language/kernel/ancestor-walk.ts`; Ruby keeps
every export it has today as a thin adapter; Python supplies a C3 linearization
policy over a `classAncestors` channel the Python walker starts emitting. This
is E2 seam 4.

**Architecture:** Relocation for the engine, net-new for the policy. The kernel
gains ONE file holding the recursion, the per-path cycle guard, the
already-reachable dedupe filter, the per-run memo, and the first-definition-wins
member scan. Everything about ORDER stays with the language: Ruby's
module-insertion rule (`prepend`s, then the class, then `include`s ranked
last-declared-nearest, then the superclass chain) and Python's C3 merge are two
different answers to the same question and neither is neutral. Python's side is
three new files plus a walker change: `classAncestors` keyed
`<relPath>::<dotted FQ>` with import-qualified base spellings, a C3 policy that
turns those spellings into class keys, and one shared inherited-member helper
that `selfMember`, `importedName` and `super` all call.

**Tech Stack:** TypeScript (NodeNext, `strict`), vitest, tsx for the corpus
harnesses. New code in `src/core/domains/language/kernel/`,
`src/core/domains/language/python/resolver/`, and
`src/core/domains/language/python/walker/walker.ts`.

**Spec:**
`docs/superpowers/specs/2026-09-03-python-codegraph-unification-program-design.md`
— "Relocation protocol" (a neutral body moves byte-identically or the cut
moves), "Decision records", and the E2 row for inheritance. Sibling seams:
`docs/superpowers/plans/2026-09-09-receiver-type-propagation-kernel.md` (E1/E2
seam 3, the format and the Ruby parity gate this plan reuses),
`docs/superpowers/plans/2026-09-08-python-import-file-mapper.md` (the
three-state `project` / `external` / `unknown` verdict this plan's boundary
rules are built on).

---

## Decision record

### E2 seam 4 — Python inheritance resolution (`9fgdi`)

**1. The measured target is inherited members, and it is the largest single
recall block left on `selfMember`.** Row-level classification of every
`verdict=="missed"` row in the E0.9 oracle output, by opening the caller's class
header in the corpus and comparing the enclosing class against
`oracleTargetSymbolId`'s class:

| Corpus                                | (a) inherited from a PROJECT ancestor | (b) inherited from an EXTERNAL base | (c) own class, missed for another reason | (d) no oracle symbol id / unclassified |
| ------------------------------------- | ------------------------------------- | ----------------------------------- | ---------------------------------------- | -------------------------------------- |
| netbox `selfMember` missed, 937 rows  | **672 (71.7 %)**                      | 0 in this bucket — see below        | 144 (15.4 %)                             | 121 (12.9 %) + 1 unclassified          |
| polar `selfMember` missed, 1,449 rows | **866 (59.8 %)**                      | 0 in this bucket                    | 487 (33.6 %)                             | 60 (4.1 %) + 36 unclassified           |
| polar `constant` missed, 1,663 rows   | **1,663 (100 %)**                     | 0                                   | 0                                        | 0                                      |

Sources: `/Users/artk0re/.claude/jobs/dffe3647/tmp/e09/after-netbox.ndjson` and
`.../full-b1.ndjson` (polar, seeded). netbox's 937 split `820 miss` +
`117 noInProjectDef`; polar's 1,449 split `1,377 miss` + `72 noInProjectDef`.
Rows are call-SITE rows and a site that falls in two overlapping chunks is
emitted twice — 937 rows are 737 distinct sites on netbox, 1,449 are 848 on
polar. The shares are computed over rows because every rate the oracle prints
is, so they are directly comparable to the gate numbers; the absolute counts are
inflated where chunks overlap.

**(b) is empty on purpose, and that is the precision half of this seam.** A
`self.save()` on a Django model resolves, for jedi, into site-packages, so the
row is scored `agreeExternal` (netbox 540 `selfMember` rows, polar 193) and
never enters the `missed` bucket. Those rows are green TODAY because
`PythonSelfMemberSymbolResolutionStrategy` DROPs on a miss. An ancestor walk
that fabricates a project target for an externally-inherited member converts
540 + 193 agreements into phantoms. The external boundary in decision 4 exists
for exactly those rows.

**(c) is not this seam's target and must not be swept into it.** Sampling it:
`netbox/core/api/views.py:121` calls `self.get_data()` inside `BaseRQViewSet`,
which declares `def get_data(self)` twelve lines above — the enclosing class IS
the defining class and today's `walkClassExtendsForMethod` should already find
it. polar's 487 are the same shape on `EmitterBase` / `PythonEmitter`. Something
upstream of inheritance is losing these (chunk scope, decorator wrapping, or the
class-key mismatch decision 5 fixes). The class-key change in Task 2 may take
some of them incidentally; nothing in this plan is designed for them and the
gate does not credit them.

**(d) is `oracleTargetSymbolId: null` — the oracle knows the file, not the
symbol.** `self.serializer_class(...)` is a class ATTRIBUTE invoked as a
callable, not a method. Decision 6 keeps them out of scope.

**2. The Python walker records ONE base per class, and for polar it records
NONE.** `collectPythonClassExtends` (`python/walker/walker.ts:273`) takes
`supers.namedChildren.find(c => c.type === "identifier" || "attribute" || "dotted_name")`
— the FIRST base, and only if it is one of those three node types. Two
consequences, both visible in the table above:

- netbox `class ProviderView(GetRelatedModelsMixin, generic.ObjectView)` keeps
  `GetRelatedModelsMixin` and drops `generic.ObjectView`; 43 of its 672 are that
  exact declaration. The mixin-first corpora (`APITestCase` 235,
  `ModelViewTestCase` 221) lose their second and third bases the same way.
- polar
  `class AccountRepository(RepositorySoftDeletionIDMixin[Account, UUID], RepositorySoftDeletionMixin[Account], RepositoryBase[Account])`
  declares every base as a `subscript` node, which the filter skips entirely, so
  the class has NO recorded base at all. `RepositoryBase` and
  `RepositorySoftDeletionMixin` are 820 of polar's 866 inherited misses and
  `RepositoryBase.from_session` alone is the target of most of the 1,663
  `constant` misses.

So this seam needs a channel before it needs an algorithm. The walker emits
`classAncestors` — the same run-global channel Ruby already fills, accumulated
by `RunState` at `run-state.ts:1070` and handed to the resolver by
`ResolutionRunner#buildResolverInputs` (`resolution-runner.ts:207`) with no
runner change. `classExtends` stays exactly as it is: `python-self-field.ts` and
`shared.ts`'s `pythonTypeOwnsMembers` both read it and neither is in scope.

**3. Class keys are file-qualified; ancestor VALUES are import-qualified.** Two
`Base` classes in two files must not conflate, and `classAncestors` is
run-global, so a bare class name cannot be the key. The key is

```
`${relPath}::${[...enclosingClassScope, className].join(".")}`
```

— `server/polar/kit/repository/base.py::RepositoryBase`,
`netbox/core/api/views.py::Outer.Inner`. The caller side reconstructs it as
`` `${ctx.callerFile}::${ctx.callerScope.join(".")}` ``, which is exact:
`callerScope` holds class containers only (`pythonKernel.scopeContainerTypes` is
`["class_definition"]`), so it IS the dotted FQ.

The VALUES are base spellings carrying the DEFINING file's import binding,
applied at extraction time:

| Declaration in the file                           | Emitted value                           |
| ------------------------------------------------- | --------------------------------------- |
| `class C(Base)` + `from a.b import Base`          | `a.b::Base`                             |
| `class C(Base)` + `from .base import Base`        | `.base::Base`                           |
| `class C(db.Model)` + `import db`                 | `db::Model`                             |
| `class C(db.Model)` + `from django import db`     | `django.db::Model`                      |
| `class C(RepositoryBase[Event])` + import         | subscript stripped first, then as above |
| `class C(Base)` with no import binding for `Base` | `Base` (bare — same file, or a builtin) |

This is what makes the linearization CALLER-INDEPENDENT and therefore memoizable
once per run. Resolving a bare base through the CALLER's imports would make
`MRO(RepositoryBase)` depend on which file asked, and the memo in decision 7
would be wrong. The `::` separator is the same one the key uses and splits
cleanly; a dotted `a.b.Base` does not, because `Outer.Inner` is a legal class
FQ.

**4. Python's policy is C3 with two boundary flavours, mapped from the import
mapper's three states.** `linearizePythonC3` computes
`L(C) = [C] + merge(L(B1), …, L(Bn), [B1, …, Bn])` over the resolved base keys.
A base that does not resolve to a project class key is NOT in the order; it sets
a flag on the result instead:

| Base resolves to                                                                                        | Order | Flag               |
| ------------------------------------------------------------------------------------------------------- | ----- | ------------------ |
| a project class key                                                                                     | in    | —                  |
| mapper says `external`, or a builtin base (`object`, `Protocol`, `ABC`, `Exception`, `Enum`, `Generic`) | out   | `externalBoundary` |
| `unknown` — mapper cannot tell, or `resolveTypeFile` finds >1 candidate it cannot narrow                | out   | `unknownBoundary`  |

The two flavours are the whole precision argument and they are NOT
interchangeable — see decision 5. When the C3 merge has no good head (an
inconsistent hierarchy: `class D(B, C)` where B and C order two shared bases
oppositely), C3 fails and the policy falls back to left-to-right DFS with
first-occurrence-wins dedupe, increments a `linearizationFallback` counter on
the linearizer, and the flags carry through unchanged. Silent fallback is not
acceptable — the counter is printed by the Task 5 gate.

**5. Terminal verdicts, per consumer.** `findMemberInAncestorChain` returns
`{ target, closure }` where `closure` is `"closed"` (every branch ended on a
project class with no further bases), `"external"` or `"unknown"`. The three
consumers read it the same way:

| Result                                           | `selfMember`               | `importedName` class-receiver | `super`          |
| ------------------------------------------------ | -------------------------- | ----------------------------- | ---------------- |
| exactly one defining class in the order          | `resolved`                 | `resolved`                    | `resolved`       |
| no definition, `closure === "external"`          | `DROP`                     | `DROP`                        | `DROP`           |
| no definition, `closure === "closed"`            | `DROP`                     | `DROP`                        | `DROP`           |
| no definition, `closure === "unknown"`           | `CONTINUE`                 | `CONTINUE`                    | `DROP`           |
| enclosing class key absent from `classAncestors` | `DROP` (today's behaviour) | `CONTINUE` (today's)          | `DROP` (today's) |

`closed` DROPs rather than CONTINUEs, and that is a deliberate reading of the
brief's "none → CONTINUE". Today `selfMember` DROPs on EVERY miss (bd `yrs0`),
and those DROPs are what earn the 540 netbox + 193 polar `agreeExternal` rows. A
blanket CONTINUE hands each of them to `globalShortName`, which is 9,892 of the
E0 baseline's 12,869 phantoms. The only NEW fall-through this plan opens is
`unknown`: a hierarchy we could not finish reading is not evidence that the
member is absent. `super` never CONTINUEs — it is the one guard pass whose
fall-through is a known false-edge family (bd `pic4` / `4rgg`).

**6. Member spelling: instance `#` first, class `.` second, attributes never.**
`classifyMethod` (`infra/symbolid`, wired through
`pythonKernel.isInstanceMethod`) files an undecorated `def` inside a class as
`instance` and a `@classmethod` / `@staticmethod` one as class-level, so the
symbol table holds `Cls#m` and `Cls.m` respectively. The evidence carries both
spellings: netbox's `selfMember` targets are
`GetRelatedModelsMixin#get_related_models`, polar's `constant` targets are
`RepositoryBase.from_session`. At each class in the order the lookup tries
`${classFq}#${member}` then `${classFq}.${member}`, exactly as
`walkClassExtendsForMethod` does today, and `classFq` is the DOTTED half of the
class key — the symbol table is keyed by FQ, not by class key. Django-style
`Meta` inner classes and `objects` managers are attributes, not methods; nothing
here fabricates a member for them, and the 121 + 60 `oracleTargetSymbolId: null`
rows stay missed.

**7. The MRO is computed once per class per run.** `createAncestorLinearizer`
returns an object holding a `Map<string, LinearizedAncestors>` memo and is built
ONCE per resolver, off the run-global `classAncestors` map, the same way
`PythonCallResolver` owns exactly one `PythonImportFileMapper`. Only the
TOP-LEVEL entry point memoizes: the inner recursion carries a per-path cycle
guard, so its results are path-dependent in a cyclic hierarchy and caching them
would leak one branch's truncation into another. netbox has ~3,600 classes and
~30,000 `self.` call sites; without the memo the walk runs per call site and the
+25 % wall gate in decision 9 is unreachable.

**8. `super()` is normalized in the walker, not in the classifier (bd
`ntnke`).** `classifyReceiverKind`
(`trajectory/codegraph/symbols/receiver-kind.ts:41`) matches
`SUPER_MARKERS = new Set(["super", "<super>"])`. The Python walker emits the
receiver text `"super()"`, which matches neither, so every `super()` call site
is filed under `dynamic`: netbox 1,446 rows (676 `agreeExternal`, 323
`bothUnresolved`, 286 `missed`, 145 `match`, 9 `skippedInProject`, 4
`chainOnly`, 3 `phantom`), polar 1,242 rows (670 `missed`, 447 `agreeExternal`,
60 `match`, 51 `bothUnresolved`, 9 `phantom`, 3 `fileOnly`, 2
`skippedInProject`). The fix is in the walker: emit the bare text `super` for a
`super()` receiver.

Walker, not classifier, for three reasons. The classifier is shared by every
language and is documented as an instrument rather than a contract participant —
widening its regex to `/^super\s*\(/` makes every language's tally depend on one
language's spelling. `PythonSuperSymbolResolutionStrategy` already accepts BOTH
`"super()"` and `"super"` (`python-super.ts:31`), so the resolver needs no
change and the normalization is observable only in the receiver-kind tally. And
`scripts/lib/py-oracle-core.ts`'s `isSuperCallSite` already compensates with a
`/^super\s*\(/` text probe plus a `facts.isSuperCall` channel — three ways of
asking one question, two of them workarounds for a spelling the walker can
simply stop producing.

The cost is a walker-version bump: `python/capability.ts:12`
`versions: { chunking: 1, walker: 2, codegraphSchema: 2 }` → `walker: 3`, and a
reindex for any project that wants the new spelling. There is NO lockstep test
pin to move —
`tests/core/domains/maintenance/language-version-drift-monitor.test.ts`,
`tests/core/api/internal/ops/indexing-ops-language-versions.test.ts` and
`tests/core/domains/maintenance/registry/collection-registry.language-versions.test.ts`
all pin `typescript` only. Verify with `/usr/bin/grep -rn "walker: 2" tests src`
before and after; the only hit that should change is `capability.ts`.

`super(Cls, self)` (the explicit two-argument form) is NOT normalized. Its first
argument names the class the walk starts after, which is not always the
enclosing class, and no corpus row in the E0.9 output uses it. It keeps its
verbatim receiver text and stays `dynamic`.

**9. Gates.** Unit:
`npx vitest run tests/core/domains/language/kernel/ancestor-walk.test.ts tests/core/domains/language/python`
green, with the C3 diamond, an inconsistent hierarchy, exact `targetSymbolId`
assertions, the external-boundary DROP, the unknown-boundary CONTINUE, and
`super()` after normalization. Ruby:
`scripts/spikes/ruby-resolver-parity.ts --before-root <worktree>` on mastodon
with `mismatches 0`, plus `npx vitest run tests/core/domains/language/ruby`
reporting the same file and pass counts as before Task 1. Row-level oracle A/B
on netbox + flask + httpx + ugnest (+ polar when E0.11's `PYTHONHASHSEED=0` pin
has landed): gross `lost` 0, `selfMember` missed down by at least 60 % of the
(a) share on each corpus, `phantom` not up, `wrongFile` not up.
`scripts/codegraph-chain-tally.ts` ×5 with drift 0. Perf A/B on netbox: wall ≤
+25 %, RSS ≤ +20 %. `npm run test:coverage` exit 0.

---

## Global Constraints

- **No Ruby test edits, at all.**
  `git diff --stat -- tests/core/domains/language/ruby` must be EMPTY after
  every task. Record the file and pass counts from
  `npx vitest run tests/core/domains/language/ruby` BEFORE Task 1 and compare
  after each. A failing Ruby test means the Ruby policy adapter is wrong — fix
  the adapter, never the test (`.claude/rules/test-invariants.md`).
- **`ruby/resolver/ancestor-linearization.ts` keeps every export it has today.**
  `linearizeAncestors(klass, hierarchy)` and the `RubyAncestorHierarchy`
  interface, same names, same signatures, same semantics. Its importers
  (`ruby-super.ts`, `strategies/shared.ts`'s `ancestorsInMroOrder` /
  `collectResolvedAncestorChain`, and `type-propagation`'s `firstDefinerAfter`
  /`selfMemberReturnType` consumers) keep their import lines byte-identical.
- **Bodies move byte-identically or the cut moves.** Task 1 lists the two cuts
  in `linearize`; there are no others. Where the Ruby body must change shape to
  fit the port signature, only the CALL syntax changes
  (`linearize(x, hierarchy, nextPath)` → `recurse(x)`), never the logic.
- **The kernel never names a language.** `kernel/ancestor-walk.ts` may import
  from `contracts/`. An import from `domains/language/<lang>/` is a
  review-stopping defect. No `::`, no `.` separator assumption, no `prepend`, no
  `include`, no `object` / `BasicObject`, no C3.
- **`classExtends` is not touched.** It stays single-base and stays emitted.
  `python-self-field.ts`, `pythonTypeOwnsMembers` and
  `resolvePythonMemberOnType`'s tail all read it; changing its shape is a
  different seam's work.
- **A `Map` / `Set` never enters a `FileExtraction` or a `CallContext` value.**
  Both cross the NDJSON spill and serialise to `{}`
  (`contracts/types/codegraph-extraction.ts:8-11`). `classAncestors` is a
  `Record<string, readonly string[]>` on both sides. Maps are fine as locals and
  inside the linearizer's memo, which never crosses the spill.
- **No allocation per call site in the walk.** The linearizer is built once per
  resolver and the policy is a module-level factory result, not a per-call
  closure. A cached MRO is returned by reference; consumers must not mutate it.
- **Seam 3 (`9fgdi`, receiver type propagation) is landing in parallel and owns
  three of the files this plan touches.** `python-imported-name.ts`,
  `python-import-match.ts` and `strategies/shared.ts` are being edited
  concurrently. Nothing in Tasks 1, 2, 4 or 5 depends on those edits. Task 3 has
  ONE integration point in `python-imported-name.ts`, marked
  `INTEGRATION POINT (seam 3)` in the step text: rebase onto seam 3's landed
  code before making it, and if `strategies/shared.ts` already carries
  `resolvePythonMemberOnType` with a different body than the one quoted here,
  the quoted body is stale — take the landed one and add the ancestor call
  beside it.
- **Read the whole file before editing it.** `python/walker/walker.ts` is over
  600 lines and `strategies/shared.ts` is 264; read them in slices, never edit
  from a search hit.

---

## File Structure

**Created**

| File                                                                                     | Single responsibility                                                                                                                                      |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/domains/language/kernel/ancestor-walk.ts`                                      | `AncestorLinearizationPolicy`, `createAncestorLinearizer`, `findMemberInAncestorChain` — recursion, cycle guard, dedupe, memo, first-definition-wins scan. |
| `src/core/domains/language/python/resolver/python-ancestor-policy.ts`                    | `createPythonAncestorPolicy` — C3 merge, base-spelling → class-key resolution, boundary flags, fallback counter.                                           |
| `tests/core/domains/language/kernel/ancestor-walk.test.ts`                               | Neutral engine with hand-built policies: cycle guard, dedupe, memo identity, member scan, `startAfter`.                                                    |
| `tests/core/domains/language/python/resolver/python-ancestor-policy.test.ts`             | C3 order incl. the classic diamond and an inconsistent hierarchy; key shapes; boundary flags.                                                              |
| `tests/core/domains/language/python/walker/class-ancestors.test.ts`                      | Walker emission: multi-base, subscript base, dotted base, import qualification, nested-class key, `super` receiver text.                                   |
| `tests/core/domains/language/python/resolver/strategies/python-inherited-member.test.ts` | `selfMember` / `importedName` / `super` on the MRO — exact `targetSymbolId`, DROP and CONTINUE verdicts.                                                   |

**Modified**

| File                                                                           | Change                                                                                                                    |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `src/core/domains/language/ruby/resolver/ancestor-linearization.ts`            | `linearize`'s body becomes `RUBY_ANCESTOR_POLICY.order`; `linearizeAncestors` delegates to the kernel. Exports unchanged. |
| `src/core/domains/language/python/walker/walker.ts`                            | `collectPythonClassAncestors` + `out.classAncestors`; `super()` receiver text normalized to `super`.                      |
| `src/core/domains/language/python/capability.ts`                               | `walker: 2` → `walker: 3`.                                                                                                |
| `src/core/domains/language/python/resolver/python-resolver.ts`                 | Builds the one `AncestorLinearizer` and hands it to the chain factory.                                                    |
| `src/core/domains/language/python/resolver/python-chain-factory.ts`            | Threads the linearizer into `selfMember`, `importedName` and `super`. No reordering.                                      |
| `src/core/domains/language/python/resolver/strategies/shared.ts`               | Gains `pythonClassKey`, `parsePythonClassKey`, `resolvePythonInheritedMember`.                                            |
| `src/core/domains/language/python/resolver/strategies/python-self-member.ts`   | Enclosing-class key + `resolvePythonInheritedMember`; verdicts per decision 5.                                            |
| `src/core/domains/language/python/resolver/strategies/python-super.ts`         | `resolveSuper` walks the MRO after the enclosing class instead of the `classExtends` chain.                               |
| `src/core/domains/language/python/resolver/strategies/python-imported-name.ts` | INTEGRATION POINT — the class-receiver lookup falls back to `resolvePythonInheritedMember`.                               |
| `scripts/codegraph-chain-tally.ts`, `scripts/py-codegraph-jedi-oracle.ts`      | `buildCallContext` / `walkCorpus` thread the run-global `classAncestors` merge.                                           |
| `src/core/domains/language/CLAUDE.md`                                          | Navigator: where the ancestor walk lives, what a policy owes it.                                                          |
| `src/core/domains/language/ruby/CLAUDE.md`                                     | Pointer: the driver moved, the ordering rule did not.                                                                     |
| `src/core/domains/language/python/CLAUDE.md`                                   | The class-key shape, the ancestor-value spelling, the boundary flavours.                                                  |

---

## Context the implementer needs

### The channels, exactly as they exist today

`CallContext` (`contracts/types/codegraph.ts`) carries, among others:

```ts
callerFile: string;              // relPath of the file holding the call
callerScope: string[];           // class containers only, outermost first
callerSymbolId: string;
symbolTable: SymbolTable;        // lookup(fq) / lookupByShortName(name)
imports: ImportRef[];            // { importText, startLine, importedNames?, importedBindings? }
classAncestors?: Record<string, readonly string[]>;   // run-global, TODAY Ruby-only
classExtends?: Record<string, string>;                // Python: bare name → first base
classFieldTypes?: Record<string, Record<string, string>>;
```

`symbolTable.lookupByShortName(name)` returns
`{ relPath, symbolId, scope: string[] }[]`; `scope` is the enclosing CLASS
chain, so a class definition's own FQ is `[...scope, shortName].join(".")`.
`symbolTable.lookup(fq)` takes the composed FQ (`Cls#member`, `Cls.member`,
`Outer.Inner#member`).

`FileExtraction` (`contracts/types/codegraph-extraction.ts`) already declares
`classAncestors?: Record<string, readonly string[]>` — Ruby fills it, Python
does not. `RunState.write` merges it at `run-state.ts:1070` and
`hasRunGlobalEntries("ancestors")` flips on the first contribution, so a
Python-only run starts seeing a populated map the moment the walker emits one.
NO change is needed in `run-state.ts` or `resolution-runner.ts`.

### The Ruby engine, function by function

`src/core/domains/language/ruby/resolver/ancestor-linearization.ts`, 108 lines,
ZERO imports by design (a cycle through `strategies/shared.ts` breaks
`type-propagation.ts`'s top-level const init — the module docblock says so).
That constraint survives: the kernel file must also have zero imports beyond
type-only ones.

| Symbol                                        | Verdict                                                                                                                                                                                                 |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| module docblock                               | Stays. Gains two sentences: the driver moved, the ordering rule did not.                                                                                                                                |
| `RubyAncestorHierarchy`                       | Ruby. Stays exported — it is the structural shape a `CallContext` satisfies.                                                                                                                            |
| `linearizeAncestors(klass, hierarchy)`        | Signature stays; body becomes one delegation into the kernel.                                                                                                                                           |
| `linearize(klass, hierarchy, path)`           | **CUT 1** — the guard and the `nextPath` construction move to the kernel; everything from `const superclass` to the `return` becomes the body of `RUBY_ANCESTOR_POLICY.order`, character-for-character. |
| `insertable(mixin, hierarchy, path, present)` | **CUT 2** — **Neutral. Moves** to the kernel and is handed to the policy as a closure.                                                                                                                  |

**CUT 1.** These four lines and only these four leave `linearize`:

```ts
function linearize(klass: string, hierarchy: RubyAncestorHierarchy, path: ReadonlySet<string>): string[] {
  if (path.has(klass)) return [];
  const nextPath = new Set(path).add(klass);
```

The remainder — the `superclass` / `tail` pair, the `includes` loop with its
`if (mixin === superclass) continue;`, the `prepends` loop, and
`return [...prepends, klass, ...includes, ...tail];` — becomes `order`'s body
with two mechanical substitutions and no others:

- `linearize(superclass, hierarchy, nextPath)` → `recurse(superclass)`
- `insertable(mixin, hierarchy, nextPath, [regions])` →
  `insertable(mixin, [regions])`

`hierarchy` reaches the policy as its `ctx` argument. `nextPath` is gone because
the kernel holds it.

**CUT 2.** `insertable`'s body moves verbatim; only its signature loses
`hierarchy` and `path` (the kernel closes over both) and its
`linearize(mixin, hierarchy, path)` call becomes the kernel's own recursion.

### What stays Ruby-specific and must NEVER reach the kernel

`ruby-super.ts` and `strategies/shared.ts` keep every one of these:
`RUBY_RUNTIME_HOOKS` and the file-only suppression it drives;
`SUPER_RECEIVER_SENTINEL` (`"<super>"`); the `callerScope.join("::")` key;
`resolveViaIncludingClasses` and the `includedBy` reverse index;
`resolveInstanceMethodInClassChain`'s `prepended` pre-pass and its
`preferDeclaredOverSchemaColumn` / `includeSchemaColumns` schema-column
handling; `resolveConstant` and `canonicalizeAncestorFq`; `ancestorsInMroOrder`
and `collectResolvedAncestorChain`. Ruby's own MEMBER walk
(`resolveInstanceMethodInClassChain`) is NOT relocated in this seam — it is
entangled with the schema-column preference and the file-only fallback ordering,
and the kernel's `findMemberInAncestorChain` is a second, simpler scan that only
Python calls. Task 5 records that as known duplication with a bead, rather than
forcing a cut that would move Ruby behaviour.

### The Python call sites this seam changes

```ts
// python-self-member.ts, today
const enclosing = ctx.callerScope[ctx.callerScope.length - 1]; // BARE name
const target = walkClassExtendsForMethod(
  enclosing,
  call.member,
  ctx,
  this.cfg.mode,
);
return target ? resolved(target) : DROP;

// python-super.ts, today — single-inheritance chain, bare names
let current: string | undefined = ctx.classExtends[enclosing];
// then `${current}#${member}` / `${current}.${member}` and `current = ctx.classExtends[current]`

// python-imported-name.ts:80, today — own class only, no ancestors
const wanted = call.receiver
  ? [
      `${binding.importedName}.${call.member}`,
      `${binding.importedName}#${call.member}`,
    ]
  : [call.member];
```

---

## Task 1 — Kernel ancestor walk + Ruby adapter + Ruby parity gate

**Files**

- Create `src/core/domains/language/kernel/ancestor-walk.ts`
- Create `tests/core/domains/language/kernel/ancestor-walk.test.ts`
- Modify `src/core/domains/language/ruby/resolver/ancestor-linearization.ts`

**Interfaces introduced**

```ts
export type AncestorClosure = "closed" | "external" | "unknown";

export interface AncestorLinearizationPolicy<TCtx> {
  order(
    classKey: string,
    ctx: TCtx,
    recurse: (ancestor: string) => string[],
    insertable: (
      ancestor: string,
      present: readonly (readonly string[])[],
    ) => string[],
  ): string[];
  boundaryOf?(classKey: string, ctx: TCtx): AncestorClosure;
}

export interface LinearizedAncestors {
  readonly order: readonly string[];
  readonly closure: AncestorClosure;
}

export interface AncestorLinearizer<TCtx> {
  linearize(classKey: string): LinearizedAncestors;
}

export interface AncestorMemberScan<TTarget> {
  readonly target: TTarget | null;
  readonly definingClassKey: string | null;
  readonly closure: AncestorClosure;
}
```

**Steps**

- [ ] Record the Ruby baseline before touching anything. Run
      `npx vitest run tests/core/domains/language/ruby` and write the reported
      "Test Files N passed" and "Tests M passed" numbers into the task notes.
      Every later step compares against them.
- [ ] Read `src/core/domains/language/ruby/resolver/ancestor-linearization.ts`
      end to end (108 lines). It has ZERO imports on purpose — a cycle through
      `strategies/shared.ts` breaks `type-propagation.ts`'s top-level const
      init. The kernel file inherits that constraint.
- [ ] Create `src/core/domains/language/kernel/ancestor-walk.ts` with the module
      docblock stating: this is the language-NEUTRAL half of an ancestor walk —
      the recursion, the per-path cycle guard, the already-reachable dedupe, the
      per-run memo and the first-definition-wins member scan. ORDER is not
      neutral: Ruby's module-insertion rule and Python's C3 merge are two
      different answers, and each language supplies one as an
      `AncestorLinearizationPolicy`. Zero runtime imports.
- [ ] Add the four types above, then the engine:

```ts
const CLOSURE_RANK: Record<AncestorClosure, number> = {
  closed: 0,
  unknown: 1,
  external: 2,
};

/** Precision-first join: an external boundary anywhere makes the whole answer external. */
function joinClosure(a: AncestorClosure, b: AncestorClosure): AncestorClosure {
  return CLOSURE_RANK[b] > CLOSURE_RANK[a] ? b : a;
}

export function createAncestorLinearizer<TCtx>(
  ctx: TCtx,
  policy: AncestorLinearizationPolicy<TCtx>,
): AncestorLinearizer<TCtx> {
  // Only the TOP-LEVEL entry memoizes. The inner recursion carries a per-PATH
  // guard, so its result is path-dependent in a cyclic hierarchy and caching it
  // would leak one branch's truncation into another.
  const memo = new Map<string, LinearizedAncestors>();

  const walk = (
    classKey: string,
    path: ReadonlySet<string>,
    seen: Set<string>,
  ): string[] => {
    if (path.has(classKey)) return [];
    const nextPath = new Set(path).add(classKey);
    seen.add(classKey);
    const recurse = (ancestor: string): string[] =>
      walk(ancestor, nextPath, seen);
    const insertable = (
      ancestor: string,
      present: readonly (readonly string[])[],
    ): string[] =>
      recurse(ancestor).filter(
        (name) => !present.some((region) => region.includes(name)),
      );
    return policy.order(classKey, ctx, recurse, insertable);
  };

  return {
    linearize(classKey: string): LinearizedAncestors {
      const hit = memo.get(classKey);
      if (hit !== undefined) return hit;
      const seen = new Set<string>();
      const order = walk(classKey, new Set(), seen);
      let closure: AncestorClosure = "closed";
      if (policy.boundaryOf !== undefined) {
        for (const visited of seen)
          closure = joinClosure(closure, policy.boundaryOf(visited, ctx));
      }
      const result: LinearizedAncestors = { order, closure };
      memo.set(classKey, result);
      return result;
    },
  };
}
```

- [ ] Add the member scan in the same file. `lookup` is the caller's — the
      kernel never touches a symbol table:

```ts
/**
 * The FIRST class in `classKey`'s linearization that owns `member`, per
 * `lookup`. `startAfter` skips the linearization up to and INCLUDING
 * `classKey`'s own position — the `super` semantics, where dispatch begins at
 * the next entry, never the enclosing class itself.
 */
export function findMemberInAncestorChain<TCtx, TTarget>(
  classKey: string,
  linearizer: AncestorLinearizer<TCtx>,
  lookup: (candidateKey: string) => TTarget | null,
  options: { readonly startAfter?: boolean } = {},
): AncestorMemberScan<TTarget> {
  const { order, closure } = linearizer.linearize(classKey);
  const self = order.indexOf(classKey);
  const from =
    options.startAfter === true ? (self === -1 ? order.length : self + 1) : 0;
  for (let i = from; i < order.length; i++) {
    const target = lookup(order[i]);
    if (target !== null) return { target, definingClassKey: order[i], closure };
  }
  return { target: null, definingClassKey: null, closure };
}
```

- [ ] Rewrite `ruby/resolver/ancestor-linearization.ts` as the Ruby adapter. The
      docblock keeps every existing sentence and gains: "The driver — the
      recursion, the per-path guard, the dedupe filter — now lives in
      `kernel/ancestor-walk.ts`. What stays here is the ORDER, which is Ruby's
      module-insertion rule and nothing a kernel could guess." `import type`
      only, so the zero-runtime-imports constraint holds:

```ts
import {
  createAncestorLinearizer,
  type AncestorLinearizationPolicy,
} from "../../kernel/ancestor-walk.js";

const RUBY_ANCESTOR_POLICY: AncestorLinearizationPolicy<RubyAncestorHierarchy> =
  {
    order(klass, hierarchy, recurse, insertable) {
      // The superclass chain is built FIRST: in Ruby it already exists when the
      // class body runs, so it is what every `include`/`prepend` in that body checks
      // itself against before inserting.
      const superclass = hierarchy.classExtends?.[klass];
      const tail = superclass === undefined ? [] : recurse(superclass);

      // Includes, declaration order, each inserted at the FRONT of the region — so
      // the last one declared ends up nearest, as Ruby ranks them.
      const includes: string[] = [];
      for (const mixin of hierarchy.classAncestors?.[klass] ?? []) {
        if (mixin === superclass) continue; // already carried by `tail`
        includes.unshift(...insertable(mixin, [includes, tail]));
      }

      // Prepends, same insertion rule, but the region sits BEFORE the class itself.
      const prepends: string[] = [];
      for (const mixin of hierarchy.classPrependedAncestors?.[klass] ?? []) {
        prepends.unshift(...insertable(mixin, [prepends, includes, tail]));
      }

      return [...prepends, klass, ...includes, ...tail];
    },
  };

export function linearizeAncestors(
  klass: string,
  hierarchy: RubyAncestorHierarchy,
): string[] {
  // A FRESH linearizer per call, deliberately: today's `linearize` cached
  // nothing, and a longer-lived memo would have to prove it cannot outlive a
  // mutation of the run-global ancestors map. Ruby pays one extra Map
  // allocation per call and gains nothing else; Python's long-lived linearizer
  // is built once per resolver, where the memo is what makes the walk affordable.
  return [
    ...createAncestorLinearizer(hierarchy, RUBY_ANCESTOR_POLICY).linearize(
      klass,
    ).order,
  ];
}
```

- [ ] Delete the now-relocated private `linearize` and `insertable` from the
      Ruby file. `RubyAncestorHierarchy` stays exported and unchanged;
      `boundaryOf` is NOT supplied, so Ruby's closure is always `"closed"` and
      no Ruby consumer reads it.
- [ ] `npx tsc --noEmit` clean, then
      `npx vitest run tests/core/domains/language/ruby` — SAME file count and
      SAME pass count as the baseline.
      `git diff --stat -- tests/core/domains/language/ruby` must print nothing.
- [ ] Write `tests/core/domains/language/kernel/ancestor-walk.test.ts` against
      hand-built policies, never a real language. Cases: (1) a linear chain
      `C → B → A` returns `[C, B, A]`; (2) a cycle `A → B → A` terminates and
      yields each key once; (3) a diamond under a policy whose `order` is
      depth-first-with-dedupe yields the first-occurrence order; (4) `linearize`
      called twice for one key returns the SAME object (memo identity) and the
      policy's `order` ran once — count calls; (5) `boundaryOf` returning
      `"unknown"` on one branch and `"external"` on another joins to
      `"external"`; (6) `findMemberInAncestorChain` returns the first owner and
      its `definingClassKey`; (7) the same call with `startAfter: true` skips
      the start class even when it owns the member; (8) `startAfter: true` on a
      key absent from its own order (a policy that drops it) scans nothing and
      returns `target: null`.
- [ ] Create the Ruby parity harness IF it does not already exist. Seam 3
      (`docs/superpowers/plans/2026-09-09-receiver-type-propagation-kernel.md`,
      Task 2) creates `scripts/spikes/ruby-resolver-parity.ts`; if that plan has
      landed, use it as-is and skip this step. If it has not, build it to the
      same contract: ONE symbol table and ONE `CallContext` per chunk, TWO
      `RubyCallResolver` instances — the current tree's and one dynamically
      imported from `--before-root` (a sibling `git worktree` pinned at this
      seam's parent commit) — asked the same question at every call site, with a
      row counted as a mismatch when `(targetRelPath, targetSymbolId)` differs.
      Model it on the existing
      `scripts/spikes/ruby-walker-composition-parity.ts`.
- [ ] Run the parity harness on mastodon. **Gate: `mismatches 0`.** A non-zero
      count means CUT 1 or CUT 2 changed behaviour — diff the two orders for a
      mismatching class and fix the policy, never the test.
- [ ] Commit:
      `refactor(language): relocate the ancestor walk into the kernel (9fgdi)`.
      Body ≤ 100 cols, naming both cuts and the mastodon mismatch count.
      `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

## Task 2 — Python `classAncestors` channel, class keys, C3 policy

**Files**

- Modify `src/core/domains/language/python/walker/walker.ts`
- Modify `src/core/domains/language/python/capability.ts`
- Modify `src/core/domains/language/python/resolver/strategies/shared.ts`
- Create `src/core/domains/language/python/resolver/python-ancestor-policy.ts`
- Create `tests/core/domains/language/python/walker/class-ancestors.test.ts`
- Create
  `tests/core/domains/language/python/resolver/python-ancestor-policy.test.ts`

**Steps**

- [ ] Read `collectPythonImports` in `python/walker/walker.ts` and write down
      the EXACT `{ importText, importedNames, importedBindings }` it emits for
      each of: `import a`, `import a.b`, `import a.b as c`, `from a.b import C`,
      `from a.b import C as D`, `from . import x`, `from .mod import Y`. The
      qualification table in decision 3 is the contract; the tests pin it. Do
      not guess — `importText` is a persisted contract (`python/CLAUDE.md`,
      first bullet).
- [ ] Add `qualifyPythonBase` to `python/walker/walker.ts`, private:

```ts
/**
 * A base-class spelling with the DEFINING file's import binding applied, so
 * the resolver can turn it into a class key without the CALLER's imports —
 * which is what makes a linearization memoizable once per run (bd 9fgdi).
 *
 *   `Base`      + `from a.b import Base` → `a.b::Base`
 *   `db.Model`  + `import django.db as db` → `django.db::Model`
 *   `Base`      with no binding → `Base` (same file, or a builtin)
 *
 * `::` and not a dot: `Outer.Inner` is a legal class FQ and would not split.
 */
function qualifyPythonBase(
  baseText: string,
  imports: readonly ImportRef[],
): string {
  const joinModule = (head: string, tail: string): string =>
    head.endsWith(".") ? `${head}${tail}` : `${head}.${tail}`;
  const segments = baseText.split(".");
  const root = segments[0];
  const name = segments[segments.length - 1];
  const middle = segments.slice(1, -1);
  for (const imp of imports) {
    const bound = imp.importedBindings?.[root];
    if (bound === undefined && imp.importedNames?.includes(root) !== true)
      continue;
    // `importedBindings` carries BOTH shapes Python's walker produces: a MODULE
    // PATH (`import a.b` → `{ a: "a.b" }`, `import a.b as db` → `{ db: "a.b" }`)
    // and an EXPORTED MEMBER NAME (`from a.b import C as D` → `{ D: "C" }`).
    // The unaliased `import a.b` case is the trap: the value is the whole
    // module but the NAME binds only its first segment, and it is recognisable
    // because the key IS that first segment.
    const head =
      bound === undefined
        ? joinModule(imp.importText, root)
        : bound.includes(".")
          ? bound === root || bound.startsWith(`${root}.`)
            ? root
            : bound
          : joinModule(imp.importText, bound);
    const parts = head.split(".");
    if (segments.length === 1) {
      // The base IS the bound name: the module is everything before its tail.
      return `${parts.slice(0, -1).join(".")}::${parts[parts.length - 1]}`;
    }
    return `${[...parts, ...middle].join(".")}::${name}`;
  }
  return baseText;
}
```

      Worked examples the walker test pins:
      `Base` + `from a.b import Base` → `a.b::Base`;
      `Base` + `from .base import Base` → `.base::Base`;
      `db.Model` + `import django.db as db` → `django.db::Model`;
      `db.Model` + `from django import db` → `django.db::Model`;
      `a.b.Model` + `import a.b` → `a.b::Model`;
      `Base` with no matching import → `Base`.

- [ ] Add `collectPythonClassAncestors`. It reuses
      `collectPythonInheritanceEdges`' scope walk — same `fq` construction, same
      `superclasses` field — but accepts `subscript` bases and keys by the FULL
      class key:

```ts
/**
 * `class Child(A, M[T])` → `{ "<relPath>::Child": ["a::A", "m::M"] }` (bd 9fgdi).
 *
 * Three things this does that `collectPythonClassExtends` does not, each one a
 * measured miss family: EVERY base rather than the first (netbox
 * `ProviderView(GetRelatedModelsMixin, generic.ObjectView)` loses its second
 * base), `subscript` bases (polar declares every repository base as
 * `RepositoryBase[Account]`, a node type the old filter skipped entirely, so
 * those classes recorded NO base at all), and a FILE-QUALIFIED key so two
 * `Base` classes in two files do not conflate in the run-global map.
 */
function collectPythonClassAncestors(
  root: AstNode,
  relPath: string,
  imports: readonly ImportRef[],
): Record<string, readonly string[]> {
  const out: Record<string, readonly string[]> = {};
  const walkScope = (node: AstNode, scope: string[]): void => {
    if (node.type !== "class_definition") {
      for (const child of node.children) walkScope(child, scope);
      return;
    }
    const nameNode = node.childForFieldName("name");
    if (!nameNode) {
      for (const child of node.children) walkScope(child, scope);
      return;
    }
    const localName = nameNode.text;
    const fq =
      scope.length === 0 ? localName : `${scope.join(".")}.${localName}`;
    const supers = node.childForFieldName("superclasses");
    const bases: string[] = [];
    if (supers) {
      for (const base of supers.namedChildren) {
        // A `subscript` is a generic base: `RepositoryBase[Event]`. Its `value`
        // child is the class; the subscript itself is a type argument and is
        // never part of the hierarchy.
        const named =
          base.type === "subscript" ? base.childForFieldName("value") : base;
        if (!named) continue;
        if (
          named.type !== "identifier" &&
          named.type !== "attribute" &&
          named.type !== "dotted_name"
        )
          continue;
        const text = named.text;
        if (text.length === 0 || text === "object") continue;
        bases.push(qualifyPythonBase(text, imports));
      }
    }
    if (bases.length > 0) out[`${relPath}::${fq}`] = bases;
    const body = node.childForFieldName("body");
    for (const child of body ? body.children : node.children)
      walkScope(child, [...scope, localName]);
  };
  walkScope(root, []);
  return out;
}
```

- [ ] Wire it in `extractFromPythonFile`, next to the existing `classExtends`
      line, and leave `classExtends` alone — `python-self-field.ts` and
      `pythonTypeOwnsMembers` both read it:

```ts
const classAncestors = collectPythonClassAncestors(
  input.tree.rootNode,
  input.relPath,
  imports,
);
// …
if (Object.keys(classAncestors).length > 0) out.classAncestors = classAncestors;
```

- [ ] Bump `python/capability.ts`:
      `versions: { chunking: 1, walker: 3, codegraphSchema: 2 }`. Then
      `/usr/bin/grep -rn "walker: 2" tests src` and confirm the only remaining
      hits name `typescript`. If a Python pin appears, move it.
- [ ] Write `tests/core/domains/language/python/walker/class-ancestors.test.ts`
      BEFORE the policy. Cases, each a real source snippet parsed by the walker:
      multi-base `class C(A, M)`; subscript `class C(Base[T], Mixin[T, U])`;
      dotted `class C(db.Model)` with `import django.db as db`;
      `from .base import Base`; a nested `class Outer: class Inner(Base)` keying
      `<relPath>::Outer.Inner`; `class C(object)` and `class C:` emitting NO
      entry; `class C(Base, metaclass=Meta)` emitting only `Base`.
- [ ] Add the key helpers to `python/resolver/strategies/shared.ts`:

```ts
/** `<relPath>::<dotted class FQ>` — the run-global identity of a Python class. */
export function pythonClassKey(relPath: string, classFq: string): string {
  return `${relPath}::${classFq}`;
}

export function parsePythonClassKey(
  key: string,
): { relPath: string; classFq: string } | null {
  const at = key.lastIndexOf("::");
  if (at <= 0 || at + 2 >= key.length) return null;
  return { relPath: key.slice(0, at), classFq: key.slice(at + 2) };
}
```

- [ ] Create `python/resolver/python-ancestor-policy.ts` with the C3 merge and
      the base resolution. The policy reads `ctx.classAncestors`,
      `ctx.symbolTable` and the mapper — and **never** `ctx.imports`,
      `ctx.callerFile` or `ctx.callerScope`; a base is resolved against its own
      DEFINING file, taken from the owner's class key, which is what keeps the
      memo valid across callers:

```ts
const PYTHON_BUILTIN_BASES = new Set([
  "object",
  "type",
  "Protocol",
  "ABC",
  "ABCMeta",
  "Enum",
  "StrEnum",
  "IntEnum",
  "Exception",
  "BaseException",
  "Generic",
  "NamedTuple",
  "TypedDict",
]);

export interface PythonAncestorPolicy extends AncestorLinearizationPolicy<CallContext> {
  /** C3 gave up on an inconsistent hierarchy this many times — printed by the gate. */
  readonly fallbacks: number;
}

export function createPythonAncestorPolicy(
  mapper: PythonImportFileMapper,
): PythonAncestorPolicy {
  const boundaries = new Map<string, AncestorClosure>();
  let fallbacks = 0;
  const note = (classKey: string, closure: AncestorClosure): void => {
    boundaries.set(
      classKey,
      joinClosure(boundaries.get(classKey) ?? "closed", closure),
    );
  };
  return {
    get fallbacks() {
      return fallbacks;
    },
    boundaryOf: (classKey) => boundaries.get(classKey) ?? "closed",
    order(classKey, ctx, recurse) {
      const parents: string[] = [];
      for (const spelling of ctx.classAncestors?.[classKey] ?? []) {
        const resolvedBase = resolveBaseKey(spelling, classKey, ctx, mapper);
        if (typeof resolvedBase === "string") parents.push(resolvedBase);
        else note(classKey, resolvedBase);
      }
      if (parents.length === 0) return [classKey];
      const sequences = parents
        .map((p) => recurse(p))
        .filter((seq) => seq.length > 0);
      sequences.push(parents);
      const merged = c3Merge(sequences);
      if (merged !== null) return [classKey, ...merged];
      // Inconsistent hierarchy — Python itself raises here. A lookup still has
      // to answer, so fall back to left-to-right DFS with first-occurrence-wins
      // dedupe and COUNT it; a silent fallback is an unmeasured order.
      fallbacks += 1;
      const out = [classKey];
      const seen = new Set<string>([classKey]);
      for (const parent of parents) {
        for (const key of recurse(parent)) {
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(key);
        }
      }
      return out;
    },
  };
}
```

- [ ] `joinClosure` is used above, so export it from `kernel/ancestor-walk.ts`
      alongside `AncestorClosure` — it is neutral lattice arithmetic and both
      the kernel and every policy need the same join. `CLOSURE_RANK` stays
      private.
- [ ] Add `c3Merge`, private to the policy file. Return `null` — never throw —
      when no candidate head is free of every other sequence's tail; the caller
      owns the fallback and the counter:

```ts
/**
 * The C3 merge. Repeatedly take the head of the first sequence that appears in
 * no other sequence's TAIL; append it and strike it from every sequence. `null`
 * when no such head exists — an inconsistent hierarchy, which Python reports as
 * `TypeError: Cannot create a consistent method resolution order`.
 */
function c3Merge(sequences: readonly (readonly string[])[]): string[] | null {
  const pending = sequences.map((seq) => [...seq]);
  const out: string[] = [];
  for (;;) {
    const live = pending.filter((seq) => seq.length > 0);
    if (live.length === 0) return out;
    let head: string | null = null;
    for (const seq of live) {
      const candidate = seq[0];
      if (live.some((other) => other.indexOf(candidate) > 0)) continue;
      head = candidate;
      break;
    }
    if (head === null) return null;
    out.push(head);
    for (const seq of pending) {
      const at = seq.indexOf(head);
      if (at !== -1) seq.splice(at, 1);
    }
  }
}
```

- [ ] Add `resolveBaseKey`, private to the policy file. It returns a class KEY
      on success and an `AncestorClosure` on failure, so the caller never has to
      guess which flavour of "not a project class" it hit:

```ts
function resolveBaseKey(
  spelling: string,
  ownerKey: string,
  ctx: CallContext,
  mapper: PythonImportFileMapper,
): string | AncestorClosure {
  const owner = parsePythonClassKey(ownerKey);
  if (owner === null) return "unknown";
  const at = spelling.lastIndexOf("::");
  if (at === -1) {
    // Unqualified: a builtin, a class in the owner's own file, or a name the
    // walker could not bind to an import.
    if (PYTHON_BUILTIN_BASES.has(spelling)) return "external";
    const matches = ctx.symbolTable.lookupByShortName(spelling);
    const sameFile = matches.filter((def) => def.relPath === owner.relPath);
    if (sameFile.length === 1) {
      return pythonClassKey(
        sameFile[0].relPath,
        [...sameFile[0].scope, spelling].join("."),
      );
    }
    if (matches.length === 1) {
      return pythonClassKey(
        matches[0].relPath,
        [...matches[0].scope, spelling].join("."),
      );
    }
    // Zero matches, or several the run-global table cannot separate. NOT
    // `external`: nothing here proves the base is a library, and the two
    // verdicts DROP and CONTINUE respectively (decision 5).
    return "unknown";
  }
  const moduleText = spelling.slice(0, at);
  const name = spelling.slice(at + 2);
  const mapped = mapper.mapImportToFile(moduleText, owner.relPath, ctx);
  if (mapped.kind === "external") return "external";
  if (mapped.kind !== "project") return "unknown";
  return pythonClassKey(mapped.relPath, name);
}
```

- [ ] Write
      `tests/core/domains/language/python/resolver/python-ancestor-policy.test.ts`.
      Build a `CallContext` by hand with a stub `symbolTable` and a real
      `PythonImportFileMapper` over a small file set. Cases: (1) the classic
      diamond — `D(B, C)`, `B(A)`, `C(A)` — linearizes `[D, B, C, A]`, NOT
      `[D, B, A, C]`; (2) polar's real shape —
      `AccountRepository(RepositorySoftDeletionIDMixin,         RepositorySoftDeletionMixin, RepositoryBase)`
      — puts every mixin before `RepositoryBase` and each appears once; (3) an
      inconsistent hierarchy — `X(A, B)` and `Y(B, A)` with `Z(X, Y)` — returns
      a deduped DFS order and increments `fallbacks` to exactly 1; (4) a cycle
      `A(B)` / `B(A)` terminates, each key once; (5) a base bound to an external
      module yields `boundaryOf === "external"` and the base is absent from the
      order; (6) a base whose short name has two project definitions yields
      `boundaryOf === "unknown"`; (7) two `Base` classes in two files produce
      two distinct keys and do not conflate; (8) a nested base `Outer.Inner`
      resolves to `<relPath>::Outer.Inner`; (9) `linearize` twice for one key
      calls `mapper.mapImportToFile` the same number of times as once (the memo,
      not the mapper's own cache — assert with a counting mapper stub).
- [ ] `npx tsc --noEmit` clean;
      `npx vitest run tests/core/domains/language/python` green. Nothing
      consumes the policy yet, so no resolver behaviour changed — confirm with
      `scripts/codegraph-chain-tally.ts` on flask showing the same per-pass
      counts as before Task 2.
- [ ] Commit:
      `feat(language): emit Python classAncestors and add the C3 policy (9fgdi)`.
      Body ≤ 100 cols naming the walker-version bump and the two miss families
      the emission unblocks.
      `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

## Task 3 — `selfMember` on the MRO, shared helper, `importedName` integration

**Files**

- Modify `src/core/domains/language/python/resolver/strategies/shared.ts`
- Modify `src/core/domains/language/python/resolver/python-resolver.ts`
- Modify `src/core/domains/language/python/resolver/python-chain-factory.ts`
- Modify
  `src/core/domains/language/python/resolver/strategies/python-self-member.ts`
- Modify
  `src/core/domains/language/python/resolver/strategies/python-imported-name.ts`
- Create
  `tests/core/domains/language/python/resolver/strategies/python-inherited-member.test.ts`

**Steps**

- [ ] Write the failing tests first, in `python-inherited-member.test.ts`. Build
      a `CallContext` with a `classAncestors` map in the new key shape. Cases:
      (1) `self.m()` where `m` is on a direct project base → `resolved` with the
      BASE's `targetSymbolId` (`Base#m`), not the caller's class; (2) `self.m()`
      where `m` is on a transitive base two hops up → resolved; (3) netbox's
      real shape —
      `ProviderView(GetRelatedModelsMixin,         generic.ObjectView)` calling
      `self.get_related_models()` → resolves to
      `GetRelatedModelsMixin#get_related_models` even though
      `generic.ObjectView` is external; (4) `self.m()` on a class whose only
      base is external and which defines no `m` → `DROP`, and the outcome is NOT
      `CONTINUE` (this is the 540 netbox `agreeExternal` rows); (5) `self.m()`
      where a base's short name is ambiguous → `CONTINUE`; (6) `self.m()` on a
      class with NO bases that defines no `m` → `DROP`; (7) a `@classmethod`
      target resolves through the `.` spelling (`RepositoryBase.from_session`);
      (8) a nested `Outer.Inner` caller resolves against `Outer.Inner#m`, which
      today's `callerScope[last]` lookup misses; (9) `Cls.m()` through
      `importedName` where `m` is on `Cls`'s base → resolved to the base's
      symbol. Run them; they must FAIL for the stated reason before any
      implementation.
- [ ] Add to `python/resolver/strategies/shared.ts`:

```ts
export interface PythonInheritedMemberResult {
  readonly target: SymbolResolutionTarget | null;
  readonly closure: AncestorClosure;
}

/**
 * `<member>` on `classKey` or the first ancestor in its MRO that owns it (bd
 * 9fgdi). Instance spelling (`Cls#m`) first, class spelling (`Cls.m`) second —
 * `classifyMethod` files an undecorated `def` as instance and a
 * `@classmethod` / `@staticmethod` one as class-level, and the corpora carry
 * both (`GetRelatedModelsMixin#get_related_models`,
 * `RepositoryBase.from_session`).
 *
 * Every lookup is FILTERED BY THE CANDIDATE'S OWN FILE. The class key is
 * file-qualified precisely so two `Base` classes in two files stay apart, and
 * an unfiltered `symbolTable.lookup("Base#m")` would put them back together.
 *
 * `closure` is the caller's evidence for what to do with a miss — see the
 * verdict table in the seam's decision 5. This function never decides.
 */
export function resolvePythonInheritedMember(
  classKey: string,
  member: string,
  ctx: CallContext,
  mode: AmbiguousResolveMode,
  linearizer: AncestorLinearizer<CallContext>,
  options: { readonly startAfter?: boolean } = {},
): PythonInheritedMemberResult {
  const scan = findMemberInAncestorChain(
    classKey,
    linearizer,
    (candidateKey) => {
      const parsed = parsePythonClassKey(candidateKey);
      if (parsed === null) return null;
      for (const spelling of [
        `${parsed.classFq}#${member}`,
        `${parsed.classFq}.${member}`,
      ]) {
        const inFile = ctx.symbolTable
          .lookup(spelling)
          .filter((def) => def.relPath === parsed.relPath);
        const picked = pickSingleCandidate(inFile, mode);
        if (picked)
          return {
            targetRelPath: picked.relPath,
            targetSymbolId: picked.symbolId,
          };
      }
      return null;
    },
    options,
  );
  return { target: scan.target, closure: scan.closure };
}
```

- [ ] Build the ONE linearizer per resolver. In
      `python/resolver/python-resolver.ts`, where `PythonImportFileMapper` is
      already constructed once and shared, construct the policy and the
      linearizer beside it and pass both to `createPythonSymbolResolutionChain`.
      The linearizer's `ctx` is the resolver's own `CallContext`-shaped view; it
      must be created AFTER the pass-1 barrier, where `classAncestors` is
      complete, and never per call site (decision 7).
- [ ] Thread it through `python-chain-factory.ts`. Add ONE optional parameter
      after `mapper` and hand it to the three strategies that take it. Do NOT
      reorder the chain — both offline harnesses call this factory and the order
      IS the precedence argument:

```ts
export function createPythonSymbolResolutionChain(
  cfg: ResolverConfig,
  mapper: PythonImportFileMapper = new PythonImportFileMapper(),
  linearizer?: AncestorLinearizer<CallContext>,
): SymbolResolutionStrategy[] {
  return [
    new PythonSuperSymbolResolutionStrategy(cfg, linearizer),
    new PythonSelfFieldSymbolResolutionStrategy(cfg, mapper),
    new PythonSelfMemberSymbolResolutionStrategy(cfg, linearizer),
    new PythonLocalBindingSymbolResolutionStrategy(cfg, mapper),
    new PythonChainTypeSymbolResolutionStrategy(cfg, mapper),
    new PythonImportedNameSymbolResolutionStrategy(cfg, mapper, linearizer),
    new PythonImportMatchSymbolResolutionStrategy(cfg, mapper),
    new PythonGlobalShortNameSymbolResolutionStrategy(cfg),
  ];
}
```

      `linearizer` is optional and each strategy falls back to its pre-seam
      behaviour when it is absent — that is what keeps a caller that has not
      been updated (an old harness, a single-file test) working unchanged.
      `chainType` at index 4 is seam 3's; if that seam has not landed the line
      is absent and the other seven keep their positions.

- [ ] Rewrite `PythonSelfMemberSymbolResolutionStrategy.attempt`:

```ts
attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
  if (call.receiver !== "self" || ctx.callerScope.length === 0) return CONTINUE;
  // An index written by walker v2 has no `classAncestors` at all. Keep the
  // pre-seam single-base walk for it rather than answering from an empty map.
  if (this.linearizer === undefined || ctx.classAncestors === undefined) {
    const enclosing = ctx.callerScope[ctx.callerScope.length - 1];
    const legacy = walkClassExtendsForMethod(enclosing, call.member, ctx, this.cfg.mode);
    return legacy ? resolved(legacy) : DROP;
  }
  const classKey = pythonClassKey(ctx.callerFile, ctx.callerScope.join("."));
  const { target, closure } = resolvePythonInheritedMember(
    classKey, call.member, ctx, this.cfg.mode, this.linearizer,
  );
  if (target) return resolved(target);
  // `closed` and `external` both DROP: the hierarchy was fully read and does
  // not own the member, so a short-name guess would be the phantom family
  // `globalShortName` is responsible for. Only `unknown` — a hierarchy we
  // could not finish reading — falls through (decision 5).
  return closure === "unknown" ? CONTINUE : DROP;
}
```

      Update the docblock: the walk is now the full MRO, not `classExtends`,
      and the three-way verdict replaces the flat DROP. Keep the bd `yrs0`
      citation — its guard is what decision 5 preserves.

- [ ] **INTEGRATION POINT (seam 3).** In
      `python/resolver/strategies/python-imported-name.ts`, the class-receiver
      arm builds
      `wanted = [`${binding.importedName}.${call.member}`,     `${binding.importedName}#${call.member}`]`
      (line ~80 at the time of writing) and looks those up on the binding's
      file. Rebase onto seam 3's landed version FIRST — that file is being
      edited concurrently and the surrounding variable names may have moved.
      Then, where the `wanted` lookups come back empty and the binding maps to a
      `project` file, add the ancestor fallback:

```ts
// The receiver is a CLASS and the member is not on it — try its MRO. polar's
// `AccountRepository.from_session(...)` is `RepositoryBase.from_session`, and
// that one shape is 1,663 of polar's `constant` misses (bd 9fgdi).
if (this.linearizer !== undefined && mapped.kind === "project") {
  const classKey = pythonClassKey(mapped.relPath, binding.importedName);
  const { target, closure } = resolvePythonInheritedMember(
    classKey,
    call.member,
    ctx,
    this.cfg.mode,
    this.linearizer,
  );
  if (target) return resolved(target);
  if (closure === "external" || closure === "closed") return DROP;
}
```

      `unknown` falls out of the `if` and the pass CONTINUEs exactly as it does
      today — `importedName` is not a guard pass and must not become one.

- [ ] `npx tsc --noEmit` clean; the Task 3 tests green;
      `npx vitest run     tests/core/domains/language/python` green with no
      existing Python test edited. If an existing test pins an answer this seam
      makes MORE precise (a fabricated own-class target where the base is the
      real owner, or a duplicated short-name answer), update the pin and leave a
      comment citing `9fgdi` on the changed line — that is the only permitted
      Python test edit.
- [ ] Commit:
      `feat(language): resolve Python self and class-receiver members through the MRO (9fgdi)`.

---

## Task 4 — `super()` receiver normalization (`ntnke`) and `super` on the MRO

**Files**

- Modify `src/core/domains/language/python/walker/walker.ts`
- Modify `src/core/domains/language/python/resolver/strategies/python-super.ts`
- Modify `tests/core/domains/language/python/walker/class-ancestors.test.ts`
- Modify
  `tests/core/domains/language/python/resolver/strategies/python-inherited-member.test.ts`

**Steps**

- [ ] Find the receiver-text extraction in `collectPythonCalls`
      (`python/walker/walker.ts`). For `super().__init__(name)` the callee is an
      `attribute` whose `object` is a `call` node, and the receiver is recorded
      as that node's verbatim text — `"super()"`. Add the normalization AT THAT
      POINT, not downstream:

```ts
/**
 * A zero-argument `super()` receiver is recorded as the bare text `super` (bd
 * ntnke). `classifyReceiverKind`'s `SUPER_MARKERS` holds `"super"` and
 * `"<super>"`, so the verbatim `"super()"` files every one of these sites under
 * `dynamic` — 1,446 rows on netbox, 1,242 on polar. Normalizing here rather
 * than widening the classifier keeps a shared instrument free of one language's
 * spelling, and `PythonSuperSymbolResolutionStrategy` already accepts both
 * texts, so the resolver needs no change.
 *
 * The explicit two-argument `super(Cls, self)` is NOT normalized: its first
 * argument names the class the walk starts after, which is not always the
 * enclosing class, and no E0.9 corpus row uses it.
 */
function normalizePythonReceiverText(node: AstNode): string {
  if (node.type !== "call") return node.text;
  const fn = node.childForFieldName("function");
  if (fn?.type !== "identifier" || fn.text !== "super") return node.text;
  const args = node.childForFieldName("arguments");
  return args === null || args.namedChildren.length === 0 ? "super" : node.text;
}
```

- [ ] Add walker tests: `super().__init__()` records receiver `"super"`;
      `super(Foo, self).__init__()` keeps `"super(Foo, self)"`; a call on a
      variable named `supervisor` is untouched.
- [ ] Assert the classification, not just the text: feed the recorded `CallRef`
      to `classifyReceiverKind` in the test and assert `"super"`.
- [ ] The walker version was already bumped to `3` in Task 2. Confirm
      `python/capability.ts` still reads `walker: 3` and do not bump again — one
      bump covers both extraction changes.
- [ ] Rewrite `PythonSuperSymbolResolutionStrategy.resolveSuper` to walk the MRO
      from the position AFTER the enclosing class, which is what `super()` means
      under multiple inheritance and what the current
      `ctx.classExtends[enclosing]` single-parent hop cannot express:

```ts
private resolveSuper(member: string, ctx: CallContext): SymbolResolutionTarget | null {
  if (ctx.callerScope.length === 0) return null;
  if (this.linearizer === undefined || ctx.classAncestors === undefined) {
    return this.resolveSuperViaClassExtends(member, ctx); // the pre-seam body, moved verbatim
  }
  const classKey = pythonClassKey(ctx.callerFile, ctx.callerScope.join("."));
  const { target } = resolvePythonInheritedMember(
    classKey, member, ctx, this.cfg.mode, this.linearizer, { startAfter: true },
  );
  return target;
}
```

      `attempt` is unchanged: `super` stays terminal and a `null` is a `DROP`,
      never a `CONTINUE` (bd `pic4` / `4rgg`). The `closure` is deliberately
      ignored here — for `super` all three flavours DROP.

- [ ] Move the existing single-inheritance body into
      `resolveSuperViaClassExtends` byte-identically. It is the walker-v2
      fallback and its behaviour must not drift.
- [ ] Add super tests: `super().m()` under `class C(A, B)` where only `B`
      defines `m` resolves to `B#m` — the case jedi 0.20.0 itself gets wrong
      (`applySuperMroBlindSpot` in `scripts/lib/py-oracle-core.ts` withdraws
      jedi's answer there, so the row is scored `unknown`, not against us);
      `super().m()` where the enclosing class ALSO defines `m` resolves to the
      ancestor, never to the caller's own class; `super().m()` with no project
      ancestor defining `m` returns `DROP`.
- [ ] `npx vitest run tests/core/domains/language/python` green.
- [ ] Commit:
      `feat(language): normalize the Python super() receiver and walk the MRO (ntnke)`.

---

## Task 5 — Harness threading, gates, navigators

**Files**

- Modify `scripts/codegraph-chain-tally.ts`
- Modify `scripts/py-codegraph-jedi-oracle.ts`
- Modify `src/core/domains/language/CLAUDE.md`
- Modify `src/core/domains/language/ruby/CLAUDE.md`
- Modify `src/core/domains/language/python/CLAUDE.md`

**Steps**

- [ ] **Thread the channel into both harnesses before running any gate.** Both
      build a `CallContext` with `classFieldTypes`, `localBindings` and
      `classExtends` and nothing else (`codegraph-chain-tally.ts` ~line 265,
      `py-codegraph-jedi-oracle.ts` ~line 179). Without `classAncestors` every
      Python site sees an empty map, the strategies take their walker-v2
      fallback, and every gate below measures a no-op while reporting green.
      Accumulate `classAncestors` across files exactly as `classExtends` is
      accumulated, build the policy and ONE linearizer after the walk, and pass
      it to `createPythonSymbolResolutionChain`. Verify the threading works
      before trusting a number: on flask, assert the tally's `selfMember`
      resolved count is strictly greater than the pre-seam run.
- [ ] Ruby parity, re-run after every Python task:
      `scripts/spikes/ruby-resolver-parity.ts --before-root <parent worktree>`
      on mastodon. **Gate: `mismatches 0`.** Plus
      `npx vitest run tests/core/domains/language/ruby` at the Task 1 baseline
      counts and an empty `git diff --stat -- tests/core/domains/language/ruby`.
- [ ] Chain-tally determinism: `scripts/codegraph-chain-tally.ts` five times on
      netbox. **Gate: drift 0** across all five. Print the policy's `fallbacks`
      counter with each run; a non-zero count is allowed but must be IDENTICAL
      across the five, and must be reported in the commit body.
- [ ] Row-level oracle A/B on netbox, flask, httpx and ugnest — and polar when
      E0.11's `PYTHONHASHSEED=0` pin has landed, in which case polar's numbers
      count too. Gates: - gross `lost` **0** (no row that was `match` before is
      `missed` after); - `selfMember` `missed` down by **at least 60 %** of the
      (a) share — at least 403 rows on netbox (of 672) and 520 on polar (of
      866); - `constant` `missed` on polar down by at least 60 % (at least 998
      of 1,663); - `phantom` **not up** on any corpus; - `wrongFile` **not up**
      on any corpus. The 60 % floor, not 100 %: an ancestor can sit behind an
      `unknown` boundary this seam declines to guess past, and `noInProjectDef`
      rows (netbox 117, polar 72) are not all reachable.
- [ ] Report the `super` receiver-kind migration as evidence the `ntnke` fix
      landed: after the reindex, `receiverKind == "super"` must be non-zero on
      both corpora and the `dynamic` bucket must fall by the matching count
      (netbox ~1,446, polar ~1,242). Verdict shares within those rows should be
      unchanged — the normalization moves rows between buckets, it does not
      resolve anything by itself.
- [ ] Perf A/B on netbox, same machine, back to back. **Gate: wall ≤ +25 %, RSS
      ≤ +20 %.** If wall regresses further, the memo is not being hit — assert
      the linearizer is constructed ONCE per resolver (log its construction
      count) before optimizing anything else.
- [ ] `npm run test:coverage` **exit 0**. If it fails the threshold, delegate to
      the `coverage-expander` subagent per `.claude/CLAUDE.md`; do not write the
      tests inline and do not lower a threshold.
- [ ] Navigator updates, each stating its fact ONCE and linking rather than
      restating: - `src/core/domains/language/CLAUDE.md` — the kernel owns the
      ancestor walk's driver (recursion, cycle guard, dedupe, memo, member
      scan); a language owns ORDER and supplies it as an
      `AncestorLinearizationPolicy`. Every policy is created once per resolver,
      never per call site. - `src/core/domains/language/ruby/CLAUDE.md` — one
      pointer: the driver moved to `kernel/ancestor-walk.ts`, the
      module-insertion rule did not, and `linearizeAncestors`'s signature is
      unchanged. Note that Ruby's own member walk
      (`resolveInstanceMethodInClassChain`) is NOT the kernel's — it carries the
      prepend pre-pass, the schema-column preference and the file-only fallback
      ordering, none of which are neutral. -
      `src/core/domains/language/python/CLAUDE.md` — the class-key shape
      `<relPath>::<dotted FQ>`, why ancestor VALUES carry the defining file's
      import binding (caller-independence, hence the memo), the two boundary
      flavours and which verdict each produces, and that `classExtends` survives
      as the walker-v2 fallback and the `pythonTypeOwnsMembers` corroboration
      channel.
- [ ] File a follow-up bead for the duplication Task 1 declined to force: Ruby's
      `resolveInstanceMethodInClassChain` and the kernel's
      `findMemberInAncestorChain` are two first-definition-wins scans. Unifying
      them means relocating the schema-column preference and the file-only
      fallback ordering, which is Ruby behaviour and needs its own parity run.
- [ ] Commit:
      `test(language): gate Python inheritance resolution on the oracle A/B (9fgdi)`.

---

## Self-review checklist

- [ ] `pythonClassKey`, `parsePythonClassKey`, `resolvePythonInheritedMember`,
      `createPythonAncestorPolicy`, `createAncestorLinearizer`,
      `findMemberInAncestorChain`, `joinClosure`, `AncestorClosure`,
      `AncestorLinearizationPolicy`, `LinearizedAncestors` — spelled identically
      in every task and every test.
- [ ] Every port has BOTH providers: `order` (Ruby module-insertion / Python C3)
      and `boundaryOf` (Ruby omits it and gets `"closed"`; Python supplies it).
      No port exists that only one language can fill.
- [ ] Every decision has a task: 1→Task 1, 2/3→Task 2, 4→Task 2, 5→Task 3,
      6→Task 3, 7→Task 3, 8→Task 4, 9→Task 5.
- [ ] No Ruby test edited. No Python test edited except a pin of a fabricated or
      duplicated answer, commented with `9fgdi`.
- [ ] Each task's writes stay under 120 lines per edit and each tool call under
      8 minutes; a fresh Opus executor per task, each in its own worktree.
