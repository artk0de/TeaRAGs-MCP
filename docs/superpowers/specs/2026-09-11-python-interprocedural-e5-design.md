# Python Inter-Procedural E5 — Design

**Status:** measured, and the capability increment is GATED SHUT by its own
measurement (2026-09-11) **Kind:** epic (one measurement increment, two
capability increments that do not currently qualify to ship) **Related:**
Frontier E4 (`docs/superpowers/specs/2026-09-10-python-frontier-e4-design.md`) —
D8 (family attribution), D9 (`OW:*` oracle-wrong classes, incl.
`oracleWrongSelf`), D10 (the falsified name-only dispatch and what a re-attempt
needs); `tea-rags-mcp-f11nz` / `6pd5l` / `zhetx` (open from the program)
**Worktree:** `.claude/worktrees/py-frontier-e4` at `7d80ae741`; E5 work
branches as `worktree-py-frontier-e5`

**Name, stated once.** _Inter-procedural parameter typing_ means: give an
unannotated parameter a type by reading the ARGUMENTS its resolved call sites
pass. It is not fan-out, not naming convention, not a return-type fold. Where
this document says "the mechanism" without qualification, that is what it means.

---

## Goal

E4.1.3 falsified name-only dispatch (D10) and named what a re-attempt needs
first: **receiver-type evidence, not member names.** E5 was called to supply one
class of that evidence — the type an unannotated parameter must have, inferred
from the call sites that pass it — on the theory that three residual families
would fall to it at once:

1. `untypedNameReceiver` (~235 polar rows after E4.6b-1) where the receiver is
   an unannotated parameter of the enclosing `def`;
2. E4.6's `sameFileBareCall` NAME_DIFF rows — parameter-bound callables,
   `def run(cb): cb()`;
3. E4.6c's declined `self.f = <unannotated param>`.

The mechanism is precision-safe only under AGREEMENT: every resolved in-project
call site passes the same project type. That is a real constraint and it is
cheap to check, so E5.0 checks it BEFORE E5.1 is built. This document records
the check and the number it produced.

**The number is 5.** Across five corpora, at exact agreement, with the member
confirmed declared on the agreed class, inter-procedural parameter typing
unlocks **5 residual rows** against a go/no-go bar of 100. LUB-by-MRO adds
**zero** — not one `def` in the population disagreed in a way an MRO join could
repair, because almost none had more than one determinable site to disagree
about. The premise is not marginally short; it is short by 20×, and it is short
for a structural reason the attribution names precisely (D3).

So E5.0 is the increment that ships, E5.1 and E5.2 are specified in full and
left GATED, and the value of this document is the redirect in D4: where the mass
the mechanism was supposed to reach actually sits, measured on the same rows.

---

## Ceiling map — the residual E5 was called for, 2026-09-11

Post-E4.6b-1 dumps (`~/.claude/jobs/dffe3647/tmp/e46b1/after-*.ndjson`, tree
`7d80ae741`), `--oracle merged --dispatch`. Residual is
`missed | fileOnly | wrongFile | skippedInProject`; every residual row on every
corpus carries `dispatch.oracleInProject: true`, so a row whose oracle target is
EXTERNAL is not in this population at all — checked, 548/548 on polar, 61/61 on
netbox (D2).

| corpus | residual rows | of which bare-name receivers |
| ------ | ------------- | ---------------------------- |
| ugnest | 24            | 3                            |
| flask  | 42            | 22                           |
| httpx  | 13            | 5                            |
| netbox | 61            | 40                           |
| polar  | 548           | 266                          |
| total  | **688**       | **336**                      |

"Bare-name receiver" = `receiverKind ∈ {dynamic, localVar, selfMember}` with an
undotted identifier as the receiver text. That is the population
`untypedNameReceiver` is drawn from and the only population the mechanism can
address at all — a dotted receiver is a field hop (E4.6c) and a `chain` receiver
is a call-result head (E4.6b).

---

## E5.0 A — what a bare-name residual receiver is actually bound BY

### The instrument

A binding classifier over the caller's own source: from the call line, walk up
to the enclosing `def` and ask what statement bound the receiver name. Exactly
one answer per row, precedence most-specific-first, `unbound` reported rather
than hidden — the same discipline as `scripts/lib/py-residual-families.ts`, one
level finer. It ships as `scripts/lib/py-receiver-binding.ts`
(`classifyReceiverBinding`, `enclosingPythonDef`), driven by
`scripts/py-e5-interprocedural-report.ts`. The vocabulary is fixed here and is
the same string set the E5.0a script emits and the plan's tables use:

`paramUnannotated`, `paramAnnotated`, `loopTarget`, `comprehension`,
`tupleUnpack`, `walrus`, `exceptAs`, `withAs`, `assignCallProject`,
`assignCallExternal`, `assignAlias`, `assignOther`, `moduleLevel`, `unbound`.

`self` and `cls` are NOT parameters for this purpose. They are the class-object
family E4.4 owns, and counting them as unannotated parameters is the single
mistake that makes this measurement look promising when it is not — the first
prototype run scored polar's `paramUnannotated` at 10 rows, every one of them a
`cls` receiver inside a `@classmethod`.

### The table (prototype run, 2026-09-11, `/tmp/e5attr`)

Rows, not sites; a call site in two overlapping chunks is counted twice, exactly
as every rate this program publishes is.

| binding                | ugnest | flask | httpx | netbox | polar   | total   |
| ---------------------- | ------ | ----- | ----- | ------ | ------- | ------- |
| `assignCallProject`    | 0      | 1     | 0     | 7      | **135** | **143** |
| `unbound`              | 1      | 11    | 0     | 18     | 26      | 56      |
| `paramAnnotated`       | 0      | 0     | 0     | 0      | **50**  | **50**  |
| `loopTarget`           | 0      | 1     | 5     | 5      | 19      | 30      |
| `assignAlias`          | 0      | 4     | 0     | 0      | 20      | 24      |
| `assignCallExternal`   | 2      | 3     | 0     | 1      | 7       | 13      |
| `tupleUnpack`          | 0      | 1     | 0     | 1      | 4       | 6       |
| **`paramUnannotated`** | **0**  | **1** | **0** | **4**  | **0**   | **5**   |
| `assignOther`          | 0      | 0     | 0     | 0      | 4       | 4       |
| `walrus`               | 0      | 0     | 0     | 4      | 0       | 4       |
| `exceptAs`             | 0      | 0     | 0     | 0      | 1       | 1       |
| `comprehension`        | 0      | 0     | 0     | 0      | 0       | 0       |
| `withAs`               | 0      | 0     | 0     | 0      | 0       | 0       |
| `moduleLevel`          | 0      | 0     | 0     | 0      | 0       | 0       |
| **total**              | 3      | 22    | 5     | 40     | 266     | **336** |

**`paramUnannotated` is 5 rows of 336, and 0 of polar's 266.** polar is the
corpus that carries 235 of the `untypedNameReceiver` mass D8 pointed E5 at, and
not one of those rows has an unannotated parameter as its receiver.

### Five rows read by hand, one per major bucket

- `assignCallProject` —
  `server/polar/backoffice/organizations_v2/endpoints.py:871`
  `review_repo.get_latest_agent_review(organization_id)`, bound at :870 by
  `review_repo = OrganizationReviewRepository.from_session(session)`. The head
  is a `-> Self` classmethod in `kit/repository/base.py:165` and it is the same
  shape D9's `oracleWrongSelf` names. 135 polar rows.
- `paramAnnotated` — `server/polar/billing_entry/service.py:344`
  `price.get_unit_noun(old_units)`, `price` an ANNOTATED parameter of
  `_get_static_price_line_item`. The annotation exists and the chain still
  misses, so this is a narrowing failure (union / generic head), not a missing
  fact. 50 polar rows.
- `loopTarget` — `server/polar/backoffice/components/_datatable.py:566`
  `action.render(request, item)` under `for action in displayed_actions:`. The
  answer is the element type of a container, which is E4.5's rule, not E5's.
- `unbound` — `server/polar/invoice/generator.py:354`
  `cls.cjk_font_name_for_script(s)`. `cls` inside a `@classmethod`: E4.4's
  `classObjectReceiver`, and 32 of its rows are oracle debt (D5).
- `paramUnannotated` — `netbox/core/api/schema.py:392`
  `auto_schema.resolve_serializer(serializer, direction)` inside
  `def map_serializer_field(self, auto_schema, direction, ...)`. Two call sites,
  both determinable, both `DummyAutoSchema`. This is the shape E5.1 exists for,
  and it is one row.

---

## E5.0 A2 — the agreement tables

For every `def` that owns a candidate row, every occurrence of its name in the
corpus is opened, the argument bound to the parameter is extracted (kwarg first,
then positional with the `self`/`cls` slot removed), and the argument expression
is typed from facts that already exist: a constructor call of a project class, a
typed local, a typed field, another typed parameter. A site whose argument types
to nothing is DETERMINABLE-NO and counted, never dropped.

Per `def`, the verdict is one of: `exact` (one distinct project type over ≥1
determinable site), `lub` (>1 distinct type with a common MRO ancestor),
`disagree` (>1 type, no common ancestor), `noDeterminable` (sites exist, none
types), `noCallSites`. `resolvable` counts the ROWS under an `exact`/`lub`
verdict whose `member` is declared on the agreed class or an ancestor — the only
column that means "this row would actually resolve".

### Bucket A — receiver is an unannotated parameter

| corpus | rows  | defs | exact | lub   | disagree | noDeterminable | noCallSites | **resolvable** |
| ------ | ----- | ---- | ----- | ----- | -------- | -------------- | ----------- | -------------- |
| ugnest | 0     | 0    | 0     | 0     | 0        | 0              | 0           | 0              |
| flask  | 1     | 1    | 1     | 0     | 0        | 0              | 0           | **1**          |
| httpx  | 0     | 0    | 0     | 0     | 0        | 0              | 0           | 0              |
| netbox | 4     | 3    | 1     | 0     | 0        | 3              | 0           | **1**          |
| polar  | 0     | 0    | 0     | 0     | 0        | 0              | 0           | 0              |
| total  | **5** | 4    | **2** | **0** | 0        | 3              | 0           | **2**          |

### Bucket D — parameter-bound callables (`def run(cb): cb()`)

Here the "type" is a callable REFERENCE — a project class or a project `def`
name passed as an argument — and `resolvable` needs no member check.

| corpus | rows  | defs | exact | lub   | disagree | noDeterminable | **resolvable** |
| ------ | ----- | ---- | ----- | ----- | -------- | -------------- | -------------- |
| ugnest | 1     | 1    | 0     | 0     | 1        | 0              | 0              |
| flask  | 0     | 0    | 0     | 0     | 0        | 0              | 0              |
| httpx  | 0     | 0    | 0     | 0     | 0        | 0              | 0              |
| netbox | 2     | 2    | 0     | 0     | 1        | 1              | 0              |
| polar  | 3     | 3    | **3** | 0     | 0        | 0              | **3**          |
| total  | **6** | 6    | **3** | **0** | 2        | 1              | **3**          |

polar's three are one shape: `dev/cli/commands/snap.py` passes the module-level
`set_status` into `_dev_up` / `_start_api` / `_start_web`, which call `cb(...)`.

### Bucket E — `self.f = <unannotated parameter>`

| corpus | rows  | defs | exact | noDeterminable | **resolvable** |
| ------ | ----- | ---- | ----- | -------------- | -------------- |
| netbox | 1     | 1    | 0     | 1              | 0              |
| others | 0     | 0    | 0     | 0              | 0              |
| total  | **1** | 1    | **0** | 1              | **0**          |

The brief's "27" for this shape is a misread of the E4.6 plan. That plan's table
(`2026-09-10-python-e4-6-typed-residuals.md:241`) measures `self.f = param`
(unannotated parameter) at **1 row corpus-wide** and marks it `out`; 27 is the
whole `untypedFieldHop` DECLINED remainder — flask proxies, two-hop chains
needing an inherited class-field fact, one unannotated param, two `Literal[…]`
(line 351). Independent re-measurement here reproduces the 1.

### Go / no-go

|                                         | exact | LUB   |
| --------------------------------------- | ----- | ----- |
| rows unlocked, all buckets, all corpora | **5** | **5** |
| bar                                     | 100   | 100   |

**NO-GO.** LUB-by-MRO is not the lever: it buys zero rows, because the
population is too small to contain a disagreement an MRO join could repair. Per
corpus, the whole of E5.1 + E5.2 is: polar +3, netbox +1, flask +1, httpx 0,
ugnest 0.

---

## E5.0 B — oracle debt, and why it is a re-scoring pass and not a merge-rule change

### The debt, itemised

Three classes of residual row are the ORACLE being wrong, not the chain. They
inflate every recall denominator they sit in and E4.6-close / E4.4 are expected
to subtract them.

| class                  | rows   | corpora              | what is wrong                                                                                                                                                                  |
| ---------------------- | ------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cls(...)` constructor | **32** | polar, netbox, flask | Both engines answer the ENCLOSING classmethod, because `cls` is a parameter whose definition line IS the `def` line. No chain answer can score. (E4.4 plan, decision 3.)       |
| `OW:Self`              | **14** | polar                | jedi resolves a `-> Self` classmethod result to the DECLARING class, so every subclass override scores against the base. pyright and the runtime say the receiver class. (D9.) |
| `OW:Mro`               | **11** | netbox               | jedi's cooperative-MI answer differs from the C3 target. (D9.)                                                                                                                 |
| total (recall side)    | **57** |                      |                                                                                                                                                                                |

Two further D9 classes — `OW:EnumClassmethod` 18 (httpx 4, polar 14) and
`OW:ShadowedPackage` 8 (polar) — are PHANTOM-side and are already subtracted
from `precisionMissAdjusted`. E5.0b does not touch them; it re-scores them only
to prove the pass reproduces D9's numbers on a class it did not change.

### Why not a per-site merge rule

The merge is per FILE on purpose and the reason is stateful, not stylistic: jedi
holds a per-process module cache and `jedi_oracle.py:539` stripes files across
workers with `maxtasksperchild=1` precisely because `imap(chunksize=4)` moved a
flask site between `external` and `unknown` run to run. Mixing engines WITHIN a
file puts two module resolutions behind one `jedi.Script` cache and makes row
provenance unreadable. The E4 spec states the rule as asymmetric by design —
"the second engine is a REPAIR for files jedi could not read, never a tiebreak
on files it could" — and a per-CLASS-of-site override is exactly that forbidden
tiebreak wearing a narrower name.

### The shape that IS allowed

**A re-scoring pass over dumps, downstream of the harness, changing no oracle
call.** It reads an existing row dump, selects rows in a named debt class by a
pure predicate over row fields, and emits a corrected denominator ALONGSIDE the
raw one — never in place of it, exactly as `recallLegacy` / `recallMerged` sit
side by side.

One blocking defect the pass has to fix first, and it is in the dump rather than
in the pass. `PyResidualRow` declares `oracleTargetRelPath` and
`oracleTargetSymbolId` (`scripts/lib/py-residual-families.ts:36-37`) and **the
e46b1 dumps carry neither field.** The consequence is visible: re-running
`scripts/py-e4-family-report.ts` over `after-polar.ndjson` splits polar's bare
calls `sameFileBareCall` 0 / `crossFileBareCall` 110, where D8 recorded 140 / 31
across the corpora — the same-file test is
`row.oracleTargetRelPath === row.relPath` and it is comparing against
`undefined` on every row. Any re-scoring that needs to know what the oracle
answered needs those two fields emitted. That is E5.0b Task step 1, and it is
also why the E5.0a attribution above is stated over binding shapes (readable
from the caller's source) rather than over oracle targets.

With the fields present the pass is three predicates:

```text
clsConstructor  : receiverKind === "bareCall" && member === "cls"
                  && oracleTargetSymbolId names the enclosing classmethod
oracleWrongSelf : chain.targetSymbolId and oracleTargetSymbolId share a member
                  name, and the oracle's class is an ANCESTOR of the chain's
oracleWrongMro  : both targets declare the member and neither class is an
                  ancestor of the other
```

`oracleWrongSelf` and `oracleWrongMro` are decidable from the dump plus the
run's ancestry, with no engine call at all. `clsConstructor` needs the oracle
target and nothing else. Only rows the predicates cannot settle need a pyright
answer, and those are quoted per site from `scripts/py-oracle/lsp_oracle.ts`
driven directly on the site list — the same instrument D9 used for `OW:Self`'s
14 of 14, and a measurement artefact rather than a harness mode. The pass is
`scripts/py-e5-oracle-debt.ts`.

### What it changes downstream

`recallDebtAdjusted` per corpus, printed next to `recallMerged` and never
replacing it. E4.6-close subtracts polar's 14 `OW:Self` rows from its gross-lost
column (D9 already books them as an instrument reading); E4.4 subtracts the 32
`cls(...)` rows from its own 106-row family before claiming any gain, which its
decision 3 already states it will.

---

## E5.1 — the engine, which is already built

**There is no new engine to write, and there is no worklist fixpoint.** The
mechanism this document was called to design shipped for Ruby as bd
`tea-rags-mcp-bvalc`, "Interprocedural PARAMETER typing at the pass-1→pass-2
barrier, Increment 1", and it lives at
`src/core/domains/trajectory/codegraph/symbols/call-arg-param-types.ts` (186
lines). Reading it settles decisions 2, 3 and 4 of the brief at once.

### What exists

| export                            | what it does                                                                                                            |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `foldKnownTargetParamTypes`       | Folds `KnownTargetCallArgs` records into `"<coordinate>" → paramName → TypeRef`, agreement-only.                        |
| `deriveClassFieldTypesFromParams` | Joins `classFieldParamLinks` (`class → field → {method, param}`) against the folded param types — bucket E's mechanism. |
| `seedParamLocalBindings`          | Seeds a chunk's `localBindings` at the def line with the derived param types, and only where nothing is already bound.  |
| `mergeDerivedClassFieldTypes`     | Overlays derived field types UNDER a file's own, by identity when empty.                                                |

The agreement rule is already the one the brief specifies, and it is stated in
the file's own words: a single uncontradicted witness binds; an ABSENT hint
neither votes nor vetoes; **any disagreement is silence for that position**; it
never majority-votes. `typeRefEquals` is structural and treats `{class, Firm}` /
`{instance, Firm}` as a DISAGREEMENT, because the resolver dispatches them to
different definitions.

Consumption is already the channel the brief asks for:
`resolution-runner.ts:351` calls `seedParamLocalBindings` on every chunk, so a
derived param type is read by `localBinding` exactly as `def f(var: Cls)` is —
the strategy's own docstring lists that annotation form as its input
(`python-local-binding.ts`). Nothing new is consumed and nothing new is
persisted.

### Where it runs, and why there is no fixpoint

`run-state.ts:937-940`, inside the pass-1→pass-2 barrier:

```ts
if (this.knownTargetCallArgs.size > 0) {
  this.paramTypes = foldKnownTargetParamTypes(this.knownTargetCallArgs.values(), this.paramNames);
  this.derivedClassFieldTypes = deriveClassFieldTypesFromParams(this.classFieldParamLinks, …);
}
```

Pass 1 (`RunState#absorb`, `run-state.ts:1347-1354`) merges every file's
`knownTargetCallArgs`, `paramNames` and `classFieldParamLinks` into run-global
maps as the files stream in; the barrier folds them once, **before a single call
is resolved**. That is why no fixpoint is needed and why depth bounds are moot:
the fold reads ONLY call sites whose callee is known from SYNTAX and needs no
resolution at all — `Firm::Service.new(x)` targets `Firm::Service#initialize`
however the rest of the program resolves. A call site whose callee is only known
AFTER resolution is out of Increment 1's population by construction, and that
restriction is what buys determinism: the fold's input is a set merged from
per-file extractions, its output depends on no iteration order, and disagreement
collapses to silence rather than to a winner.

### Persistence — decided, and measured, before E5 asked

`contracts/types/codegraph-pass1.ts:117` records the ablation:
`scripts/spikes/ruby-incremental-runglobal-delta.ts` on taxdome (9,945 attempted
calls, 250 files) found an incremental run loses 168 edges; persisting
`structuredReturnTypes` + `functionReturnTypes` recovers 131, and **the whole
param family — `paramNames`, `paramTypes`, `classFieldParamLinks`,
`derivedClassFieldTypes` — recovers exactly ZERO.** They stay batch-scoped
deliberately, and the same reasoning transfers unchanged: a derived param type
only ever SEEDS a binding the walker left empty, so a batch that cannot see a
def's other call sites produces silence, not a wrong answer. E5 changes nothing
here. Re-run that harness with a Python corpus before revisiting it.

### What E5.1 would actually be for Python

Three producer-side gaps, all in the walker, none in the engine:

1. **`ChunkExtraction.paramNames` is not filled.**
   `python/walker/passes/python-def-signatures.ts:36` says so outright: "Python
   does NOT fill `visibility`, `acceptsBlock` or `paramNames`". Without it the
   fold has no argument-position → parameter-name map and no existence gate, so
   it produces nothing for Python even if the other two channels appear.
2. **`FileExtraction.knownTargetCallArgs` is not emitted.** Python's
   syntactically-known callee set is `Cls(...)` → `Cls#__init__` (the direct
   analogue of `Const.new`), plus an imported module-level `def` called by name
   where the import mapper already pins the file.
3. **`FileExtraction.classFieldParamLinks` is not emitted.** `self.f = param`
   inside `__init__`, instance methods only — bucket E's mechanism, and the Ruby
   channel's contract already says an `@ivar` fed by two different
   `(method, param)` coordinates is DROPPED rather than last-write-wins.

That is the whole of E5.1: ~3 walker passes and their tests, and a parity gate
proving Ruby's own numbers do not move. **It buys 5 rows** (D3), which is why it
is specified here and left gated rather than scheduled.

### Precision rules, if it ever ships

Unchanged from the Ruby engine, restated so the gate is checkable:
agreement-only; no fan; a def with ZERO known-target call sites gets no fact; a
def with external callers is typed from its in-project agreement alone, which is
the same evidence standard Ruby accepts; a derived fact NEVER overwrites a
declared or walker-inferred one. The bars are gross lost 0, phantom flat, ugnest
0 — and one more, specific to a producer change: `paramNames` is read by two
narrowers (`python/CLAUDE.md:407`), so filling it changes their inputs and the
E5.1 gate must show those columns flat too.

The kill switch is `CODEGRAPH_PY_PARAM_TYPING`, read ONCE at composition. Absent
⇒ the Python walker emits none of the three channels ⇒ the barrier's
`knownTargetCallArgs.size > 0` guard is false for a Python-only run and every
column is byte-identical, exactly as `CODEGRAPH_PY_DYNAMIC_DISPATCH` parks
E4.1.3.

---

## Decision record

### D1 — measurement before capability, and the measurement is what shipped

E5.0 is E5's deliverable. The agreement tables cost one classifier and no
resolver change, and they falsified the premise before an engine was wired — the
same order D1 of the E4 spec fixed and the same order that made E4.1.3's
falsification cheap. A capability increment whose value is asserted rather than
measured is how E4.1.3's 232-row estimate became 83 matches against 85
fabrications.

### D2 — the "external call result" bucket is empty by construction, not by luck

The brief asked how many residual rows have a receiver that is the result of an
EXTERNAL call (`structlog.get_logger()`), and whether they are correct DROPs to
re-bucket. Answer: **as recall rows, zero, on every corpus.** Every residual row
in the e46b1 dumps carries `dispatch.oracleInProject: true` (548/548 polar,
61/61 netbox, checked directly), because `classifyPyVerdict` cannot put a row
whose oracle target is external into the residual at all. The
`assignCallExternal` binding does appear — 13 rows — but those are receivers
bound from an external call whose oracle target is nonetheless in-project
(`x = next(...)`, `result.scalar_one_or_none()`), which is a different thing.

The `structlog.get_logger()` population D10 named is PHANTOM-side: 31 of polar's
72 phantoms under the parked `CODEGRAPH_PY_DYNAMIC_DISPATCH`. It is a precision
problem for a component that is off, not a recall bucket, and E5 does not own
it.

### D3 — the go/no-go, numerically: 5 against 100

Rows unlocked at 100 % exact agreement with the member confirmed declared:
bucket A 2 (netbox 1, flask 1), bucket D 3 (polar 3), bucket E 0. **Total 5.**
At LUB-by-MRO: also 5 — not one `def` produced a `lub` verdict, because the
determinable-site counts are 1–2 and a single witness cannot disagree with
itself. Bar: 100. **E5.1 and E5.2 do not ship.**

The structural reason, and it is worth stating because it generalises: Python
codebases that carry a large `untypedNameReceiver` residual are not codebases
with unannotated parameters. polar annotates its parameters — 50 of its residual
receivers are ANNOTATED parameters the chain still cannot use, and 0 are
unannotated ones. The residual is downstream of typing, not upstream of it.

### D4 — where the mass actually is, and which increment owns it

The same 336 rows, re-read as an ordering:

| binding                        | rows    | owner today                                                                                                                                                                                                                 |
| ------------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `assignCallProject`            | **143** | E4.6b's call-result fold, ACROSS CHUNKS. 135 are polar and the head is a `-> Self` classmethod — the same `from_session` shape D9's `OW:Self` describes. This is the single largest lever left in the bare-name population. |
| `unbound`                      | 56      | Mostly `cls` receivers ⇒ E4.4 `classObjectReceiver`, of which 32 rows are oracle debt (E5.0b).                                                                                                                              |
| `paramAnnotated`               | 50      | A NARROWING failure, not a missing fact: union / generic annotation heads. E4.1.4's deferred `union` arm and E4.4's `typeVarGeneric` arm.                                                                                   |
| `loopTarget` + `comprehension` | 30      | Container element type — E4.5's rule, measured at 4 rows in D8 and at 30 here because D8 counted `containerElementHop` (subscript receivers) and this counts iteration targets. Worth re-scoping E4.5 on this number.       |
| `assignAlias`                  | 24      | One extra hop before an existing mechanism answers — a transitive-binding arm on `localBinding`.                                                                                                                            |
| `assignCallExternal`           | 13      | The `next(...)` / `scalar_one_or_none()` heads. A stdlib/SQLAlchemy return vocabulary, E4.2's arm.                                                                                                                          |
| everything else                | 15      | `tupleUnpack` 6, `assignOther` 4, `walrus` 4, `exceptAs` 1.                                                                                                                                                                 |
| **`paramUnannotated`**         | **5**   | E5.1 — this document.                                                                                                                                                                                                       |

Read as a program: the next increment after E4.6 should be the cross-chunk
call-result fold on `assignCallProject`, not inter-procedural parameter typing.

### D5 — oracle debt is re-scored downstream, never merged per site

Per E5.0 B. The per-FILE merge rule stands because jedi's module cache makes it
a correctness constraint, not a preference; the debt is corrected by a pass over
dumps that emits `recallDebtAdjusted` beside `recallMerged`. Blocking
precondition: the dump must carry `oracleTargetRelPath` /
`oracleTargetSymbolId`, which `PyResidualRow` declares and the e46b1 dumps do
not populate — visible as polar's bare calls splitting 0/110
`sameFileBareCall`/`crossFileBareCall` against D8's 140/31.

### D6 — Ruby precedent: it is not a precedent, it is the implementation

The brief asked whether Ruby already infers receiver types from call sites, and
whether the relocation protocol therefore applies. It does infer them, and the
protocol does NOT apply in its usual form: the engine is ALREADY outside
`ruby/`, at `trajectory/codegraph/symbols/call-arg-param-types.ts`, and it is
already type-neutral — `RubyTypeRef` is a plain alias of `TypeRef`
(`contracts/types/language.ts:716`), so there is no Ruby type in its signatures
to generalise. What is Ruby-specific is the PRODUCER: the walker channels
`knownTargetCallArgs`, `paramNames` and `classFieldParamLinks`, filled by
`ruby/walker/type-channels.ts:63-66`. A Python vertical writes its own producer
and shares the engine unchanged. Ruby stays byte-identical, and the parity gate
is that its numbers do not move.

Ruby's OTHER unbound-receiver mechanism —
`ruby/resolver/ruby-unbound-receiver-types.ts` — is a different thing and not a
precedent for E5: three tiers (self-member return fact, gem-gated framework
reader, Rails naming convention), none of which reads a call site's arguments.

### D7 — `self` and `cls` are not parameters

Counting them as unannotated parameters inflates bucket A by an order of
magnitude and attributes E4.4's family to E5. The first prototype run did
exactly that and scored polar at 10 rows, every one a `cls` receiver inside a
`@classmethod`. The classifier excludes both names by identity, and the E5.0a
script's tests pin it.

### D8 — the prototype's own miss rate is reported, not assumed

The E5.0a numbers above come from a regex-and-indent classifier, not from the
walker. Two of its failure modes were found and fixed during the run and both
are pinned as tests in the plan: an enclosing-`def` scan that updated its indent
watermark on any dedented line (a flush-left comment killed the scan — 346 of
polar's 548 rows read as "no enclosing def" before the fix, 0 after), and the
`self`/`cls` inclusion of D7. What remains unmeasured is the argument-typing
half: `argType` reads constructor calls, annotated params, nearest annotated
locals and `self.<field>` annotations, and answers `null` for everything else,
which is why `noDeterminable` is a reported verdict rather than a discarded one.
Since the whole population is 12 rows, a residual miss in that half cannot move
the go/no-go: the bar is 100.

---

## Risks

**The go/no-go generalises from five corpora.** A codebase with genuinely
untyped parameters — an older Django monolith, a scientific codebase — could
carry a large `paramUnannotated` population and flip the decision. That is why
E5.1 is specified in full and gated on a NUMBER rather than deleted: E5.0a is
re-runnable on any corpus, and a corpus that clears 100 re-opens the increment
without a redesign.

**The redirect in D4 is an attribution, not a plan.** 143 `assignCallProject`
rows are what the binding classifier says; whether E4.6b's fold reaches them
across chunks is a separate measurement that increment owns. Nothing here
authorises a claim about its yield.

**`paramNames` has two existing readers.** Filling it for Python
(`python/CLAUDE.md:407`) changes narrower inputs whether or not the fold is
enabled, so the kill switch has to gate the WALKER emit, not just the fold.

---

## What E5 does NOT claim

- That inter-procedural parameter typing is a bad mechanism. It is a good one,
  it is already shipped for Ruby, and it is measured at 5 rows on THESE five
  Python corpora.
- That the 143 `assignCallProject` rows will fall to E4.6b. They are attributed,
  not forecast.
- That `paramAnnotated`'s 50 rows are a defect in one component. "The annotation
  exists and the chain missed" is a symptom with at least two causes (union
  heads, generic heads) and E5.0a does not separate them.
- Anything about polar's degraded quarter beyond what E4.0's merged oracle
  already established.
- Any number produced by a live index run. Every figure here is read off the
  E4.6b-1 dumps and the corpora on disk; no reindex was run.

---

## Beads and follow-ups

- `(e5)` — epic: this document. Closes on E5.0a + E5.0b + E5-close.
- `(e5).1` — E5.0a, the attribution and agreement report.
- `(e5).2` — E5.0b, the oracle-debt re-scoring pass, blocked on emitting
  `oracleTargetRelPath` / `oracleTargetSymbolId` in the dump.
- `(e5).3` — E5.1, the Python producer for `call-arg-param-types`. **Blocked on
  a corpus measuring ≥ 100 rows.** Not scheduled.
- `(e5).4` — E5.2, parameter-bound callables. **Blocked on bucket D measuring ≥
  30 rows at exact agreement** (the program's standing mass bar); 3 today.
- Follow-up, NOT an E5 bead: the cross-chunk call-result fold on
  `assignCallProject` (D4). It belongs to E4.6b's owner and wants its own
  attribution pass before it is scoped.
