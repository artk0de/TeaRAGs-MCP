# Python Frontier E4.4 — Class-Object Receivers and Cooperative `super()` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Answer the two families D8 row 5 attributes to E4.4 —
`classObjectReceiver` 83 and `superMro` 23, 106 rows across five corpora — by
asking the MRO the two questions nothing in the chain asks it today: what does
`cls` name, and what does a class receiver's ancestor own. `typeVarGeneric`
measured 0 and is not in this plan at all. Neither is a new dispatch component:
every mechanism below is a lookup against `classAncestors`, which the walker has
recorded since walker 4 and which `selfMember` and `importedName`'s
imported-class arm already read. The whole of the new machinery is one strategy
that is `selfMember` with `cls` in place of `self`, and one MRO fallback added
to a class-receiver arm that already tries both symbolId spellings and stops one
hop short.

Measured addressable mass, after sub-shape attribution (decision 1): **44 of the
106 rows** — 34 `cls.m()` and 10 same-file `Cls.m()` whose member is inherited.
A further **22 rows are E4.6a's**, not this plan's: 19 `super().__init__` rows
whose base class is a package re-export alias, and 3 `Cls.m()` rows whose import
lands in a PEP 420 namespace package the mapper reads as `unknown`. **32 rows
are oracle debt** — every `cls(...)` constructor row in the set, where both
engines answer with the enclosing classmethod because `cls` is a parameter and
its definition line is the `def` line. The remaining 8 are counted and argued in
decision 6.

Against a residual of 1,247 rows across the five corpora (ugnest 24, flask 48,
httpx 19, netbox 118, polar 1,038), 44 rows is 3.5 % — small, and the smallest
increment D8 schedules. It is here because it is cheap: the ancestor channel,
the linearizer cache, the MRO scan and the two-spelling lookup all exist and are
under test, so the cost is a gate rather than a design.

**Architecture:** Three moves.

(1) **A `clsMember` strategy**, placed immediately after `super` in the chain.
`cls.m()` is an instance-independent dispatch on the enclosing class, which is
`selfMember`'s question with a different receiver spelling and a different
preferred symbolId separator: a `@classmethod` is filed as `Cls.m`, an
undecorated `def` as `Cls#m`, and all 34 measured rows want the first. So
`resolvePythonInheritedMember` grows one option that reverses the order it tries
the two spellings in, defaulting to today's order so every existing caller is
byte-identical.

(2) **An MRO fallback on the same-file class-receiver arm.**
`resolveSameFileClassReceiver` in `python-imported-name.ts` already looks up
BOTH `Cls.m` and `Cls#m` filtered to the caller's own file, and its docblock
says in as many words: "No short-name search, no MRO walk, no DROP". The
imported-class arm two methods down already HAS the MRO walk
(`resolveInheritedMember`). The same-file arm gets the same fallback, keyed by
`pythonBoundClassKey(receiver, ctx.callerFile, ctx)` — which returns `null`
unless the caller's file declares exactly one class of that name, and that
uniqueness IS the precision gate.

(3) **A diagnosis, not a fix, for the `super()` residual.** 19 of the 23 rows
are downstream of E4.6a's mapper arm and are re-measured rather than
re-implemented. 3 are a real chain defect with a clean reproduction — the MRO
scan answers `PolarTaskError#__init__` where the oracle says
`PolarError#__init__`, and `PolarTaskError` is a SIBLING of the right answer,
not an ancestor of the caller. 1 is a `Protocol` base in the caller's own file.
Four rows is below this program's 10-row design bar, so they get a bounded
diagnosis step and a fix only if the diagnosis names one.

**Tech Stack:** TypeScript (NodeNext, `strict`), vitest, tsx for the corpus
harnesses. No new dependency, no schema migration, no new walker channel, no new
payload field. `classAncestors` and `PythonAncestorLinearizerCache` are existing
run-global channels. `versions.walker` in
`src/core/domains/language/python/capability.ts` reads **5** and STAYS 5 — this
plan writes no walker code at all.

**Spec:** `docs/superpowers/specs/2026-09-10-python-frontier-e4-design.md` — D8
row 5 (the 106 rows and the execution order), D9 (`oracleWrongMro`, 11 netbox
rows where jedi is wrong about cooperative multiple inheritance — this plan must
NOT chase them, and decision 5 shows they are not in the 23), D10 (why nothing
here picks a symbol by name popularity), and the E4.4 sketch, whose TypeVar half
this plan drops on measured evidence. The measurement record it builds on is
`docs/superpowers/plans/2026-09-10-python-e4-0-measurement.md` → E4.0.4. Format,
gate protocol and corpus-root correction are inherited from
`docs/superpowers/plans/2026-09-10-python-e4-6-typed-residuals.md`.

---

## Decision record

### 1 — The attribution, measured (2026-09-10, re-tagged dumps under `/tmp/e46/tag-<corpus>.ndjson`)

Every residual row from E4.0.4's five `--oracle merged --dispatch` dumps was
re-tagged by the E4.6 author with `scripts/lib/py-residual-families.ts` and the
**corrected corpus roots** — flask at `~/Dev/OpenSource/codegraph-test/flask`,
ugnest at `~/Dev/Collaborate/ugnest`, the other three under
`~/Dev/Tools/tea-rags-bench/corpora/`. That re-tag is what this plan counts
over. It is verifiably the corrected run: flask carries 8 `moduleAliasMember`
rows and 20 non-null `headBinding`s, both of which read zero under the wrong
root, and the family totals come to 325 `moduleAliasMember` (D8 printed 317 for
exactly that reason).

Both E4.4 families are UNCHANGED by the correction: `classObjectReceiver` is 83
and `superMro` is 23 under corrected roots, byte-identical to D8. The sub-shapes
below are then read off the caller's source, ≥ 5 rows opened per sub-shape per
corpus.

**`classObjectReceiver` — 83 rows, six sub-shapes.**

| sub-shape                                                   | `receiverKind` | flask | httpx | netbox |  polar | ugnest |   rows | owner            |
| ----------------------------------------------------------- | -------------- | ----: | ----: | -----: | -----: | -----: | -----: | ---------------- |
| **a** `cls.m()` inside a classmethod                        | `dynamic`      |     0 |     0 | **17** | **16** |  **1** | **34** | **Task E4.4a**   |
| **b** `cls(...)` constructor call                           | `bareCall`     |     1 |     0 |      6 |     25 |      0 | **32** | oracle debt (D3) |
| **c1** `Cls.m()`, class SAME FILE, member inherited         | `constant`     |     0 |     0 |      0 | **10** |      0 | **10** | **Task E4.4b**   |
| **c2** `Cls.m()` declined as a core member (`values`)       | `constant`     |     0 |     0 |      3 |      0 |      0 |      3 | folded (D6)      |
| **c3** `Cls.m()` imported, mapper reads `unknown` (PEP 420) | `constant`     |     0 |     0 |      0 |      0 |      3 |      3 | E4.6a mapper     |
| **c4** SCREAMING_SNAKE module constant holding an INSTANCE  | `constant`     |     0 |     0 |      0 |      1 |      0 |      1 | folded (D6)      |
| **e** `type(self).m()` / `self.__class__.m()`               | —              |     0 |     0 |      0 |      0 |      0 |  **0** | —                |
| **total**                                                   |                | **1** | **0** | **26** | **52** |  **4** | **83** |                  |

Sub-shape **e** is the finding that removes a branch: `CLASS_OBJECT_RECEIVERS`
in the classifier lists `type(self)` and `self.__class__` beside `cls`, and a
regex over every residual row on all five corpora returns **zero** matches. The
classifier's own predicate for this family reduces, on this corpus set, to
`receiver === "cls"` ∪ `member === "cls"` ∪ `receiverKind === "constant"`. No
task designs for `type(self)`.

**`superMro` — 23 rows, all polar, four sub-shapes.**

| sub-shape                                                                       | verdict    |   rows | owner          |
| ------------------------------------------------------------------------------- | ---------- | -----: | -------------- |
| **a** base is a package re-export ALIAS (`datatable.X[…]`, `_description_list`) | `missed`   | **19** | E4.6a mapper   |
| **b** MRO scan answers a SIBLING (`PolarTaskError#__init__`)                    | `fileOnly` |  **3** | **Task E4.4c** |
| **c** `super().m()` on a `Protocol` base in the caller's own file               | `missed`   |  **1** | **Task E4.4c** |
| **d** two-argument `super(Cls, self).m()`                                       | —          |  **0** | —              |
| **e** base is external / `PYTHON_UNRESOLVABLE_BASE`                             | —          |  **0** | —              |
| **total**                                                                       |            | **23** |                |

22 of the 23 are `super().__init__`; the one exception is
`server/polar/kit/repository/base.py:187`, `super().get_base_statement()`.
Sub-shape **d** measuring 0 settles the orchestrator's conditional: the
two-argument form gets no walker normalisation, because there is nothing to
normalise. Sub-shape **e** measuring 0 settles the other one: no row in this
family is declined-by-design; all 23 are real misses.

**D9's `oracleWrongMro` is not in this table.** Its 11 rows are netbox
`phantom ∪ wrongFile` rows, and every row above is polar and
`missed | fileOnly`. The two populations do not intersect. What D9 imposes on
this plan is a precision constraint rather than a scope one, and decision 5
states it.

### 2 — `cls` is the enclosing class, and the arm that says so is `selfMember` with one letter changed

Every one of the 34 sub-shape **a** rows resolves to a member of the caller's
own enclosing class or of one of its ancestors, and every one of the 34 oracle
targets carries the CLASS-LEVEL separator:

```text
netbox  cls.values()                     → ChoiceSet.values            @utilities/choices.py
netbox  cls.get_url(obj)                 → ObjectAction.get_url        @netbox/object_actions.py
netbox  cls._unwrap_filter_annotation(…) → APIViewTestCases.GraphQLTestCase._unwrap_filter_annotation
polar   cls.from_prices(…)               → PriceSet.from_prices        @product/price_set.py
polar   cls.get_renderer()               → Logging.get_renderer        @logging.py
ugnest  cls.generate_code()              → ConfirmationCode.generate_code
```

That is `selfMember`'s contract — "resolution is CONSTRAINED to the enclosing
class and its IN-PROJECT ancestors" — asked of a receiver spelled `cls`. So the
mechanism is a **new strategy, `clsMember`**, structurally identical to
`PythonSelfMemberSymbolResolutionStrategy`, placed **immediately after `super`**
so the guard block reads `super → clsMember → selfField → selfMember`.

**Why a strategy and not an arm inside `selfMember`.** `selfMember`'s first line
is `if (call.receiver !== "self") return CONTINUE`, and its whole docblock —
guard terminality, the three-way closure verdict, the netbox/polar row counts —
is written about `self`. Widening that predicate to `self | cls` puts two
receiver idioms with different symbolId preferences and different precision
evidence behind one name, which the naming rule forbids and which would make the
`answeredBy` column unable to tell them apart in the A/B. A separate
`name = "clsMember"` is what lets the gate count the rows this task moved.

**The precision gate, and what it is NOT.** `CallContext` carries no decorator
channel and no enclosing-def parameter list, and adding one is a walker change
this plan has ruled out. Three facts that ARE on the context are enough, and the
measurement says so:

1. `pythonEnclosingClass(ctx) !== null` — the call is inside a class body.
2. `cls` is not a name the walker BOUND at this site. All 34 rows read
   `receiverKind: "dynamic"`, and `classifyReceiverKind` files a receiver
   present in `localBindings` as `localVar` before it ever reaches `dynamic`. So
   a `for cls in classes:` loop variable — the one shape that makes `cls` not
   the enclosing class — is already separated by the instrument, and the
   strategy re-checks `ctx.localBindings` / `ctx.callResultBindings` itself
   rather than trusting a field it cannot see.
3. The MRO scan must find the member. A `cls` that is not the class produces a
   member the class does not own, and the scan returns `null`.

`ctx.callerSymbolId` is a FOURTH signal and is deliberately not used as a gate:
a `@classmethod` chunk is filed `Cls.m` and an undecorated one `Cls#m`, so the
separator would decide it — but a CLASS-level chunk carries `Cls` with no
separator at all, exactly the case `ruby-bare-call.ts:52` handles by hand, and
gating on it would lose rows to chunk granularity rather than to evidence.

**Terminality: resolve-or-CONTINUE, not DROP, in this increment.** `selfMember`
and `super` are guards because a fall-through lands on `globalShortName` and
fabricates. The same argument applies to `cls` — but the bar is **gross lost
0**, and the residual dumps cannot show what `globalShortName` answers CORRECTLY
on `cls.` receivers today, because a matched row is not in a residual dump. So
the arm ships resolve-or-CONTINUE, the A/B measures `lost` and phantom on both
sides, and Step 7 of Task E4.4a adopts the DROP only if the numbers say it is
free. Shipping the DROP on an argument rather than a measurement is the E4.1.3
mistake in a smaller frame.

### 3 — `cls(...)` is oracle debt. 32 rows, not chased, and the local-typing half is folded

The orchestrator's decision was that `x = cls(...)` should type `x` as the
enclosing class so the downstream `x.m()` resolves. Two measurements retire it.

**The `cls(...)` rows themselves cannot be scored.** All 32 read
`missBucket: noInProjectDef`, `answeredBy: none` — the walker files
`cls(session)` as a bare call to a function named `cls`, nothing declares one,
and the chain declines. The oracle target on every row is **the enclosing
classmethod**:

```text
polar   server/polar/kit/repository/base.py:166   cls(session)   → RepositoryBase.from_session
flask   src/flask/ctx.py:348   cls(app, request=request)          → AppContext.from_environ
netbox  netbox/netbox/jobs.py:111   cls(job)                       → JobRunner.handle
```

`base.py:165` is `def from_session(cls, session)` and `:166` is its body; the
oracle resolved the NAME `cls` to its parameter binding, whose line is the `def`
line, and the harness attributes that line to the enclosing symbol. Both engines
do it — 18 jedi, 7 pyright on polar — so a merge cannot repair it. The correct
answer for `cls(session)` is an edge to the enclosing class's `__init__` or to
the class node, and emitting it turns 32 `missed` rows into `fileOnly` or
`wrongFile`, which spends the precision bar to buy nothing. **They stay
residual, recorded as `oracleNonCallable`-class debt beside D9's other three
classes.**

**The downstream mass is 1 row.** A regex over every residual row on all five
corpora for a receiver whose nearest binding line matches `=\s*cls\(` returns
**one** hit, on ugnest, already attributed to `untypedNameReceiver`. Wiring the
enclosing-class type into `callResultBindings` for `x = cls(...)` is a walker
change — and `python-return-expression.ts:37,55` already does exactly this
inference in the RETURN channel
(`if (fn.text === "cls") return scope.selfClass`), so the shape is
known-buildable and known-cheap. It is still 1 row, 30× under the program's mass
bar. **Folded, with the count, and the precedent named so a later increment does
not re-derive it.**

### 4 — The separator was never the problem. The missing hop is the MRO

The orchestrator's second decision was that the class-receiver arm must look up
both `Cls.m` and `Cls#m`. It already does — in both arms, and has since before
this branch:

```ts
// resolveSameFileClassReceiver, python-imported-name.ts:146
for (const fqName of [`${call.receiver}.${call.member}`, `${call.receiver}#${call.member}`]) {
// resolveDeclaredName, python-imported-name.ts:308
const wanted = call.receiver
  ? [`${binding.importedName}.${call.member}`, `${binding.importedName}#${call.member}`]
  : [binding.importedName];
```

`resolvePythonInheritedMember` in `shared.ts:246` tries both spellings too, at
every class in the linearized order. What separates the two arms is the ancestor
hop: `resolveDeclaredName` falls through to `resolveInheritedMember`, and
`resolveSameFileClassReceiver` falls through to nothing. Its docblock states the
gap outright — "No short-name search, no MRO walk, no DROP".

The 10 sub-shape **c1** rows are exactly that gap, and 8 of the 10 are one polar
idiom: a form class declared in the endpoint file, its members inherited from a
`BaseForm` in another one.

```text
polar  backoffice/customers/endpoints.py:70   class UpdateCustomerEmailForm(forms.BaseForm)
       …/endpoints.py:1046   UpdateCustomerEmailForm.render(…)        → BaseForm.render
       …/endpoints.py:1019   UpdateCustomerEmailForm.model_validate_form(…) → BaseForm.model_validate_form
polar  logging.py:138   class Development(Logging[structlog.dev.ConsoleRenderer])
       logging.py:152,154   Development.configure(…)                  → Logging.configure
```

All 10 oracle targets carry the class-level separator, all read
`answeredBy: none, chainOutput: none` (the arm CONTINUEd and `globalShortName`
declined them post-E4.0.5), and `Development` is the control that shows the base
need not be in another file for the hop to be missing.

### 5 — The `super()` split: 19 belong to E4.6a, 4 are ours, 0 are oracle debt

Sub-shape **a**'s 19 rows are one polar idiom, and reading the source settles
where the defect is:

```python
# server/polar/backoffice/customers/components.py:11,14,16
from ..components import datatable

class CustomerIDColumn(datatable.DatatableAttrColumn[Customer, CustomerSortProperty]):
    def __init__(self) -> None:
        super().__init__("id", "ID", clipboard=True)   # → DatatableAttrColumn#__init__
```

The walker handles its half correctly: `collectPythonClassAncestors` strips the
generic subscript (`base.type === "subscript"` → its `value` child), and
`qualifyPythonBase` composes `..components.datatable::DatatableAttrColumn`. The
break is one layer down — `..components/__init__.py` re-exports the private
module `_datatable` under the name `datatable`, so `mapImportToFile` finds no
`components/datatable.py`, `resolveBaseKey` returns `unknown`, the linearization
closes `unknown`, and `super` falls to the single-parent `classExtends` walk,
which cannot pin the base either. **That is `resolveExportedModule`, Task
E4.6a's Step 2, verbatim.** These 19 rows are the same mechanism as
`moduleAliasMember`, arriving through the ancestor channel instead of the
receiver one, and they are re-measured after E4.6a rather than re-implemented
here. If E4.6a's arm reaches `resolveBaseKey` — it is in the mapper, which
`createPythonAncestorPolicy` holds — they close for free; if it does not, the
missing edge is one call site, not a design.

Sub-shape **b**'s 3 rows are a chain DEFECT, and the reproduction is exact:

```python
# server/polar/checkout/service.py:149
class CheckoutError(PolarError): ...
# …:179-182
class CheckoutDoesNotExist(CheckoutError):
    def __init__(self, checkout_id: uuid.UUID) -> None:
        …
        super().__init__(message)      # chain → PolarTaskError#__init__
                                       # oracle → PolarError#__init__
```

`server/polar/exceptions.py:11` declares `class PolarError(Exception)` with an
`__init__` at `:26`, and `:53` declares `class PolarTaskError(PolarError)` with
its own. `PolarTaskError` is a SIBLING branch — it is not on
`CheckoutDoesNotExist`'s MRO at all — so this is not a precedence question, it
is an answer from outside the hierarchy. Two mechanisms can produce it and the
diagnosis step must say which before anything is edited: either the
linearization closed non-`closed` and `resolveSuperViaClassExtends` ran first
(its `ctx.symbolTable.lookup(...)` is NOT filtered by the candidate's file,
where `resolvePythonInheritedMember`'s IS), or `resolveBaseKey` bound
`PolarError` to the wrong declaration. These three are the only `fileOnly` rows
in the family; every other row in it reads `answeredBy: none`.

Sub-shape **c** is one row, `base.py:187`, `super().get_base_statement()` where
the base is a `Protocol` declared in the caller's own file.

**No row in this family is jedi being wrong.** D9's `oracleWrongMro` class is 11
NETBOX rows in `phantom ∪ wrongFile` — a different corpus and a different
verdict bucket from all 23 rows here. What D9 imposes is a precision rule with
teeth: netbox's `super()` sites are where jedi's cooperative-MI answer is known
bad, so **any netbox `super()` movement in this plan's A/B — in either direction
— is a regression signal, not a gain**, and Task E4.4c's gate reads netbox's
`superMro` count as a control that must not move.

### 6 — What this plan declines, with counts

|   rows | shape                                                | why declined                                                                                                                                                                                                                                                                                                                                                                                                               |
| -----: | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **32** | `cls(...)` constructor calls                         | Oracle debt: both engines answer the enclosing classmethod, because `cls` is a parameter whose definition line is the `def` line (decision 3). No chain answer can score.                                                                                                                                                                                                                                                  |
| **19** | `super().__init__` through a package re-export alias | E4.6a's `resolveExportedModule`. Re-measured by Task E4.4c, not re-implemented (decision 5).                                                                                                                                                                                                                                                                                                                               |
|  **3** | ugnest `Cls.m()` under a PEP 420 namespace package   | `domains/` has no `__init__.py`; `mapImportToFile("domains.media.services.upload", …)` reads `unknown`, `declaringFile` is `null`, and `resolveBinding` returns CONTINUE. Mapper scope. The third of the three is the alias form `SendCodeService.execute` → `SendConfirmationCodeService.execute`, which `resolveDeclaredName` already handles once the module maps, because `binding.importedName` is the EXPORTED name. |
|  **3** | netbox `CustomFieldChoiceColorChoices.values()`      | `values` is in `PYTHON_CORE_MEMBERS` (`vocabulary/core-members.ts:45`); the rows read `verdict: skippedInProject, missBucket: coreAmbiguous` and the decline fires before any receiver evidence is consulted. Widening a core-member decline on 3 rows is the D9 boundary this program does not cross.                                                                                                                     |
|  **1** | polar `SOURCE_DESCRIPTION_LIST.render()`             | A SCREAMING_SNAKE module-level constant holding a `DescriptionList` INSTANCE, not a class — its oracle target uses `#`. `CONST_RE` (`receiver-kind.ts:41`) files it `constant`, which is how the classifier put it here; it is a module-binding shape and belongs to E4.6b's fold. Misattribution, recorded rather than chased.                                                                                            |
|  **1** | `x = cls(...)` downstream typing                     | One row, corpus-wide (decision 3). 30× under the mass bar.                                                                                                                                                                                                                                                                                                                                                                 |
|  **0** | `type(self).m()` / `self.__class__.m()`              | Zero rows on five corpora.                                                                                                                                                                                                                                                                                                                                                                                                 |
|  **0** | two-argument `super(Cls, self).m()`                  | Zero rows on five corpora. `EXPLICIT_SUPER_RE` (`python-super.ts:16`) already parses the form and declines when the named class is not the enclosing one; nothing measured exercises it.                                                                                                                                                                                                                                   |
|  **0** | `typeVarGeneric` / `-> Self` substitution            | D8 measured 0. The E4.4 spec sketch's TypeVar half has no residual mass on these corpora.                                                                                                                                                                                                                                                                                                                                  |

### 7 — Precision bar, per task, non-negotiable

Inherited from the program and restated so an executor needs one document.

- **Gross `lost` 0**, per corpus, from the row-level diff — not net, not "no
  regression on the headline". A `match → missed` anywhere fails the task.
- **ugnest phantom stays 0.** It is the only corpus at zero and it carries rows
  in both of this plan's target sub-shapes.
- **Confidence-1 edges:** fabricated + `wrongFile` ≤ 2 % of edges, at most +0.5
  pp of phantom per task. flask's inherited rate is E4.0.5's 0.30 %.
- **`exactReplacedByFan` / `exactReplacedByAmbiguous` must read 0.** Both new
  arms sit ABOVE `globalShortName`, so an exact answer being buried is the
  failure mode to watch.
- **netbox `superMro` count is a CONTROL and must not move** (decision 5).
- **Same-language lookups only.** Every lookup added here goes through
  `ctx.symbolTable.lookup` on a file-filtered candidate set, or through
  `lookupPythonSymbolsByShortName`, which E4.0.5 gated to same-language
  candidates. No task reintroduces a cross-language short-name search.

---

## Global Constraints

- **Ruby is byte-identical.** No task in this plan edits a Ruby file, and no
  task edits `domains/language/kernel/**`. `resolvePythonInheritedMember`'s new
  option lives in Python's `strategies/shared.ts`, which Ruby does not import.
  Parity is still gated in Task E4.4-close as a control.
- **Existing tests are moved, never rewritten**
  (`.claude/rules/resolver-architecture.md` §4). A pin that now has a better
  answer is edited only with a bead comment naming the row and the corpus.
  `tests/core/domains/language/python/resolver/python-chain-factory.test.ts`
  pins the chain composition and WILL need a new entry — that is an addition to
  an assertion list, not a rewrite.
- **Do not absorb D9.** `skippedInProject` rows are the external-vocabulary
  precision defect. A task that finds itself editing
  `python-external-vocabulary.ts` or `vocabulary/core-members.ts` has left its
  scope — decision 6's 3 netbox rows are the exact bait.
- **Do not touch `resolver/dispatch/`.** E4.1.3's parked component and its flag
  are another executor's file set. `python-dispatch-gates.ts:96` already
  suppresses the fan for a `cls` receiver and hands the shape to the chain
  ("bare call / `self` / `cls` — the bare-call and self paths"); that line is
  the contract this plan fulfils, and it is READ, not edited.
- **Do not touch the walker.** No new channel, no new field, no version bump.
  Decision 3 is where the one walker-shaped idea went.
- **The harnesses need no change.** Both `py-codegraph-jedi-oracle.ts` and
  `codegraph-chain-tally.ts` build the production resolver through
  `createPythonSymbolResolutionChain`, so a new strategy reaches both for free.
  A task editing `scripts/` for measurement has found a harness bug and reports
  it rather than patching around it.
- **Perf.** chain-tally wall ≤ +25 %, peak RSS ≤ +20 %, measured interleaved
  B/A/A/B with the min of each side, on netbox AND polar. No per-call filesystem
  probes. The MRO answer is memoised per run by `PythonAncestorLinearizerCache`;
  a new arm must take the linearizer from `this.linearizers?.for(ctx)` and never
  build its own.
- **Determinism.** jedi's answer wobbles by up to 2 rows per run on netbox and 1
  on polar (E4.0.3's control). A diff at or under that on the ORACLE columns,
  with every chain column byte-identical, is the instrument; anything larger is
  the change.
- **Capability sync.** `versions.walker` in
  `src/core/domains/language/python/capability.ts` reads **5** and STAYS 5. READ
  THE CURRENT VALUE FIRST; if a parallel branch has moved it past 5, stop and
  report rather than guessing.
- **E4.6a is in flight in another worktree** — its mapper module-alias follow,
  `LocalBinding.endLine` spans and classifier FP fixes are NOT on
  `worktree-py-frontier-e4` at `824d6998a`. Every count in this plan is measured
  against the branch AS IT IS. Where E4.6a's landing can move a number it is
  said so explicitly: decision 5's 19 super rows, decision 6's 3 ugnest rows,
  and Task E4.4c's whole scope. No task in this plan waits on it; Task E4.4c
  re-measures after it lands.
- **Commits.** `feat(language): … (w205u)`, `test(language): … (w205u)`,
  `refactor(language): … (w205u)`, `docs(plans): … (w205u)`. Body wrapped at ≤
  100 columns. Trailer
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` — that one, and
  nothing else.
- **Execution.** A fresh Opus executor per task, in its own agent worktree,
  ff-merging `worktree-py-frontier-e4` in Step 0. Tool calls ≤ 8 min; writes ≤
  120 lines per call. TDD: the failing test first, always. Live validation
  (reindex + `prime`) is user-gated and is NOT part of any task's gate. Never
  push.

---

## File Structure

```text
src/core/domains/language/python/
├── capability.ts                                  MOD  E4.4-close — codegraph tech text only
├── CLAUDE.md                                      MOD  E4.4-close — two new invariants
└── resolver/
    ├── python-chain-factory.ts                    MOD  E4.4a — clsMember after super
    └── strategies/
        ├── index.ts                               MOD  E4.4a — export the new strategy
        ├── python-cls-member.ts                   NEW  E4.4a — the whole strategy, ~70 lines
        ├── shared.ts                              MOD  E4.4a — options.spellingOrder
        ├── python-imported-name.ts                MOD  E4.4b — MRO fallback on the same-file arm
        └── python-super.ts                        MOD  E4.4c — ONLY if the diagnosis names a fix

tests/core/domains/language/python/resolver/
├── python-chain-factory.test.ts                   MOD  E4.4a — new entry in the order pin
└── strategies/
    ├── python-cls-member.test.ts                  NEW  E4.4a
    ├── python-inherited-member.test.ts            MOD  E4.4a — spellingOrder cases
    ├── python-imported-name.test.ts               MOD  E4.4b — same-file MRO cases
    └── python-super-sibling.test.ts               NEW  E4.4c — the reproduction, RED first

docs/superpowers/
├── specs/2026-09-10-python-frontier-e4-design.md  MOD  E4.4-close — D11, the E4.4 record
└── plans/2026-09-10-python-e4-4-class-object-receivers.md  MOD  E4.4-close — measured results
```

Nothing under `src/core/domains/language/kernel/`, nothing under
`src/core/domains/language/ruby/`, nothing under
`src/core/domains/language/python/walker/`, nothing under `scripts/`.

---

## Context the implementer needs

### The chain, and where the new arm goes

`createPythonSymbolResolutionChain` (`python-chain-factory.ts:60`) composes, in
precedence order:

```text
0  super            guard, terminal — resolves or DROPs
1  selfField
2  selfMember       guard, three-way — resolve / CONTINUE on `unknown` / DROP
3  localBinding
4  chainType
5  namingConvention the one GUESS
6  importedName     owns the class-receiver question, both arms
7  globalShortName  same-language, bare-callable, non-builtin since E4.0.5
```

`clsMember` is inserted at index 1, so the guard block reads
`super → clsMember → selfField → selfMember`. Index matters only relative to
`namingConvention` and `globalShortName` — both of which would otherwise guess
at a `cls.` receiver — but the guard block is where the receiver-idiom passes
belong and keeping them contiguous is what makes the file readable.

### The four helpers, verbatim

```ts
// strategies/shared.ts:160 — the enclosing class, addressed the way the run keys classes.
// Returns the LONGEST prefix of ctx.callerScope that names a class; never the
// whole scope blindly, because a call from a nested def carries the def.
export function pythonEnclosingClass(
  ctx: CallContext,
): PythonEnclosingClass | null;

// strategies/shared.ts:206 — the MRO key of the class `bareName` names INSIDE `relPath`,
// or null when the file declares no such class OR declares it twice. The
// uniqueness check IS the precision gate for a same-file class receiver.
export function pythonBoundClassKey(
  bareName: string,
  relPath: string,
  ctx: CallContext,
): string | null;

// strategies/shared.ts:235 — <member> on classKey or the first ancestor in its MRO
// that owns it. Tries `Cls#m` then `Cls.m`, FILTERED BY THE CANDIDATE'S OWN FILE.
// `closure` is the caller's evidence for what a miss means.
export function resolvePythonInheritedMember(
  classKey: string,
  member: string,
  ctx: CallContext,
  mode: AmbiguousResolveMode,
  linearizer: AncestorLinearizer<CallContext>,
  options: { readonly startAfter?: boolean } = {},
): {
  readonly target: SymbolResolutionTarget | null;
  readonly closure: AncestorClosure;
};

// python-ancestor-policy.ts — one linearizer per RUN, memoised. `undefined` for a
// walker-v2 index carrying no classAncestors; every strategy keeps its old
// behaviour there.
this.linearizers?.for(ctx);
```

### The closure verdict table, which every guard obeys

| `closure`  | what it means                           | verdict                 |
| ---------- | --------------------------------------- | ----------------------- |
| `closed`   | every branch ended on a project class   | evidence of absence     |
| `external` | a branch left the project               | a miss proves nothing   |
| `unknown`  | a branch could not be classified at all | CONTINUE — not evidence |

`selfMember` turns `closed` and `external` into DROP and `unknown` into
CONTINUE. `clsMember` ships resolve-or-CONTINUE in every case for the reason
decision 2 gives, and Task E4.4a Step 7 measures whether the DROP is free.

### The gate commands, exactly

```bash
# Row-level A/B, five corpora, five runs each side (B = worktree HEAD before the
# task, A = after). Five runs are what separates a real delta from jedi wobble.
for c in ugnest flask httpx netbox polar; do
  for i in 1 2 3 4 5; do
    npx tsx scripts/py-codegraph-jedi-oracle.ts --corpus $c --oracle merged --dispatch \
      --workers 8 --json ~/.claude/jobs/<job>/tmp/e4-4/<side>-$c-$i.json \
      > ~/.claude/jobs/<job>/tmp/e4-4/<side>-$c-$i.txt
  done
done

# Chain tally — drift AND dispatchDrift must read 0, five corpora, five runs.
npx tsx scripts/codegraph-chain-tally.ts --corpus <c> --lang python

# Ruby parity control (E4.4-close).
npx vitest run tests/core/domains/language/ruby tests/scripts/ruby-resolver-parity.test.ts
npx tsx scripts/codegraph-chain-tally.ts --corpus mastodon --lang ruby

# Per-family attribution of the A side, to check the gain landed where predicted.
npx tsx scripts/py-e4-family-report.ts --rows <A-dump>.ndjson \
  --corpus-root <REAL corpus root> --corpus <c> --json <out>.json
```

**The corpus roots are NOT all under `tea-rags-bench/corpora`.** Read them from
`scripts/lib/codegraph-corpora.json`: ugnest `~/Dev/Collaborate/ugnest`, flask
`~/Dev/OpenSource/codegraph-test/flask`, httpx / netbox / polar under
`~/Dev/Tools/tea-rags-bench/corpora/`. Passing the wrong root does not fail — it
silently turns every tier-2 read into a miss, which is exactly how D8 shipped
flask's numbers wrong.

### Reading the A/B

Per corpus, gross, never netted: `missed → match` and `fileOnly → match` counted
SEPARATELY, `lost` (must be 0), `wrongFile` delta, phantom delta in pp,
`exactReplacedByFan` / `exactReplacedByAmbiguous` (must be 0). Then the family
report on the A side: the family this task targets must SHRINK by the predicted
count per corpus, and no other family may grow. The B-side baselines this plan
was measured against are `classObjectReceiver` flask 1 / netbox 26 / polar 52 /
ugnest 4, `superMro` polar 23, and residual totals ugnest 24 / flask 48 / httpx
19 / netbox 118 / polar 1,038.

---

## Task E4.4a — `cls` is the enclosing class: the `clsMember` guard (`w205u`)

**Target:** 34 rows — netbox 17, polar 16, ugnest 1. All read
`receiverKind: "dynamic"`, `receiver: "cls"`, `answeredBy: none`,
`chainOutput: none`, `verdict: missed`, and every oracle target carries the
CLASS-level separator on the enclosing class or one of its ancestors. Expected:
netbox `missed → match` +17, polar +16, ugnest +1, flask and httpx
byte-identical (they carry zero rows in this sub-shape, which is the task's own
identity control), `lost` 0, phantom flat on all five.

**Files:**

- `src/core/domains/language/python/resolver/strategies/python-cls-member.ts`
  (NEW)
- `src/core/domains/language/python/resolver/strategies/shared.ts` (MOD — one
  option)
- `src/core/domains/language/python/resolver/strategies/index.ts` (MOD — one
  export)
- `src/core/domains/language/python/resolver/python-chain-factory.ts` (MOD — one
  entry)
- `tests/core/domains/language/python/resolver/strategies/python-cls-member.test.ts`
  (NEW)
- `tests/core/domains/language/python/resolver/strategies/python-inherited-member.test.ts`
  (MOD)
- `tests/core/domains/language/python/resolver/python-chain-factory.test.ts`
  (MOD)

**Interfaces:**

```ts
// shared.ts — the ONLY signature change in this task.
export function resolvePythonInheritedMember(
  classKey: string,
  member: string,
  ctx: CallContext,
  mode: AmbiguousResolveMode,
  linearizer: AncestorLinearizer<CallContext>,
  options: {
    readonly startAfter?: boolean;
    /** Which symbolId spelling the scan tries FIRST at each class in the order.
     *  `"instanceFirst"` (default) is today's `Cls#m` then `Cls.m`, byte-identical
     *  for every existing caller. `"classFirst"` reverses it for a receiver that
     *  IS the class object, where `Cls.m` is the only spelling a `@classmethod`
     *  can carry. */
    readonly spellingOrder?: "instanceFirst" | "classFirst";
  } = {},
): PythonInheritedMemberResult;
```

### Steps — E4.4a

- [x] **Step 0.** Fresh agent worktree; ff-merge `worktree-py-frontier-e4`.
      `npx vitest run tests/core/domains/language/python` green before starting.
      Read `src/core/domains/language/python/capability.ts` and CONFIRM
      `versions.walker` is 5; if it is anything else, stop and report. Capture
      the B side of the A/B now, per the gate commands — five corpora × five
      runs — before a single line is edited.
- [x] **Step 1 (RED — the spelling order).** In
      `python-inherited-member.test.ts`, add a block for a class declaring BOTH
      `Cls#m` and `Cls.m` in the same file (the shape a `@classmethod` shadowing
      an inherited instance method produces). Assert: - default /
      `spellingOrder` absent → `Cls#m`, byte-identical to today; -
      `spellingOrder: "instanceFirst"` → `Cls#m`, explicitly; -
      `spellingOrder: "classFirst"` → `Cls.m`; - `classFirst` on a class
      declaring ONLY `Cls#m` still finds it — the option reorders, it never
      excludes; - `classFirst` composed with `startAfter: true` still starts
      after the class itself.
- [x] **Step 2 (GREEN — the spelling order).** In `shared.ts`, inside the probe
      `resolvePythonInheritedMember` hands to `findMemberInAncestorChain`:

```ts
const spellings =
  options.spellingOrder === "classFirst"
    ? [`${parsed.classFq}.${member}`, `${parsed.classFq}#${member}`]
    : [`${parsed.classFq}#${member}`, `${parsed.classFq}.${member}`];
for (const spelling of spellings) {
  const inFile = ctx.symbolTable
    .lookup(spelling)
    .filter((def) => def.relPath === parsed.relPath);
  const picked = pickSingleCandidate(inFile, mode);
  if (picked)
    return { targetRelPath: picked.relPath, targetSymbolId: picked.symbolId };
}
return null;
```

      Forward only what the kernel takes, so the new field cannot leak into a
      signature that does not declare it:
      `findMemberInAncestorChain(classKey, linearizer, probe, { startAfter: options.startAfter })`.
      Update the function's docblock: the two-spelling order is now a parameter,
      and the default is the instance-first one every existing caller relies on.

- [x] **Step 3 (RED — the strategy).** New file `python-cls-member.test.ts`,
      modelled on the `selfMember` cases. Build a `CallContext` whose
      `callerScope` is `["Widget"]`, whose `classAncestors` linearizes
      `Widget → Base`, and whose symbol table declares `Base.make` in `base.py`.
      Assert, one case each: 1. `cls.make()` from inside `Widget` →
      `base.py::Base.make`. 2. A class declaring `Widget.make` ITSELF wins over
      the ancestor's — the scan stops at the first owner in the order. 3.
      `Widget#make` (instance spelling only) is still ACCEPTED: `classFirst`
      reorders, it does not decline. This pins decision 2's deviation from the
      orchestrator's parenthetical, whose measured cost is 0 rows. 4. `cls`
      present in `ctx.localBindings` → CONTINUE, nothing resolved, even though
      the enclosing class owns `make`. 5. `cls` present in
      `ctx.callResultBindings` → CONTINUE, same reason. 6. A call at module
      level (`callerScope: []`) → CONTINUE. 7. A member nothing on the MRO owns
      → CONTINUE, **not DROP** (decision 2). 8. `receiver: "self"` → CONTINUE
      untouched, so `selfMember` still owns it. 9. `linearizers` absent
      (walker-v2 shape) → the `classExtends` walk answers, and its miss is also
      CONTINUE.
- [x] **Step 4 (GREEN — the strategy).** New file
      `src/core/domains/language/python/resolver/strategies/python-cls-member.ts`:

```ts
import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import type {
  CallContext,
  CallRef,
} from "../../../../../contracts/types/codegraph.js";
import type {
  SymbolResolutionOutcome,
  SymbolResolutionStrategy,
} from "../../../../../contracts/types/language.js";
import type { PythonAncestorLinearizerCache } from "../python-ancestor-policy.js";
import {
  pythonEnclosingClass,
  resolvePythonInheritedMember,
  walkClassExtendsForMethod,
  type ResolverConfig,
} from "./shared.js";

/**
 * `cls.<member>()` — the class-object twin of `selfMember` (bd tea-rags-mcp-w205u,
 * E4.4). A `cls` receiver inside a class body is the ENCLOSING CLASS, so the
 * question is `selfMember`'s with one difference that matters: a `@classmethod`
 * is filed `Cls.m` and an undecorated `def` `Cls#m`, and all 34 measured rows
 * want the first. Hence `spellingOrder: "classFirst"` rather than a separate
 * lookup — the instance spelling is still ACCEPTED, because `cls.instance_method`
 * is legal Python and declining it would buy 0 measured rows.
 *
 * **Why a strategy of its own and not a widened `selfMember` predicate.** The
 * two idioms differ in preferred spelling, in precision evidence and in
 * terminality, and `answeredBy` has to be able to tell them apart in the A/B.
 *
 * **The precision gate is three facts already on the context**, because
 * `CallContext` carries no decorator channel and this increment adds no walker
 * field: an enclosing class must exist, `cls` must not be a name the walker
 * BOUND here (a `for cls in classes:` loop variable is the one shape that makes
 * `cls` not the class — and `classifyReceiverKind` already files a bound
 * receiver as `localVar`, which is why all 34 rows read `dynamic`), and the MRO
 * must own the member.
 *
 * **Not a guard.** `super` and `selfMember` DROP on a closed hierarchy so a miss
 * cannot fall to `globalShortName` and fabricate. The same argument fits `cls`,
 * but the bar is gross `lost` 0 and a residual dump cannot show what
 * `globalShortName` answers CORRECTLY on `cls.` receivers today. So this pass
 * resolves or CONTINUEs, and the DROP is adopted only on a measurement.
 */
export class PythonClsMemberSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "clsMember";

  constructor(
    private readonly cfg: ResolverConfig,
    private readonly linearizers?: PythonAncestorLinearizerCache,
  ) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (call.receiver !== "cls") return CONTINUE;
    if (clsIsBoundHere(ctx)) return CONTINUE;
    const enclosing = pythonEnclosingClass(ctx);
    if (enclosing === null) return CONTINUE;
    const linearizer = this.linearizers?.for(ctx);
    if (linearizer === undefined) {
      const legacy = walkClassExtendsForMethod(
        enclosing.name,
        call.member,
        ctx,
        this.cfg.mode,
      );
      return legacy ? resolved(legacy) : CONTINUE;
    }
    const { target } = resolvePythonInheritedMember(
      enclosing.key,
      call.member,
      ctx,
      this.cfg.mode,
      linearizer,
      {
        spellingOrder: "classFirst",
      },
    );
    return target ? resolved(target) : CONTINUE;
  }
}

/** Did the walker bind a VALUE to the name `cls` at this site? Then it is not the class. */
function clsIsBoundHere(ctx: CallContext): boolean {
  const local = ctx.localBindings;
  if (local !== undefined && Object.prototype.hasOwnProperty.call(local, "cls"))
    return true;
  const calls = ctx.callResultBindings;
  return (
    calls !== undefined && Object.prototype.hasOwnProperty.call(calls, "cls")
  );
}
```

- [x] **Step 5 (wire).** In `strategies/index.ts`, add
      `export { PythonClsMemberSymbolResolutionStrategy } from "./python-cls-member.js";`
      immediately after the `super` export, so the barrel reads in chain order.
      In `python-chain-factory.ts`, add
      `new PythonClsMemberSymbolResolutionStrategy(cfg, linearizers),` as the
      SECOND entry, after `PythonSuperSymbolResolutionStrategy` and before
      `PythonSelfFieldSymbolResolutionStrategy`. Extend the factory's docblock
      with one sentence naming the guard block. Add the new name to the order
      assertion in `python-chain-factory.test.ts` — an addition to a list, not a
      rewrite.
- [x] **Step 6 (gate).** `npx vitest run tests/core/domains/language/python`,
      `npx tsc --noEmit`. Then the A side of the A/B, five corpora × five runs,
      and the family report on each A dump with the REAL corpus roots. Read it
      per decision 7: netbox `classObjectReceiver` 26 → 9, polar 52 → 36, ugnest
      4 → 3, flask 1 and httpx 0 unchanged; `lost` 0 everywhere; phantom flat;
      `exactReplacedByFan` / `exactReplacedByAmbiguous` 0; no other family
      grows. Chain tally on all five: `drift` 0 and `dispatchDrift` 0.
- [x] **Step 7 (the DROP, measured — do not skip and do not assume).** With the
      A side in hand, count how many `cls.` receiver rows the A run answers via
      `globalShortName` (`answeredBy` on the matched rows, not the residual).
      **If that count is 0 on all five corpora**, change the two CONTINUE
      returns on a MISS to DROP, re-run the A side once per corpus, and keep the
      DROP only if `lost` stays 0 and phantom does not rise. **If it is not 0**,
      keep the CONTINUE, record the count in the commit body, and say so — a
      guard adopted against evidence is E4.1.3 in a smaller frame. Either way
      the strategy's docblock ends up describing what shipped.
- [x] **Step 8 (commit).**
      `feat(language): resolve cls receivers on the enclosing class MRO (w205u)`.
      Body: the 34 rows by corpus, the measured A/B deltas, the Step 7 verdict
      and its count. Trailer
      `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Never push.

### Measured — E4.4a, 2026-09-11

Shipped `PythonClsMemberSymbolResolutionStrategy` at chain index 1, gate as
designed: receiver text exactly `cls`, an enclosing class, `cls` not bound here,
and the MRO owns the member under `spellingOrder: "classFirst"`. Resolve or
CONTINUE. Walker stays **5**.

The binding check is PRESENCE in `localBindings` / `callResultBindings`, not the
binding nearest the call. That is `classifyReceiverKind`'s own test
(`receiver-kind.ts:71`), so the rows the pass admits are exactly the `dynamic`
population the residual dumps measured, and it declines a strict superset of the
at-the-line shadows.

**Row-level A/B**, five corpora × five runs each side,
`--oracle merged --dispatch --workers 8 --samples 500000`. B ran from a detached
archive of `f5f27197f`; A from the worktree.

| corpus |    missed |         match |         edges | phantom | gross lost |
| ------ | --------: | ------------: | ------------: | ------: | ---------: |
| ugnest |   17 → 16 |     771 → 772 |     777 → 778 |   0 → 0 |          0 |
| flask  |   36 → 36 |     330 → 330 |     349 → 349 |   0 → 0 |          0 |
| httpx  |     6 → 6 |     477 → 477 |     499 → 499 |   8 → 8 |          0 |
| netbox |   61 → 44 |   8280 → 8297 |   8691 → 8708 | 26 → 26 |          0 |
| polar  | 475 → 459 | 16341 → 16357 | 17540 → 17561 | 88 → 93 |          0 |

`missed → match`: ugnest **+1**, netbox **+17**, polar **+16** — **34 rows, the
predicted count per corpus exactly**. flask and httpx are byte-identical on
every scored verdict, which is the task's own identity control. Every
receiver-kind row is byte-identical except `dynamic`, the only kind a `cls`
receiver can carry: netbox `dynamic` match 1483 → 1500, polar 2401 → 2417.
`super` is unmoved on both (netbox 248 match / 26 phantom, polar 526 / 20 / 3 /
0 / 10). `exactReplacedByFan` and `exactReplacedByAmbiguous` unchanged on all
five; `chainDrift` and `dispatchDrift` **0** on all 50 oracle runs.

**Family report**, real corpus roots, A side against B side:
`classObjectReceiver` netbox **26 → 9**, polar **52 → 36**, ugnest **4 → 3** —
each the predicted number. What remains in the family is `bareCall` (the
`cls(...)` oracle debt) plus `constant` (the core-member declines); the
`dynamic` sub-shape reads **0** on all three. `superMro` polar **20 → 20**. No
other family moved on any corpus.

**The 5 polar phantoms are a NEW oracle-error class, not a fabrication.**
`agreeExternal` 29084 → 29079 and `phantom` 88 → 93 — the same five rows, all in
`server/polar/models/subscription.py`, all `cls.<x>_statuses()` inside
`class SubscriptionStatus(StrEnum)`. Every one carries `origin: typeshedStub`:
jedi types `cls` on an enum subclass through `enum.pyi` and never reaches the
project, while the chain answers `SubscriptionStatus.<x>_statuses` declared
twenty lines up in the same file. The chain is right and the oracle is wrong.
Polar's phantom rate moves 0.52 % → 0.55 %, **+0.03 pp** against a +0.5 pp bar;
ugnest phantom stays **0**. Recorded as `oracleEnumClsMember` debt beside D9's
other classes, and NOT chased.

**Step 7, the DROP, measured rather than argued.** A DROP variant of the two
miss returns was built in a separate checkout and run against all five corpora:
**0 rows and 0 edges moved anywhere** — match, fileOnly, wrongFile, missed and
phantom identical on every corpus. So the count Step 7 asks for is **0 on all
five**: no `cls.` receiver this pass misses is answered by any later pass today,
and the guard is free. **CONTINUE still ships.** Free is not load-bearing, and
the orchestrator's decision 1 is explicit — measure the DROP, report it, do not
take it. The measurement is what will say when that changes.

**Chain tally**, five corpora × five runs each side: `chainDrift` **0**
everywhere, one distinct run signature per side. Edges ugnest 777 → 778, flask
349 → 349, httpx 499 → 499, netbox 8691 → 8708, polar 17537 → 17558. Polar's
**+21** against the oracle's +16 reconciles exactly: 16 scored rows plus the 5
`agreeExternal → phantom` rows above, which are edges the oracle does not score
as gains.

**Perf**, chain-tally interleaved B/A/A/B, `/usr/bin/time -l`, min of two per
side: netbox wall 15.8 s → 14.6 s (**−7.9 %**), RSS 2358 MB → 2360 MB (**+0.1
%**); polar wall 21.7 s → 20.9 s (**−3.5 %**), RSS 2302 MB → 2360 MB (**+2.5
%**). Both well inside the +25 % wall / +20 % RSS bar. The MRO answer comes from
the run's memoised linearizer, so the arm adds a map read to `cls.` sites and
nothing else.

**Ruby parity**: `ruby-resolver-parity` 42,057 mastodon sites, mismatches 0,
drift 0; `ruby-walker-composition-parity` 500 files, mismatches 0; both against
the main checkout as `--before-root`. Ruby suite 1835 tests green.

**Two harness facts this task hit, reported rather than patched.**
`codegraph-chain-tally.ts` has no Ruby chain spec (`--lang ruby` errors with
"have: python, java"), so the plan's Ruby tally gate cannot run as written and
the two parity spikes carry the control instead. And the oracle harness has no
row-dump flag on this branch: `--json` carries whole per-verdict pools for
`missed` / `wrongFile` / `phantom` / `skippedInProject` at `--samples 500000`
but NOT for `fileOnly`, so a rebuilt ndjson omits the fileOnly population
(netbox 2, polar 51) and those rows are covered by the aggregate columns only.

---

## Task E4.4b — `Cls.m()` on a same-file class: the ancestor hop the arm stops short of (`w205u`)

**Target:** 10 rows, all polar. A class declared in the CALLER'S OWN file,
called by name, whose member is inherited:

```text
backoffice/customers/endpoints.py:1019  UpdateCustomerEmailForm.model_validate_form(…) → BaseForm.model_validate_form
backoffice/customers/endpoints.py:1046  UpdateCustomerEmailForm.render(…)             → BaseForm.render
backoffice/feedbacks/endpoints.py:415   UpdateSupportThreadURLForm.render(…)          → BaseForm.render
backoffice/feedbacks/endpoints.py:477   UpdateFeedbackNoteForm.render(…)              → BaseForm.render
backoffice/customers/endpoints.py:677   CreateBalanceTransactionForm.model_validate_form(…) → BaseForm.model_validate_form
logging.py:152,154                      Development.configure(…)                      → Logging.configure
```

Eight are the form idiom (base in another file, reached through
`from . import forms`); two are `Development(Logging[…])` with the base in the
SAME file, which is the control proving the hop is missing rather than the
cross-file lookup. All 10 read `answeredBy: none`, `chainOutput: none`, and all
10 oracle targets carry the class-level separator. Expected: polar
`missed → match` +10, the other four corpora byte-identical, `lost` 0, phantom
flat.

**Files:**

- `src/core/domains/language/python/resolver/strategies/python-imported-name.ts`
  (MOD)
- `tests/core/domains/language/python/resolver/strategies/python-imported-name.test.ts`
  (MOD)

**Interfaces:** none change. The task adds one private method and one call site.

### Steps — E4.4b

- [ ] **Step 0.** Fresh agent worktree; ff-merge `worktree-py-frontier-e4`
      INCLUDING Task E4.4a's commit — this task depends on
      `spellingOrder: "classFirst"` existing.
      `npx vitest run tests/core/domains/language/python` green. Capture the B
      side of the A/B before editing.
- [ ] **Step 1 (RED).** In `python-imported-name.test.ts`, next to the existing
      same-file class-receiver block, add cases where the caller's file declares
      `class Child(Base)` and `Base` — in the SAME file for one case and in
      another file for a second — declares `Base.make`. Assert: 1.
      `Child.make()` resolves to `Base.make`, base in another file. 2.
      `Child.make()` resolves to `Base.make`, base in the SAME file (the
      `Development` control). 3. `Child.make` declared on `Child` itself still
      wins — the two-spelling same-file lookup runs FIRST and the fallback is
      never reached. 4. `Child#make` on the ancestor is still accepted
      (`classFirst` reorders, it does not exclude). 5. A receiver the caller's
      file declares TWICE declines — `pythonBoundClassKey` returns `null` and
      the arm CONTINUEs. 6. A receiver the caller's file does not declare at all
      → CONTINUE, unchanged, so `resolveStarImport` below still gets its
      turn. 7. A member no class on the MRO owns → CONTINUE, **not DROP**: this
      arm's CONTINUE is what lets `resolveStarImport` run, and turning it into a
      DROP would silently remove that path. 8. `linearizers` absent (walker-v2
      shape) → CONTINUE, byte-identical to today.
- [ ] **Step 2 (GREEN).** In `python-imported-name.ts`, change the last line of
      `resolveSameFileClassReceiver` from `return CONTINUE;` to
      `return this.resolveSameFileInheritedMember(call, ctx);`, and add the
      method immediately below it:

```ts
  /**
   * The same-file class-receiver arm's ancestor fallback — the hop
   * {@link resolveDeclaredName} has had since bd tea-rags-mcp-9fgdi and this arm
   * has not (bd tea-rags-mcp-w205u, E4.4). polar declares a form class in the
   * endpoint file that calls it and inherits `render` / `model_validate_form`
   * from a `BaseForm` a module away; the two-spelling lookup above is filtered
   * to the caller's file, so it can never see the ancestor's declaration.
   *
   * `pythonBoundClassKey` IS the precision gate: it returns `null` unless the
   * caller's file declares exactly ONE symbol of that name, so a shadowed or
   * duplicated receiver declines rather than picking. A receiver that names a
   * top-level `def` rather than a class passes that gate and is still harmless —
   * a non-class has no `classAncestors` entry, the order is the key alone, and
   * the probe then repeats the two lookups the loop above already made and
   * finds nothing. The fallback can only ever answer from an ANCESTOR.
   *
   * `spellingOrder: "classFirst"` for the same reason `clsMember` uses it: the
   * receiver is a CLASS OBJECT, and all 10 measured rows resolve to a
   * `@classmethod` / `@staticmethod` filed `Cls.m`. The instance spelling stays
   * accepted underneath it.
   *
   * Resolve-or-CONTINUE, never DROP. This arm's CONTINUE is what lets
   * `resolveStarImport` run below it, and the imported-class arm's DROP is
   * earned by evidence this one does not have — an import statement naming the
   * declaring file.
   */
  private resolveSameFileInheritedMember(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (!call.receiver) return CONTINUE;
    const linearizer = this.linearizers?.for(ctx);
    if (linearizer === undefined) return CONTINUE;
    const classKey = pythonBoundClassKey(call.receiver, ctx.callerFile, ctx);
    if (classKey === null) return CONTINUE;
    const { target } = resolvePythonInheritedMember(classKey, call.member, ctx, this.cfg.mode, linearizer, {
      spellingOrder: "classFirst",
    });
    return target ? resolved(target) : CONTINUE;
  }
```

      `pythonBoundClassKey` and `resolvePythonInheritedMember` are both already
      imported by this file (`resolveInheritedMember` uses the second, and the
      first is exported from `./shared.js`); add whichever is missing to the
      existing import block rather than a new one. Update
      `resolveSameFileClassReceiver`'s docblock: the sentence "No short-name
      search, no MRO walk, no DROP" becomes "No short-name search and no DROP;
      the MRO walk is {@link resolveSameFileInheritedMember}" — the no-short-name
      and no-DROP halves are still true and still load-bearing.

- [ ] **Step 3 (gate).** `npx vitest run tests/core/domains/language/python`,
      `npx tsc --noEmit`. Then the A side, five corpora × five runs, plus the
      family report. Read it: polar `classObjectReceiver` 36 → 26 (or 52 → 42 if
      this task runs before E4.4a), every other corpus byte-identical on that
      family, `lost` 0, phantom flat, `exactReplacedByFan` /
      `exactReplacedByAmbiguous` 0, no other family grows. Chain tally on all
      five: `drift` 0, `dispatchDrift` 0.
- [ ] **Step 4 (the one thing to look at twice).** netbox has 437 `wrongFile`
      rows historically owned by this file's module arm. Confirm the netbox
      `wrongFile` count is UNCHANGED — the new fallback sits inside the
      same-file arm, which netbox's module receivers never reach, so any
      movement there is an unintended widening and the task stops until it is
      explained.
- [ ] **Step 5 (commit).**
      `feat(language): walk the MRO for a same-file class receiver (w205u)`.
      Body: the 10 rows, the two idioms, the measured deltas, and the Step 4
      control reading. Trailer
      `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Never push.

---

## Task E4.4c — The `super()` residual: measure the 19, diagnose the 3, fix only what the diagnosis names (`w205u`)

**Target:** the 23 `superMro` rows, split by decision 5 into 19 that belong to
E4.6a, 3 that are a chain defect, and 1 `Protocol` base. This task ships a
MEASUREMENT and, conditionally, a bounded fix. It does not ship a redesign of
`python-super.ts`, and 4 rows does not justify one.

**Precondition:** E4.6a must be merged into `worktree-py-frontier-e4` before
Step 1 runs. If it is not, this task STOPS at Step 0 and reports — running the
re-measure against a branch without the mapper arm produces a number that means
nothing, and re-running it later costs another five-corpus sweep.

**Files:**

- `tests/core/domains/language/python/resolver/strategies/python-super-sibling.test.ts`
  (NEW)
- `src/core/domains/language/python/resolver/strategies/python-super.ts` (MOD —
  **only** if Step 2 names a fix)

### Steps — E4.4c

- [ ] **Step 0.** Fresh agent worktree; ff-merge `worktree-py-frontier-e4`.
      Confirm E4.6a's `resolveExportedModule` is present in
      `python-import-file-mapper.ts`; if it is not, STOP and report that the
      precondition is unmet. `npx vitest run tests/core/domains/language/python`
      green.
- [ ] **Step 1 (the 19 — measure, do not implement).** Run the oracle on polar
      alone, five runs, and the family report with the real corpus root. Read
      `superMro` on the A side and record it against the pre-E4.6a baseline
      of 23. Three outcomes, each with its own action: - **superMro ≤ 4** —
      E4.6a's mapper arm reached `resolveBaseKey` through
      `createPythonAncestorPolicy`, the 19 closed for free, and the decision-5
      prediction is confirmed. Record the number and move on. - **superMro still
      23** — the mapper arm did NOT reach the ancestor policy. Open the 19 rows
      and check whether
      `resolveBaseKey → resolveOneBaseSpelling → mapper.mapImportToFile` now
      maps `..components.datatable`. If it does not, the missing edge is that
      one call site and the fix is one line; if it does and the rows still miss,
      the break moved and this task reports rather than guesses. - **anything in
      between** — split the 19 by base module and say which subset closed. Do
      not average.
- [ ] **Step 2 (the 3 — diagnose before touching anything).** The three rows are
      `checkout/service.py:182`,
      `customer_portal/service/customer_session.py:52` and
      `integrations/stripe/payment.py:42`, each `super().__init__(message)`
      inside a `PolarError` descendant, each answered `PolarTaskError#__init__`
      where the oracle says `PolarError#__init__`. Determine WHICH of the two
      candidate mechanisms produces it, by instrumenting `resolveSuper` with a
      temporary log of `enclosing.key`, the linearized order and the closure for
      those three call sites, running polar once, and reverting the
      instrumentation: - **If `closure !== "closed"`** the
      `resolveSuperViaClassExtends` fallback ran FIRST and produced the answer.
      Note that its lookups are NOT filtered by the candidate's file, where
      `resolvePythonInheritedMember`'s are — that asymmetry is the first
      suspect, and the fix is a file filter on the legacy walk, not a change to
      the MRO path. - **If `closure === "closed"`** the MRO itself contains
      `PolarTaskError`, which means `resolveBaseKey` bound the base `PolarError`
      to the wrong declaration. The fix is then in `python-ancestor-policy.ts`,
      which is E4.6a's file — hand it over as a bead rather than editing it
      here. Write the finding down before writing any code. Three rows do not
      buy a speculative edit.
- [ ] **Step 3 (RED, conditional).** ONLY if Step 2 named a mechanism inside
      `python-super.ts`: new file `python-super-sibling.test.ts` reproducing the
      shape from hand-built context — a caller file declaring `class Child(Mid)`
      and `class Mid(Root)`, another file declaring `Root#__init__` and a
      SIBLING `Other(Root)` with its own `Root`-shadowing `__init__`, and a
      chunk-scoped `classExtends` that stops one hop in. Assert
      `super().__init__()` from `Child` resolves to `Root#__init__` and never to
      `Other#__init__`.
- [ ] **Step 4 (GREEN, conditional).** The minimal fix the diagnosis named. Keep
      `super`'s guard terminality intact: it still DROPs on a miss, and the
      change is which candidate it accepts, never whether it falls through.
      Re-run the full python suite plus the A/B on polar and netbox.
- [ ] **Step 5 (the netbox control — mandatory whatever Steps 3–4 did).** netbox
      carries D9's 11 `oracleWrongMro` rows, where jedi's cooperative-MI answer
      is known wrong and the chain is right. Confirm netbox's `superMro` count
      and its `super()`-answered match count are BOTH unchanged. **Movement in
      either direction is a regression signal** — a "gain" there is the chain
      being dragged onto a wrong oracle answer.
- [ ] **Step 6 (the 1).** `base.py:187`, `super().get_base_statement()` on a
      `Protocol` base in the caller's own file. Record what the A side does with
      it and file it as a bead if it still misses. One row is not an increment.
- [ ] **Step 7 (commit).** `fix(language): …(w205u)` if a fix shipped, otherwise
      `docs(plans): record the E4.4 super residual measurement (w205u)`. Body:
      the three-way Step 1 outcome with its number, the Step 2 finding, and the
      Step 5 control reading. Trailer
      `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Never push.

---

## Task E4.4-close — Gates, navigators, and the measurement record (`w205u`)

Its own task rather than a fold into E4.6-close: this plan carries three
implementation tasks, its own D-record row in the spec, and a `superMro`
measurement that lands after E4.6 has already closed.

**Files:**

- `src/core/domains/language/python/CLAUDE.md` (MOD)
- `src/core/domains/language/python/capability.ts` (MOD — codegraph tech text
  only)
- `docs/superpowers/specs/2026-09-10-python-frontier-e4-design.md` (MOD — D11)
- `docs/superpowers/plans/2026-09-10-python-e4-4-class-object-receivers.md`
  (MOD)

### Steps — E4.4-close

- [ ] **Step 0.** Fresh agent worktree; ff-merge `worktree-py-frontier-e4` with
      E4.4a, E4.4b and E4.4c on it.
- [ ] **Step 1 (full unit gate).** `npm run build`, then `npm run test:coverage`
      — the release gate, not `npm test`. Then `npx tsc --noEmit`. A worktree
      with no `build/` fails every worker-forking spec, so the build comes
      first. Do NOT `npm link` and do NOT reindex.
- [ ] **Step 2 (Ruby parity control).**
      `npx vitest run tests/core/domains/language/ruby tests/scripts/ruby-resolver-parity.test.ts`
      and
      `npx tsx scripts/codegraph-chain-tally.ts --corpus mastodon --lang ruby`.
      Both must be byte-identical to the pre-E4.4 branch. No Ruby file was
      edited, so any drift is a shared-helper leak and stops the close.
- [ ] **Step 3 (perf).** chain-tally on netbox AND polar, interleaved B/A/A/B,
      min of each side. Wall ≤ +25 %, peak RSS ≤ +20 %. The new arms add one
      memoised MRO scan per `cls.` / same-file-class receiver, so the expected
      delta is inside the noise; a number outside the bar means an arm is
      building its own linearizer instead of taking
      `this.linearizers?.for(ctx)`.
- [ ] **Step 4 (the combined A/B).** One final five-corpus × five-run sweep
      against the pre-E4.4 baseline, plus the family report on every A dump.
      Fill in this table with MEASURED numbers, replacing the predictions:

| corpus | `classObjectReceiver` 83 → ? | `superMro` 23 → ? | `missed → match` | `fileOnly → match` | `lost` | phantom Δ |
| ------ | ---------------------------: | ----------------: | ---------------: | -----------------: | -----: | --------: |
| ugnest |                4 → 3 (pred.) |                 — |       +1 (pred.) |                  0 |      0 |   0.00 pp |
| flask  |                1 → 1 (pred.) |                 — |        0 (pred.) |                  0 |      0 |   0.00 pp |
| httpx  |                        0 → 0 |                 — |                0 |                  0 |      0 |   0.00 pp |
| netbox |               26 → 9 (pred.) |  control, no move |      +17 (pred.) |                  0 |      0 |   0.00 pp |
| polar  |              52 → 26 (pred.) |    23 → ? (E4.4c) |      +26 (pred.) |    0 or +3 (E4.4c) |      0 |   0.00 pp |

- [ ] **Step 5 (navigator).** Add exactly two invariants to
      `src/core/domains/language/python/CLAUDE.md`, both local knowledge a green
      suite misses, both LINKING rather than restating: (1) `cls` is the
      enclosing class and `clsMember` owns it — a pass that widens `selfMember`
      to `self | cls` breaks the `answeredBy` split the A/B reads; (2) the
      class-receiver arms prefer the `Cls.m` spelling via
      `spellingOrder: "classFirst"`, and the DEFAULT stays instance-first
      because `selfMember` and `super` depend on it. Do not restate decision 3
      or 6 — link this plan.
- [ ] **Step 6 (capability text).** Update the codegraph tech description in
      `capability.ts` to name the class-object receiver. `versions.walker`
      STAYS 5. Run `npm run gen:lang-compat` and commit the regenerated
      artifacts only if the generator's output actually moves.
- [ ] **Step 7 (the record).** Add **D11** to the spec's decision record: the
      E4.4 sub-shape attribution (both tables from decision 1 verbatim), the 44
      addressable rows, the 32-row `cls(...)` oracle-debt finding with its
      mechanism, the 19+3 rows handed to E4.6a's mapper, and the measured
      results from Step 4. State plainly that `type(self)`, `self.__class__`,
      two-argument `super()` and `typeVarGeneric` all measured ZERO on five
      corpora — a null result that removes four branches from every later
      increment is worth as much as the gain. Then fill this plan's own tables
      with the measured numbers so the predictions and the outcomes sit side by
      side.
- [ ] **Step 8 (commit).**
      `docs(plans): record the measured E4.4 results (w205u)` and
      `docs(language): note the class-object receiver invariants (w205u)`.
      Trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Never
      push. Live validation stays user-gated and is NOT part of this gate.

---

## Task order, and what each one unblocks

1. **E4.4a** first. It introduces `spellingOrder`, which E4.4b consumes, and it
   is the largest single sub-shape in the plan (34 of 44 rows).
2. **E4.4b** second, on top of E4.4a. Ten rows, one call site, no new concept.
3. **E4.4c** third, and ONLY after E4.6a has merged. It is a measurement with a
   conditional fix, and running it early wastes a five-corpus sweep.
4. **E4.4-close** last.

E4.4a and E4.4b touch disjoint files apart from `shared.ts`, which E4.4b only
reads. They could run in parallel if E4.4b's executor is handed E4.4a's
`spellingOrder` diff — but the sequence is two burst-hours and parallelising it
buys nothing worth the merge.

---

## What this plan does NOT claim

- **It does not claim 106 rows.** It claims 44, hands 22 to E4.6a's mapper,
  records 32 as oracle debt, and folds 8 with counts. The gap between 106 and 44
  is decision 6, not optimism.
- **It does not claim `cls(...)` is answerable.** Both oracle engines resolve a
  `cls` parameter to its `def` line, and the harness attributes that line to the
  enclosing method. Until the harness learns to withdraw a non-callable oracle
  answer — D9's `oracleNonCallable` class — those 32 rows are unscoreable by
  construction, and emitting a constructor edge for them SPENDS precision.
- **It does not claim the `super()` MRO is fixed.** 19 of the 23 rows are a
  mapper question, 3 are a defect this plan diagnoses rather than assumes, and 1
  is a `Protocol` base. E4.4c can legitimately end with a bead and no code.
- **It does not chase D9's `oracleWrongMro`.** netbox's 11 cooperative-MI rows
  are jedi being wrong; netbox's `superMro` count is a control that must not
  move, in either direction.
- **It does not touch the walker, the kernel, Ruby, the dispatch component or
  the external vocabulary.** Every one of those is another executor's file set,
  and decision 6 names the three rows that would tempt an executor across the
  vocabulary boundary.
- **The numbers are branch-relative.** Everything here is measured against
  `worktree-py-frontier-e4` at `824d6998a`, with E4.6a NOT yet merged. Where
  E4.6a's landing can move a count it is said so in place: decisions 5 and 6,
  and Task E4.4c's precondition.
