# Python Frontier E4.6 — Typed Residuals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Answer the residual families D8 attributes to E4.6 —
`moduleAliasMember` (325 rows after the flask corpus-root correction, not 317),
`sameFileBareCall` 140, `constructorChainHead` 44, `callResultChainHead` 35,
`crossFileBareCall` 31 and `untypedFieldHop` 111 — using only facts the walker
or the mapper already holds: an import statement, a package re-export, a
binding's statement span, a constructor, a recorded return type. E4.1.3 was
executed and FALSIFIED on exactly the opposite premise: a name-only `single`
dispatch fabricated 83 confidence-1 edges (flask +6, netbox +5, polar +72) on
library-typed receivers the resolver cannot see, and it is parked behind a flag.
Nothing in this plan picks a symbol by name popularity. Every mechanism below is
a lookup whose evidence is a typed or structural fact, and every one of them
either answers or CONTINUEs.

Measured addressable mass, after sub-shape attribution (decision 1): **309 of
the 325 `moduleAliasMember` rows, 85 of the 140 `sameFileBareCall` rows, 44 of
44 `constructorChainHead`, 33 of 35 `callResultChainHead`, and 48 of 111
`untypedFieldHop`** — 519 rows, against a residual of 1,247 across the five
corpora (ugnest 24, flask 48, httpx 19, netbox 118, polar 1,038).
`crossFileBareCall` contributes 0: its 31 rows reduce to 4 addressable, below
the mass bar, and are recorded rather than planned. The 36 rows this plan hands
to E4.2 and the 131 it declares unreachable are named, counted and argued in
decision 4.

**Architecture:** Four moves, none of them a new dispatch component. (1) A
package `__init__.py` that re-exports a SUBMODULE
(`from . import _datatable as datatable`) becomes answerable:
`PythonImportFileMapper` gains `resolveExportedModule`, the module-shaped
sibling of `resolveExportedName`, reading the `moduleReexports` channel the
walker has recorded since walker 2 — and `importedName`'s module arm asks it
when the composed module text maps to no file. (2) `LocalBinding` gains an
optional `endLine`, so the import-shadow rule in `pythonBindingInForceAt` —
today a SAME-LINE test — covers a multi-line right-hand side, which is the whole
of netbox's `layout = layout.Layout(…)` shape. (3) The chain fold learns to
split a receiver on hops WITHOUT descending into `(…)` / `[…]` / `{…}`, and
Python's seeds learn to strip a generic subscript, which is what turns
`Notification(user=self.user, …).save()` and
`datatable.Datatable[Benefit, S](…).render()` from garbage segments into a typed
head. (4) `globalShortName` gains a same-file ENCLOSING-SCOPE arm ahead of its
same-file module-level arm, because Python's LEGB walk reaches `E` before `G`
and every one of the 85 addressable same-file bare calls names a NESTED def.

**Tech Stack:** TypeScript (NodeNext, `strict`), vitest, tsx for the corpus
harnesses. No new dependency and no schema migration. `LocalBinding.endLine` is
an optional field on an existing channel; `moduleReexports` and
`structuredReturnTypes` are existing run-global channels
(`domains/trajectory/codegraph/symbols/run-state.ts:453`, `:428`). Walker
version STAYS 5 — E4.0.5 already moved it 4 → 5 on this branch and 5 is
unreleased, so the walker deltas in Tasks E4.6a and E4.6c ride it rather than
bumping again.

**Spec:** `docs/superpowers/specs/2026-09-10-python-frontier-e4-design.md` —
"E4.6" (the sketch this plan replaces with measured sub-shapes), D8 (the family
table that orders the program), D9 (the chain-wrong population E4.0.5 owns —
this plan must not absorb it), and the 4vg1i section on persisted return-type
channels. The measurement record it builds on is
`docs/superpowers/plans/2026-09-10-python-e4-0-measurement.md` → E4.0.4. Format
and gate protocol are inherited verbatim from
`docs/superpowers/plans/2026-09-10-python-e4-1-dispatch-fanout.md`; the
relocation protocol, where a kernel move is involved, is
`docs/superpowers/specs/2026-09-03-python-codegraph-unification-program-design.md`
→ "Relocation protocol (one bead per seam)".

---

## Decision record

### 1 — The attribution, measured (2026-09-10, dumps under `~/.claude/jobs/dffe3647/tmp/e4-attr/`)

Every residual row from E4.0.4's five `--oracle merged --dispatch` dumps was
re-tagged with `scripts/lib/py-residual-families.ts` — the same classifier, the
same precedence list — and then sub-bucketed by the MECHANISM that would answer
it. The re-tag joins each row against its caller file, so the sub-shape is read
off the source rather than guessed from the row.

**A correction to D8's denominators first, and it is the same one Task E4.1's
decision 1 recorded.** The E4.0.4 report run passed
`--corpus-root .../tea-rags-bench/corpora/<c>` for all five corpora, but flask
lives at `~/Dev/OpenSource/codegraph-test/flask` and ugnest at
`~/Dev/Collaborate/ugnest` (`scripts/lib/codegraph-corpora.json:2,20`). For
those two, every tier-2 source read missed. Re-tagged against the real roots,
flask's residual re-splits: `moduleAliasMember` **8** (was 0),
`untypedNameReceiver` **13** (was 22), `pytestFixture` **1** (was 0). ugnest is
unchanged — its rows are all tier 1 or fall the same way. So `moduleAliasMember`
is **325 rows, not 317**; every other E4.6 family count in D8 reproduces
exactly.

#### 1a — `moduleAliasMember`, 325 rows, by IMPORT SHAPE

Sub-shape is the import statement that bound the receiver head, read out of the
caller file.

| sub-shape                                                         | flask | netbox | polar   | total   | addressable |
| ----------------------------------------------------------------- | ----- | ------ | ------- | ------- | ----------- |
| `from <relpkg> import <mod>`, package `__init__` aliases a MODULE | 0     | 0      | **259** | **259** | yes         |
| `from <abspkg> import <mod>`, `<mod>.py` is a real submodule      | 0     | **50** | 0       | **50**  | yes         |
| classifier FP — `from x import y as z` also binds `y`             | 0     | 0      | 8       | 8       | no          |
| classifier FP — flask `LocalProxy` globals (`g`, `current_app`)   | 8     | 0      | 0       | 8       | no          |
| **total**                                                         | **8** | **50** | **267** | **325** | **309**     |

ugnest and httpx carry zero rows in this family.

**polar's 259 are ONE shape and one gap.** Every row is
`from ..components import datatable, description_list, input` in
`server/polar/backoffice/*/endpoints.py`, and
`server/polar/backoffice/components/__init__.py:1-5` reads
`from . import _datatable as datatable`. `importedName.resolveBinding` maps
`..components` to that `__init__.py`, `declaringFile` finds no SYMBOL named
`datatable` (the file re-exports a MODULE, and `followReexports` requires
`declaresName`), `resolveModuleReceiver` composes `..components.datatable` which
names no file, `resolveModuleValueReceiver` finds no `DatatableAttrColumn`
declared in `__init__.py`, and the chain exhausts — `answeredBy: none` on all
267 polar rows. **MAPPER gap:** there is no "which FILE does this package's
alias name" question, only "which file DECLARES this name".

**netbox's 50 are ONE shape and a different gap.** Every row is `layout.Row(…)`
/ `layout.Column(…)` inside
`layout = layout.Layout(\n    layout.Row(\n        layout.Column(…)))` — a
class-body attribute in `netbox/core/views.py`, `netbox/ipam/views.py` and
siblings, under `from netbox.ui import layout` where
`netbox/netbox/ui/__init__.py` is EMPTY and `netbox/netbox/ui/layout.py` is a
real module. The module arm would answer it; it never runs, because
`localBindings` carries `layout -> Layout` from the assignment and
`pythonBindingInForceAt` (`python-receiver-type-ports.ts:110`) only demotes that
binding back to the import when `bound.line === atLine`. The inner receivers sit
on lines 205, 206, 212… against a binding at 204, so the shadow rule misses and
`localBinding` types the head as `Layout`. **WALKER + PORTS gap:** the binding
carries no END line, so "inside the statement that establishes it" is not a
question anything can ask.

The 16 non-addressable rows are recorded, not planned. polar's 8 are a
classifier defect — `collectImportBindings` splits
`from polar.subscription.service import subscription as subscription_service` on
whitespace and adds both `subscription` and `subscription_service`, so a bare
annotated parameter named `subscription` reads as import-bound; their real shape
is an annotated `def` parameter that a different mechanism misses, and they
belong to E4.1's population, not here. flask's 8 are `current_app.json` /
`g.pop` — werkzeug `LocalProxy` globals whose member jedi resolves through the
proxy's own annotation. Neither is a name-only guess away from being answered;
both are out.

#### 1b — bare calls, 171 rows (`sameFileBareCall` 140 + `crossFileBareCall` 31)

Sub-shape is whether the oracle's target symbol NAME equals the callee name, and
if so whether that symbol is module-level or nested. `NAME_DIFF` means jedi
followed a callable through a parameter or a decorator to a def that is not
spelled like the call.

| family              | sub-shape     | verdict            | ugnest | flask  | httpx | netbox | polar   | total   |
| ------------------- | ------------- | ------------------ | ------ | ------ | ----- | ------ | ------- | ------- |
| `sameFileBareCall`  | **nestedDef** | `missed`           | 0      | 0      | 0     | 4      | 43      | **47**  |
| `sameFileBareCall`  | **nestedDef** | `fileOnly`         | 0      | 6      | 4     | 2      | 26      | **38**  |
| `sameFileBareCall`  | NAME_DIFF     | `missed`           | 1      | 4      | 0     | 2      | 31      | 38      |
| `sameFileBareCall`  | NAME_DIFF     | `skippedInProject` | 0      | 0      | 0     | 0      | 10      | 10      |
| `sameFileBareCall`  | NAME_DIFF     | `wrongFile`        | 0      | 1      | 0     | 1      | 5       | 7       |
| `crossFileBareCall` | moduleLevel   | `skippedInProject` | 8      | 0      | 0     | 0      | 4       | 12      |
| `crossFileBareCall` | moduleLevel   | `missed`           | 0      | 0      | 0     | 0      | **4**   | **4**   |
| `crossFileBareCall` | NAME_DIFF     | `missed`           | 0      | 0      | 0     | 0      | 15      | 15      |
| **total**           |               |                    | **9**  | **11** | **4** | **9**  | **138** | **171** |

**All 85 addressable rows are nested defs, and zero are module-level.** The
target symbolIds say it directly:
`populate_port_template_mappings#generate_copies`,
`Blueprint._merge_blueprint_funcs#extend`,
`DigestAuth._build_auth_header#digest`,
`OrganizationListView.pagination_controls#_nav_button`, `_list_tabs#url`,
`progress#total`. `globalShortName` already models the reachability correctly —
`isBareCallable` = module-level OR (same file AND `isEnclosingScope`) — but only
its same-file MODULE-LEVEL arm gets a filtered strict pick. The enclosing-scope
candidate has to survive `pickSingleCandidate` over the WHOLE project table
first, and names like `url`, `send`, `total`, `extend`, `digest`, `contains` do
not. The 38 `fileOnly` rows are the same defect one step further along: the
module-level arm answered with the file's OWN top-level def of that name, which
is the right file and the wrong symbol. **STRATEGY gap**, and the fix is
Python's LEGB order — `E` before `G`.

`crossFileBareCall` is **folded, not planned**: 4 addressable rows. 12 rows are
`skippedInProject`, which is `classifiedExternal && oracle inProject`
(`scripts/lib/py-oracle-core.ts:364`) — ugnest's 8 name
`domains/identity/tests/factories.py` and `domains/media/utils.py`, polar's 4
name `server/load_tests/common/test_data.py`; that is the external-vocabulary
precision defect D9 tracks, not a resolution strategy. 15 more are NAME_DIFF.
Below the 10-row mass bar for its own task.

**The 140 / 31 split above STANDS (2026-09-11, `w205u` / E5.0b).** It was hand
re-tagged from rows that carried the oracle's target, so the bug that made this
table look wrong was never in the table. The oracle host emitted no
`oracleTargetRelPath`, so re-deriving the split by running
`scripts/py-e4-family-report.ts` over an e46b1 dump compared every bare call
against `undefined` and read polar 0 / 110 — an artefact of the dump, not a
measurement. With the field emitted, polar re-reads **87 / 23**:
`crossFileBareCall` reproduces this table's polar column (4 + 4 + 15 = 23)
**exactly**, and `sameFileBareCall` is 115 − 28, the rows E4.6b-1 has already
resolved. Flask re-reads 5 / 0 against 11 / 0 here — the 6 `nestedDef`
`fileOnly` rows, gone as predicted. Anything that re-derives this split from a
dump wants a post-fix one.

#### 1c — chain heads, 79 rows (`constructorChainHead` 44 + `callResultChainHead` 35)

| family                 | sub-shape                                          | flask | httpx | netbox | polar  | total  |
| ---------------------- | -------------------------------------------------- | ----- | ----- | ------ | ------ | ------ |
| `constructorChainHead` | `mod.Cls[T, U](…).m()` — module alias + subscript  | 0     | 0     | 0      | **39** | **39** |
| `constructorChainHead` | `Cls(kw=self.x, …).m()` — dots INSIDE the arg list | 0     | 1     | 4      | 0      | **5**  |
| `callResultChainHead`  | `get_client().m()` — project fn, annotated return  | 1     | 0     | 2      | 15     | **18** |
| `callResultChainHead`  | `Cls.from_session(s).m()` — classmethod `-> Self`  | 0     | 0     | 0      | **12** | **12** |
| `callResultChainHead`  | `typing.cast(T, x).m()` — the type IS argument 1   | 0     | 0     | 0      | 3      | **3**  |
| `callResultChainHead`  | `cls(job).run()` / `self_ref().m()`                | 1     | 0     | 1      | 0      | 2      |
| **total**              |                                                    | **2** | **1** | **5**  | **69** | **79** |

The 39 polar rows and the 5 netbox/httpx rows share ONE root cause:
`propagateChain` splits the receiver with `receiver.split(".")`
(`kernel/receiver-type-propagation.ts:100`).
`Notification(\n  user=self.user,\n   object=self, …)` contains dots inside its
ARGUMENT list, so the split yields
`["Notification( user=self", "user, object=self", …]`, the head types to nothing
and the whole receiver is untyped. polar's rows add a second cut:
`stripCallArgs` slices at the first `(`, so
`datatable.Datatable[Benefit, BenefitSortProperty](…)` reduces to
`Datatable[Benefit, BenefitSortProperty]`, which fails `PYTHON_CLASS_HEAD`
(`^[A-Z]\w*$`) in `pythonModuleAliasSeed`. **KERNEL + PORTS gap.**

The 18 `get_client()` rows are a THIRD cut in the same file:
`pythonSingleHopType` accepts a receiver ending in `)` only when the stripped
head matches `PYTHON_CLASS_HEAD`, so a lowercase function call is refused
outright. `polar/integrations/polar/client.py:1011` reads
`def get_client() -> PolarSelfClient:` — the return fact exists, keyed by
symbolId in the run-global `structuredReturnTypes`; nothing asks for it.

#### 1d — `untypedFieldHop`, 111 rows, by HOW THE FIELD IS ASSIGNED

Sub-shape is the nearest assignment or annotation of the receiver's LAST
attribute segment (`self.payment_repo` → `payment_repo`, `item.type` → `type`),
scanned backwards in the caller file; `obj.field` rows are further split by
whether the receiver HEAD carries an annotation.

| sub-shape                                                     | ugnest | flask  | httpx | netbox | polar  | total   | owner |
| ------------------------------------------------------------- | ------ | ------ | ----- | ------ | ------ | ------- | ----- |
| `obj.field` / head annotated, field is `Mapped[T]`            | 0      | 0      | 0     | 0      | **36** | **36**  | E4.2  |
| `self.f = Cls.method(…)` — classmethod `-> Self`              | 0      | 0      | 0     | 0      | **13** | **13**  | E4.6c |
| `self.f = Ctor(…)` — class body or `__init__`                 | **4**  | 0      | 0     | 0      | **8**  | **12**  | E4.6c |
| `obj.field` / head unannotated (`app = Flask(__name__)`)      | 0      | 5      | 0     | 0      | 7      | 12      | out   |
| `self.f: T` annotated, `T` is an import ALIAS                 | 0      | 0      | 0     | 0      | **11** | **11**  | E4.6c |
| `obj.field` / head has no binding at all (`current_app.json`) | 0      | 6      | 0     | 1      | 3      | 10      | out   |
| `self.f = call(…)` — project fn / method result               | **3**  | 0      | **6** | 0      | 0      | **9**   | E4.6c |
| `obj.field` / head annotated, field NOT `Mapped` (ternary)    | 0      | 0      | **3** | 0      | 0      | **3**   | E4.6c |
| `self.f` with no binding found                                | 0      | 0      | 0     | 0      | 2      | 2       | out   |
| `self.f = <Literal[…]>` enum discriminant                     | 0      | 0      | 0     | 0      | 2      | 2       | out   |
| `self.f = param` (unannotated parameter)                      | 0      | 0      | 0     | 1      | 0      | 1       | out   |
| **total**                                                     | **7**  | **11** | **9** | **2**  | **82** | **111** |       |

**The largest sub-shape is not E4.6's.** All 36 polar
`obj.field / head annotated` rows have an annotated receiver head
(`item: Benefit`, `meter: Meter`, `checkout: Checkout`) and a field declared as
a SQLAlchemy `Mapped[T]` class-body annotation —
`polar/models/benefit.py:112 type: Mapped[BenefitType]`,
`models/meter.py:34 aggregation: Mapped[Aggregation]`,
`models/checkout.py:253 customer_billing_address: Mapped[Address | None]`. The
head's type is already known; what is missing is the `Mapped[T]` unwrap, which
`python-type-annotation.ts:25` explicitly assigns to E4.2 ("Unwrapping a
framework wrapper (SQLAlchemy `Mapped[Foo]`) is E3's job"), and which the
classifier books as `transparentWrapper` whenever the annotation happens to sit
in the CALLER's file instead of the model's. Re-implementing it here would be a
second copy of E4.2's mechanism. **These 36 rows are routed to E4.2 and are NOT
in any E4.6 gain claim.**

48 rows are Task E4.6c's: 12 constructor assignments, 3 ternary ones, 11
alias-annotated fields, and 22 assigned from a CALL. The last 22 reuse E4.6b-1's
`Self` substitution and call-head return read, but at a site that has no channel
today — `callResultBindings` records single-IDENTIFIER targets only, so
`self.payment_repo = PaymentRepository.from_session(session)` is not recorded at
all. That is the one channel this plan adds (decision 2). The remaining 27 are
out — flask's `LocalProxy` heads (16), two-hop receivers whose head is a local
`Flask(…)` needing an inherited class-field fact, an unannotated parameter, and
two `Literal[…]` enum discriminants. **111 = 36 + 48 + 27.**

### 2 — No run-global `moduleBindings` channel. The evidence does not ask for one

The orchestrator's open question was whether module-scope `name = <call|ctor>`
facts must become a run-global channel keyed by relPath, folded like
`classFieldTypesByClassKey` and possibly persisted per 8qyax, because
`callResultBindings` is per CHUNK and a module-level binding is invisible inside
a method's chunk. Checked against the sub-shape tables above, **no E4.6
sub-shape with mass ≥ 10 rows needs it**:

- netbox's 50 alias rows need the binding's END LINE, not a wider scope. The
  binding is in the SAME chunk as the call; the shadow rule simply cannot see
  the statement's extent.
- the 18 `get_client()` rows have a CALL EXPRESSION as the receiver at the call
  site (`get_client().portal_get_customer()`), not a name bound elsewhere. The
  fact needed is `structuredReturnTypes[get_client]`, already run-global.
- polar's 8 `self.f = Ctor(…)` rows bind at CLASS BODY
  (`service.py:58 _client = SlackClient()`), which `classFieldTypesByClassKey`
  already carries per class key — the pass declines the row for a different
  reason (decision 5).
- the 12 `self.f = Cls.method(…)` rows bind inside `__init__`, same chunk.

The one motivating case in the E4.1.3 falsification —
`log = structlog.get_logger()` at module scope, `log.error(…)` inside a method —
is a LIBRARY-typed receiver. Decision 1 of this plan forbids answering it:
`structlog` is not a project file, so no in-project symbol is the honest answer
and any pick would be the fabricated edge E4.1.3 was parked for. A
`moduleBindings` channel would carry that fact faithfully and still have nothing
to resolve it to.

**Decision: do not add a module-scope binding channel.** Persistence (8qyax
pass-1 slice) is therefore not in scope either. If a later increment measures a
family that needs module-scope value bindings for a PROJECT-typed receiver, it
adds the channel then, with its own count.

One DIFFERENT channel is added, and its justification is the shape of the
evidence rather than the shape of the scope: `classFieldCallResults` (mechanism
14, Task E4.6c step 4b). `callResultBindings` already records "a local assigned
from a call, as the callee spelling, for the resolver to fold", but only for
single-IDENTIFIER targets, so
`self.payment_repo = PaymentRepository.from_session(session)` has no channel at
all — 22 measured rows on three corpora. It is per-file, folded run-global
exactly like `classFieldTypesByClassKey`, and it is not persisted: it rides
walker 5's unreleased delta, and a run whose index lacks it behaves
byte-identically.

### 3 — Return types are read at ONE level. No transitive worklist

The orchestrator asked whether `callResultChainHead` and `untypedFieldHop` need
a bounded worklist fixpoint (depth ≤ 3, cycle-safe) over `structuredReturnTypes`
in `kernel/return-inference.ts`. Every measured row says one level is enough:

| row set                        | callee                        | return fact                   | levels |
| ------------------------------ | ----------------------------- | ----------------------------- | ------ |
| polar 15 + netbox 2 + flask 1  | `get_client`, `get_dashboard` | explicit `-> PolarSelfClient` | 1      |
| polar 12 + polar 13 field rows | `RepositoryBase.from_session` | explicit `-> Self`            | 1      |
| httpx 6                        | `Client._init_transport`      | explicit `-> BaseTransport`   | 1      |
| ugnest 3                       | `get_geo_provider`            | explicit `-> GeoProvider`     | 1      |

Zero rows in any E4.6 family require a return type that is itself only knowable
from another def's return type. `inferReturnTypeName` is also the wrong place
for such a fold — it is a WALK-time inference over AST nodes with no cross-file
callee resolution, so a transitive version would have to run after resolution,
which is a different engine. Ruby has no precedent to relocate: its return facts
come from the same one-level `inferReturnTypeName` plus YARD annotations.

**Decision: one level, read at resolve time from the existing run-global
`structuredReturnTypes`, keyed by the symbolId the chain resolved the callee to.
No worklist, no kernel change to `return-inference.ts`, Ruby untouched.** The
known hazard is recorded instead of engineered around: Python symbolIds carry no
module path, so a run-global map keyed by a bare `get_client` collides across
files. Task E4.6b-1 handles it by requiring the callee to RESOLVE first and by
declining when the resolved symbolId's short name has more than one
`structuredReturnTypes` contributor (step detail in the task).

### 4 — What this plan declines, with counts

| rows | shape                                                        | why not here                                                                                                                    |
| ---- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| 55   | `sameFileBareCall` NAME_DIFF                                 | callable reached through a parameter / decorator; the target depends on the CALLER, not on any static fact in the callee's file |
| 36   | `untypedFieldHop` `Mapped[T]`                                | E4.2 owns the wrapper unwrap; a second copy here is duplication                                                                 |
| 31   | `crossFileBareCall`, the whole family                        | 12 are the external-vocabulary defect D9 owns, 15 are higher-order, and the 4 addressable are below the mass bar                |
| 16   | `moduleAliasMember` classifier FPs                           | 8 are a `collectImportBindings` defect, 8 are `LocalProxy`                                                                      |
| 27   | `untypedFieldHop` head-unbound / head-unannotated / misc     | flask proxies, two-hop chains needing an inherited class-field fact, one unannotated param, two `Literal[…]`                    |
| 2    | `callResultChainHead` `cls(job)` / `self_ref()`              | below the mass bar, folded into E4.6b-1's tests as pins only                                                                    |
| 3    | `containerElementHop`, `asyncForm` residue in these families | E4.5 owns them; the classifier already books them elsewhere                                                                     |

**The six E4.6 families carry 686 rows: 519 planned + 36 routed to E4.2 + 131
declined.** The other 561 residual rows belong to other families and other
increments — `untypedNameReceiver` 423 and `unionBranchReceiver` 18 (E4.1),
`classObjectReceiver` 83 and `superMro` 23 (E4.4), `transparentWrapper` 9
(E4.2), `containerElementHop` 4 (E4.5), `pytestFixture` 1 (E4.3). 686 + 561 =
1,247, which is the whole residual.

Nothing on this list is answered by "the project declares exactly one symbol
with that name". That predicate is what E4.1.3 measured and what fabricated the
83 edges.

### 5 — Where each mechanism lives, and why it is not somewhere else

| #   | mechanism                                              | layer                                  | file                                                                | task    |
| --- | ------------------------------------------------------ | -------------------------------------- | ------------------------------------------------------------------- | ------- |
| 1   | `resolveExportedModule` — package alias → module FILE  | mapper                                 | `resolver/python-import-file-mapper.ts`                             | E4.6a   |
| 2   | module arm asks it when composed text maps nowhere     | strategy                               | `resolver/strategies/python-imported-name.ts`                       | E4.6a   |
| 3   | `LocalBinding.endLine`, emitted per binding            | contract + walker                      | `contracts/types/codegraph-local-binding.ts`, `walker`              | E4.6a   |
| 4   | import shadow spans the whole statement                | ports                                  | `resolver/python-receiver-type-ports.ts`                            | E4.6a   |
| 5   | bracket-aware hop split                                | kernel                                 | `kernel/receiver-type-propagation.ts`                               | E4.6b-1 |
| 6   | subscript strip in the Python seeds                    | ports                                  | `resolver/python-receiver-type-ports.ts`                            | E4.6b-1 |
| 7   | call-result head → resolved callee's return type       | ports                                  | `resolver/python-receiver-type-ports.ts`                            | E4.6b-1 |
| 8   | `-> Self` on a classmethod means the receiver class    | ports                                  | `resolver/python-receiver-type-ports.ts`                            | E4.6b-1 |
| 9   | `typing.cast(T, x)` head types as `T`                  | ports                                  | `resolver/python-receiver-type-ports.ts`                            | E4.6b-1 |
| 10  | same-file enclosing-scope arm, ahead of module-level   | strategy                               | `resolver/strategies/python-global-short-name.ts`                   | E4.6b-2 |
| 11  | class-body ctor accepts an import-bound project class  | walker pass                            | `walker/passes/python-class-body-fields.ts`                         | E4.6c   |
| 12  | `a or B()` / ternary RHS in `__init__` field types     | walker pass                            | `walker/passes/python-ast-type-source.ts`                           | E4.6c   |
| 13  | annotation type name resolved through an import alias  | shared                                 | `resolver/strategies/shared.ts`                                     | E4.6c   |
| 14  | `classFieldCallResults` — a field assigned from a CALL | contract + walker + run-state + shared | `codegraph-extraction.ts`, `walker.ts`, `run-state.ts`, `shared.ts` | E4.6c   |

Mechanism 5 is the only KERNEL change, and it is the only one Ruby can feel.
`propagateChain`'s `receiver.split(".")` is shared. Today a receiver carrying a
bracketed group with a dot inside produces nonsense segments that type to
nothing, so a bracket-aware split can only produce MORE types, never different
ones on a receiver without brackets. Ruby's gate is therefore parity, not
inspection: `ruby-resolver-parity.ts` and both Ruby chain tallies must read 0
drift. **If they do not, the splitter becomes an optional
`ports.splitReceiverHops` that Python provides and Ruby omits, keeping
`split(".")` as the default** — the task carries both branches so the executor
never has to invent one.

Mechanism 6 deliberately does NOT touch the shared `stripCallArgs`. Cutting at
`[` there would change Ruby, where `xs[0].foo` is an index rather than a generic
subscript, and `xs[0]` is what Ruby's fold expects to see.

### 6 — Ordering, and the one hard dependency

```text
E4.6a  ──► E4.6b-1        (39 of E4.6b-1's 44 constructor rows are `mod.Cls[T](…)`
   │                       whose head is the module alias E4.6a resolves)
   ├────► E4.6c           (mechanism 13 reuses the alias-resolution reading;
   │                       mechanism 14 consumes E4.6b-1's ports 7 and 8)
E4.6b-2 ── independent    (touches only `python-global-short-name.ts`)
```

E4.6b-2 has no dependency and may run in parallel with E4.6a in a separate agent
worktree, provided the two do not share a file — they do not. E4.6b-1 must
ff-merge E4.6a. E4.6c must ff-merge E4.6b-1.

### 7 — Precision bar, per task, non-negotiable

The 1:1 bar is absolute and identical to E4.0.5's:

- **gross `lost` = 0** on every corpus. Not netted against gains.
- **phantom flat**: ugnest stays at 0, flask stays at or under 2 %, and the
  phantom rate on every corpus moves by at most +0.5 pp.
- `exactReplacedByFan` / `exactReplacedByAmbiguous` = 0.
- chain-tally `drift` = 0 AND `dispatchDrift` = 0, five corpora, five runs.
- same-language candidates only. `lookupPythonSymbolsByShortName`
  (`strategies/shared.ts`) is the ONLY lookup any new code in this plan may use
  for a short-name search. No new call to the raw `symbolTable.lookup` by short
  name, ever; exact-symbolId `lookup` is fine and is what `moduleMemberTarget`
  already does.
- A `fileOnly` row that becomes a `match` counts as a GAIN, not a loss — the
  file was already right, the symbol was not. Report those separately from
  `missed → match` so the two mechanisms are visible apart.

---

## Global Constraints

- **Ruby is byte-identical**, with exactly one exception under review: Task
  E4.6b-1's kernel splitter, gated by Ruby parity as decision 5 states. No Ruby
  file is edited by any task in this plan. If parity drifts, the splitter goes
  behind a port and Ruby keeps `split(".")`.
- **Existing tests are moved, never rewritten**
  (`.claude/rules/resolver-architecture.md` §4). A pin that now has a better
  answer is edited only with a bead comment naming the row and the corpus.
- **Do not absorb D9.** `skippedInProject` rows are the external-vocabulary
  precision defect, not a resolution strategy. A task that finds itself editing
  `python-external-vocabulary.ts` has left its scope.
- **Do not touch
  `resolver/dispatch/**`.** E4.1.3's parked component and its flag are another executor's file set. Nothing here reads or writes them, and no gate in this plan runs with the dispatch component enabled beyond the default `--dispatch`
  the harnesses already pass.
- **The harnesses need no change.** Both `py-codegraph-jedi-oracle.ts` and
  `codegraph-chain-tally.ts` build the production resolver. A task that finds
  itself editing `scripts/` for measurement has found a harness bug and reports
  it rather than patching around it.
- **Perf.** chain-tally wall ≤ +25 %, peak RSS ≤ +20 %, measured interleaved
  B/A/A/B with the min of each side, on netbox AND polar. No per-call filesystem
  probes — membership questions go to `hasFile` / `hasFilesUnder`. Every new
  mapper answer is memoised on the existing `memoFor(table)` maps.
- **Determinism.** jedi's answer wobbles by up to 2 rows per run on netbox and 1
  on polar (E4.0.3's control). A diff at or under that on the ORACLE columns,
  with every chain column byte-identical, is the instrument; anything larger is
  the change.
- **Capability sync.** `versions.walker` in
  `src/core/domains/language/python/capability.ts` reads **5** and STAYS 5 — it
  is unreleased on this branch, and Tasks E4.6a and E4.6c ride that delta. Each
  of those two still runs `npm run gen:lang-compat` and commits the regenerated
  artifacts if the generator's output moves
  (`.claude/rules/language-capability-sync.md`). READ THE CURRENT VALUE FIRST;
  if another parallel branch has moved it past 5, stop and report rather than
  guessing.
- **Commits.** `feat(language): … (w205u)`, `test(language): … (w205u)`,
  `refactor(language): … (w205u)`, `docs(plans): … (w205u)`. Body wrapped at ≤
  100 columns. Trailers
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01FNCoxgrknsrkLSDjn1p5Mm`.
- **Execution.** A fresh Opus executor per task, in its own agent worktree,
  ff-merging `worktree-py-frontier-e4` in Step 0. Tool calls ≤ 8 min; writes ≤
  120 lines per call. TDD: the failing test first, always. Live validation
  (reindex + `prime`) is user-gated and is NOT part of any task's gate. Never
  push.

---

## File Structure

```text
src/core/
├── contracts/types/
│   ├── codegraph-local-binding.ts               MOD  E4.6a — LocalBinding.endLine?: number
│   └── codegraph-extraction.ts                  MOD  E4.6c — classFieldCallResults?
├── domains/trajectory/codegraph/symbols/
│   └── run-state.ts                             MOD  E4.6c — run-global fold of the above
└── domains/language/
    ├── kernel/
    │   └── receiver-type-propagation.ts         MOD  E4.6b-1 — splitReceiverHops + its use
    │                                                 in propagateChain (Ruby-parity gated)
    └── python/
        ├── capability.ts                        MOD  E4.6-close — codegraph tech text only
        ├── CLAUDE.md                            MOD  E4.6-close — the four new invariants
        ├── walker/
        │   ├── walker.ts                        MOD  E4.6a — endLine on emitted bindings
        │   │                                         E4.6c — classFieldCallResults emission
        │   └── passes/
        │       ├── python-class-body-fields.ts  MOD  E4.6c — import-bound ctor evidence
        │       └── python-ast-type-source.ts    MOD  E4.6c — `or` / ternary RHS forms
        └── resolver/
            ├── python-import-file-mapper.ts     MOD  E4.6a — resolveExportedModule
            ├── python-receiver-type-ports.ts    MOD  E4.6a (shadow span),
            │                                         E4.6b-1 (subscript, call head, Self, cast)
            └── strategies/
                ├── python-imported-name.ts      MOD  E4.6a — module arm asks the mapper
                ├── python-global-short-name.ts  MOD  E4.6b-2 — enclosing-scope arm
                └── shared.ts                    MOD  E4.6c — type name through import alias

tests/core/domains/language/
├── kernel/receiver-type-propagation.test.ts     MOD  E4.6b-1 — bracket-aware split cases
└── python/
    ├── walker/
    │   ├── python-local-binding-span.test.ts    NEW  E4.6a — endLine emission
    │   └── python-class-body-fields.test.ts     MOD  E4.6c — import-bound ctor
    └── resolver/
        ├── python-import-file-mapper.test.ts    MOD  E4.6a — resolveExportedModule
        ├── python-imported-name.test.ts         MOD  E4.6a — module re-export hop
        ├── python-receiver-type-ports.test.ts   MOD  E4.6a + E4.6b-1
        └── python-global-short-name.test.ts     MOD  E4.6b-2 — LEGB order

docs/superpowers/plans/2026-09-10-python-e4-6-typed-residuals.md   THIS FILE (the
                                                                   measurement record
                                                                   is appended at close)
~/.claude/jobs/<job>/tmp/e4-6/                                     A/B row dumps, not in repo
```

If a listed test file does not exist under that exact name, the executor creates
it rather than folding the cases into an unrelated file — one mechanism, one
pinned file.

---

## Context the implementer needs

### The channels, verbatim

```ts
// contracts/types/codegraph-extraction.ts:309 — already written by the walker
// for EVERY `from … import …`, including `from . import _x as y`.
export interface ModuleReexport {
  readonly exportedName: string;   // "datatable"      (what an importer sees)
  readonly sourceModule: string;   // "."              (exactly as written)
  readonly sourceName?: string;    // "_datatable"     (absent for a star)
}
// Run-global at resolve time: ctx.moduleReexports?.[relPath] -> ModuleReexport[]
// (domains/trajectory/codegraph/symbols/run-state.ts:453)

// contracts/types/codegraph-local-binding.ts:24 — E4.6a adds `endLine`.
export interface LocalBinding {
  line: number;                    // 1-based line the binding is ESTABLISHED
  type: string;
  valueKind?: "instance" | "class";
  typeRef?: RubyTypeRef;
  endLine?: number;                // NEW: last line of the establishing STATEMENT
}

// Run-global, keyed by symbolId; a top-level def's key is its bare name, a
// member's is `Cls#m` (instance) or `Cls.m` (class) — see
// pythonInheritedMemberType (strategies/shared.ts:354).
ctx.structuredReturnTypes?: Record<string, RubyTypeRef>
ctx.classFieldTypesByClassKey?: Record<string, Record<string, string>>  // "<relPath>::<Cls>"
```

### The four resolution sites this plan edits

```ts
// 1. resolver/python-chain-factory.ts — order IS precedence, and NOTHING here moves.
//    super, selfField, selfMember, localBinding, chainType, namingConvention,
//    importedName, globalShortName

// 2. resolver/strategies/python-imported-name.ts:355 — the module arm E4.6a extends.
private resolveModuleReceiver(binding, call, ctx): SymbolResolutionOutcome {
  if (!call.receiver) return CONTINUE;
  const mapped = this.mapper.mapImportToFile(receiverModuleText(binding), ctx.callerFile, ctx);
  if (mapped.kind !== "project") return CONTINUE;          // ← polar's 259 die here
  const target = this.moduleMemberTarget(call.member, mapped.relPath, ctx);
  return target ? resolved(target) : CONTINUE;
}

// 3. resolver/python-receiver-type-ports.ts:110 — the shadow rule E4.6a widens.
function pythonBindingInForceAt(receiver, atLine, ctx): LocalBinding | undefined {
  const bound = resolveLocalBinding(ctx.localBindings, receiver, atLine);
  if (bound?.line !== atLine) return bound;                // ← netbox's 50 die here
  if (findPythonImportBinding(ctx.imports, receiver) === null) return bound;
  return resolveLocalBinding(ctx.localBindings, receiver, atLine - 1);
}

// 4. resolver/strategies/python-global-short-name.ts — the LEGB order E4.6b-2 fixes.
if (call.receiver === null) {
  const sameFileModuleLevel = fallback.filter((d) => d.relPath === ctx.callerFile && isModuleLevel(d));
  const own = pickSingleCandidate(sameFileModuleLevel, "strict");
  if (own) return resolved(...);                            // ← G runs before E today
  if (PYTHON_BUILTINS.has(call.member)) return DROP;
  const reachable = pickSingleCandidate(fallback, this.cfg.mode);   // ← ambiguity kills E
  return reachable && isBareCallable(reachable, ctx) ? resolved(...) : CONTINUE;
}
```

`isBareCallable` and `isEnclosingScope` already exist in that file and already
model the reachability correctly, including the one-segment slack that
`callerScope` omitting its own container requires. E4.6b-2 REUSES them; it does
not restate the rule.

### The gate commands, exactly

```bash
# Row-level A/B, five corpora, five runs each side (B = worktree HEAD before the
# task, A = after). The five runs are what separates a real delta from jedi wobble.
for c in ugnest flask httpx netbox polar; do
  for i in 1 2 3 4 5; do
    npx tsx scripts/py-codegraph-jedi-oracle.ts --corpus $c --oracle merged --dispatch \
      --workers 8 --json ~/.claude/jobs/<job>/tmp/e4-6/<side>-$c-$i.json \
      > ~/.claude/jobs/<job>/tmp/e4-6/<side>-$c-$i.txt
  done
done

# Chain tally — drift AND dispatchDrift must read 0, five corpora, five runs.
npx tsx scripts/codegraph-chain-tally.ts --corpus <c> --lang python

# Ruby parity (Task E4.6b-1 only, because of the kernel splitter).
npx vitest run tests/core/domains/language/ruby tests/scripts/ruby-resolver-parity.test.ts
npx tsx scripts/spikes/ruby-resolver-parity.ts --corpus mastodon
npx tsx scripts/codegraph-chain-tally.ts --corpus mastodon --lang ruby

# Per-family attribution of the A side, to check the gain landed where predicted.
npx tsx scripts/py-e4-family-report.ts --rows <A-dump>.ndjson \
  --corpus-root <REAL corpus root> --corpus <c> --json <out>.json
```

**The corpus roots are NOT all under `tea-rags-bench/corpora`.** Read them from
`scripts/lib/codegraph-corpora.json`: ugnest `~/Dev/Collaborate/ugnest`, flask
`~/Dev/OpenSource/codegraph-test/flask`, and httpx / netbox / polar under
`~/Dev/Tools/tea-rags-bench/corpora/`. Passing the wrong root does not fail — it
silently turns every tier-2 read into a miss, which is exactly how D8 shipped
flask's numbers wrong.

### Reading the A/B

Per corpus, gross, never netted: `missed → match` and `fileOnly → match` counted
SEPARATELY, `lost` (must be 0), `wrongFile` delta, phantom delta in pp,
`exactReplacedByFan` / `exactReplacedByAmbiguous` (must be 0). Then the family
report on the A side: the family this task targets must SHRINK by the predicted
count per corpus, and no other family may grow.

---

## Task E4.6a — Module aliases: the package re-export hop and the shadow span (`w205u`)

**Target:** 309 rows — polar 259 (`from ..components import datatable`, the
package `__init__` aliasing a SUBMODULE) and netbox 50
(`layout = layout.Layout(…)`, the import shadowed by a multi-line class-body
assignment). Both currently read `answeredBy: none`, `verdict: missed`.
Expected: netbox `missed → match` +50, polar `missed → match` +259, `lost` 0,
phantom flat on all five corpora, and no change at all on ugnest / httpx / flask
(they carry zero addressable rows in this family — flask's 8 are `LocalProxy`
and must stay untouched, which is the task's own identity control).

**Files.** MOD `src/core/contracts/types/codegraph-local-binding.ts`; MOD
`src/core/domains/language/python/walker/walker.ts`; MOD
`src/core/domains/language/python/resolver/python-import-file-mapper.ts`; MOD
`src/core/domains/language/python/resolver/strategies/python-imported-name.ts`;
MOD `src/core/domains/language/python/resolver/python-receiver-type-ports.ts`;
NEW
`tests/core/domains/language/python/walker/python-local-binding-span.test.ts`;
MOD
`tests/core/domains/language/python/resolver/python-import-file-mapper.test.ts`;
MOD `tests/core/domains/language/python/resolver/python-imported-name.test.ts`;
MOD
`tests/core/domains/language/python/resolver/python-receiver-type-ports.test.ts`.

**Interfaces.**

```ts
// python-import-file-mapper.ts — the module-shaped sibling of resolveExportedName.
/**
 * Which FILE the package at `relPath` binds `name` to as a MODULE, or `null`.
 *
 * `resolveExportedName` answers "which file DECLARES this name" and requires a
 * SYMBOL to exist. A package that writes `from . import _datatable as datatable`
 * declares no symbol at all: the name denotes a sibling MODULE, and the answer
 * is that module's file. Same channel (`ctx.moduleReexports`), same hop budget,
 * same cycle guard, different terminator — a file rather than a declaration.
 */
resolveExportedModule(relPath: RelPath, name: string, ctx: CallContext): RelPath | null
```

### Steps — E4.6a

- [ ] **Step 0.** Fresh agent worktree; ff-merge `worktree-py-frontier-e4`.
      `npx vitest run tests/core/domains/language/python` green before starting.
      Read `src/core/domains/language/python/capability.ts` and CONFIRM
      `versions.walker` is 5; if it is anything else, stop and report.
- [ ] **Step 1 (RED — the mapper).** In `python-import-file-mapper.test.ts`,
      build a symbol table containing `pkg/__init__.py`, `pkg/_impl.py`
      (declaring `Widget`) and a caller, with
      `ctx.moduleReexports = { "pkg/__init__.py": [{ exportedName: "impl",     sourceModule: ".", sourceName: "_impl" }] }`.
      Assert: - `resolveExportedModule("pkg/__init__.py", "impl", ctx)` →
      `"pkg/_impl.py"`. - `resolveExportedName("pkg/__init__.py", "impl", ctx)`
      → `null` (unchanged — no symbol is named `impl`). - a two-hop chain
      (`pkg/__init__` → `sub/__init__` → `sub/_impl.py`) resolves, and a
      THREE-hop one returns `null` at `MAX_REEXPORT_HOPS`. - a cycle
      (`a/__init__` aliases `b`, `b/__init__` aliases `a`) returns `null` rather
      than recursing. - a star entry (`sourceName` absent) is skipped, not
      dereferenced.
- [ ] **Step 2 (GREEN — the mapper).** Implement beside `followReexports`,
      memoised on the SAME `memoFor(table)` object under a new `moduleAliases`
      map so the answer is computed once per `(relPath, name)` per table:

```ts
resolveExportedModule(relPath: RelPath, name: string, ctx: CallContext): RelPath | null {
  if (name.length === 0 || name === "*") return null;
  const memo = this.memoFor(ctx.symbolTable);
  const key = `${relPath} ${name}`;
  const cached = memo.moduleAliases.get(key);
  if (cached !== undefined) return cached;
  const answer = this.followModuleAlias(relPath, name, ctx, 0, new Set([relPath]));
  memo.moduleAliases.set(key, answer);
  return answer;
}

private followModuleAlias(
  relPath: RelPath, name: string, ctx: CallContext, depth: number, visited: Set<RelPath>,
): RelPath | null {
  if (depth >= MAX_REEXPORT_HOPS) return null;
  const entries = ctx.moduleReexports?.[relPath];
  if (entries === undefined) return null;
  for (const entry of entries) {
    if (entry.exportedName !== name || entry.sourceName === undefined) continue;
    // Compose exactly as `receiverModuleText` composes, so `.` + `_impl`
    // is `._impl` and never `.._impl` — a leading-dot module text that
    // gained a separator would climb a package.
    const text = entry.sourceModule.endsWith(".")
      ? `${entry.sourceModule}${entry.sourceName}`
      : `${entry.sourceModule}.${entry.sourceName}`;
    const direct = this.mapImportToFile(text, relPath, ctx);
    if (direct.kind === "project" && !visited.has(direct.relPath)) return direct.relPath;
    // The alias points at another PACKAGE that aliases further.
    const source = this.stepToSource(relPath, entry.sourceModule, ctx, visited);
    if (source === null) continue;
    const hit = this.followModuleAlias(source, entry.sourceName, ctx, depth + 1, visited);
    if (hit !== null) return hit;
  }
  return null;
}
```

- [ ] **Step 3 (RED — the strategy).** In `python-imported-name.test.ts`, a case
      whose caller writes `from .pkg import impl` then `impl.Widget()`, where
      `pkg/__init__.py` aliases `_impl`. Today it CONTINUEs; assert it resolves
      to `pkg/_impl.py::Widget`. Add the two DECLINE cases in the same block: an
      alias whose target maps EXTERNAL still CONTINUEs (never DROP — the DROP
      contract belongs to a binding that names a library, and this arm is asked
      after that verdict), and a target file declaring the member TWICE declines
      rather than picking.
- [ ] **Step 4 (GREEN — the strategy).** One arm at the END of
      `resolveModuleReceiver`, reached only when the composed text maps nowhere,
      so every site that resolves today is byte-identical:

```ts
private resolveModuleReceiver(binding, call, ctx): SymbolResolutionOutcome {
  if (!call.receiver) return CONTINUE;
  const mapped = this.mapper.mapImportToFile(receiverModuleText(binding), ctx.callerFile, ctx);
  if (mapped.kind === "project") {
    const target = this.moduleMemberTarget(call.member, mapped.relPath, ctx);
    if (target) return resolved(target);
  }
  // The package re-exports a SUBMODULE under this name rather than owning a
  // file of that name: `from . import _datatable as datatable`. The binding's
  // own module is the package; the receiver denotes what the package aliased.
  const pkg = this.mapper.mapImportToFile(binding.imp.importText, ctx.callerFile, ctx);
  if (pkg.kind !== "project") return CONTINUE;
  const aliased = this.mapper.resolveExportedModule(pkg.relPath, binding.importedName, ctx);
  if (aliased === null) return CONTINUE;
  const viaAlias = this.moduleMemberTarget(call.member, aliased, ctx);
  return viaAlias ? resolved(viaAlias) : CONTINUE;
}
```

- [ ] **Step 5 (RED — the shadow span).** In
      `python-local-binding-span.test.ts`, parse
      `x = x.Builder(\n    x.Row(),\n)` through the project's own AST helper
      (copy the parser setup from the neighbouring walker tests) and assert the
      emitted `localBindings.x[0]` carries `line` = the assignment's first line
      and `endLine` = its LAST line. Assert a single-line `y = Foo()` carries
      `endLine === line`. Assert an ANNOTATED binding (`z: Foo`) also carries
      `endLine` — the field is emitted for every binding, not only constructor
      ones, so nothing has to reason about which branch produced it.
- [ ] **Step 6 (GREEN — the walker).** Add the optional field to `LocalBinding`
      with a docblock saying it is the last line of the STATEMENT that
      establishes the binding and that absence means "unknown, treat as `line`".
      Then in `collectLocalBindingsForChunk` both push sites gain it:

```ts
const endLine = node.endPosition.row + 1;
// … annotation branch:
if (typeName) (out[varName] ??= []).push({ line, type: typeName, endLine });
// … constructor branch:
if (typeName && pythonLocalCalleeIsConstructor(typeName))
  (out[varName] ??= []).push({ line, type: typeName, endLine });
```

      `node` is the `assignment` node, so `endPosition` already spans the whole
      multi-line right-hand side. Do NOT add the field to the parameter-hint
      branch further down — a `def` parameter is not a shadowing statement, and
      an absent `endLine` reads as `line` at the consumer.

- [ ] **Step 7 (RED + GREEN — the ports).** In
      `python-receiver-type-ports.test.ts`, a context whose
      `localBindings.layout` is `[{ line: 204, endLine: 220, type: "Layout" }]`
      and whose `imports` bind `layout`: `pythonBindingInForceAt`-driven
      `singleHopType("layout",     210, ctx)` must return `undefined` (the
      import is in force), while at 221 it must return the `Layout` instance.
      Then widen the rule:

```ts
function pythonBindingInForceAt(
  receiver: string,
  atLine: number,
  ctx: CallContext,
) {
  const bound = resolveLocalBinding(ctx.localBindings, receiver, atLine);
  // Inside the statement that ESTABLISHES the binding, Python has not rebound
  // the name yet — the right-hand side is evaluated first. `endLine` is the
  // statement's extent; absent, it degenerates to the same-line test this
  // replaces, so a walker-1 index behaves exactly as before.
  if (bound === undefined || atLine > (bound.endLine ?? bound.line))
    return bound;
  if (findPythonImportBinding(ctx.imports, receiver) === null) return bound;
  return resolveLocalBinding(ctx.localBindings, receiver, bound.line - 1);
}
```

      Note the retry line changed from `atLine - 1` to `bound.line - 1`: at
      line 210 with a binding at 204, `atLine - 1` would find the SAME binding
      again. The narrow gate (an import bound the same name) is unchanged and is
      what keeps `x = Foo(); x.run()` on one line out of scope.

- [ ] **Step 8 (GATE — unit).**
      `npx vitest run tests/core/domains/language/python` green.
      `npx tsc --noEmit`. `npm run gen:lang-compat`; commit regenerated
      artifacts only if the generator's output moved.
- [ ] **Step 9 (GATE — rows).** A/B per the gate commands, five corpora, five
      runs. Required: netbox `missed → match` **+50**, polar **+259**, ugnest /
      httpx / flask deltas within jedi wobble, gross `lost` **0**, phantom delta
      ≤ +0.5 pp everywhere and ugnest exactly 0. Then the family report on the A
      side: `moduleAliasMember` must read netbox 0 and polar 8 (the classifier
      FPs), flask 8 unchanged. Any OTHER family growing is a regression to
      explain, not a rounding note.
- [ ] **Step 10 (GATE — tally + perf).** chain-tally `drift` 0 and
      `dispatchDrift` 0, five corpora × five runs. Interleaved B/A/A/B wall and
      RSS on netbox and polar, min per side, within +25 % / +20 %.
- [ ] **Step 11.** Commit
      `feat(language): resolve python package module aliases and shadow spans (w205u)`
      with the two trailers, then append a **Measured — E4.6a** block to this
      plan: the per-corpus A/B table, the family report before/after, the perf
      pair, and the walker-version line.

### Measured — E4.6a (2026-09-11, dumps under `~/.claude/jobs/dffe3647/tmp/e46a/`)

**Both predictions landed exactly.** Row-level A/B, five corpora × five runs
each side, `--oracle merged --dispatch --workers 8`, B taken from a detached
checkout of the task's base (`3a3283e1d`). The transition matrix runs only over
rows whose verdict is identical across all five runs on BOTH sides; unstable
rows are counted, not dropped. The ONLY transition on any corpus is
`missed → match`.

| corpus | match         | missed    | fileOnly | wrongFile | phantom | gross lost |
| ------ | ------------- | --------- | -------- | --------- | ------- | ---------- |
| ugnest | 765 → 765     | 13 → 13   | 0 → 0    | 0 → 0     | 0 → 0   | 0          |
| flask  | 326 → 326     | 39 → 39   | 6 → 6    | 1 → 1     | 0 → 0   | 0          |
| httpx  | 469 → 469     | 10 → 10   | 5 → 5    | 0 → 0     | 8 → 8   | 0          |
| netbox | 8224 → 8275   | 112 → 62  | 2 → 2    | 0 → 0     | 26 → 26 | 0          |
| polar  | 15859 → 16117 | 975 → 717 | 34 → 34  | 2 → 2     | 84 → 84 | 0          |

netbox **+50**, polar **+258** (predicted 259; the one row is inside jedi's own
wobble), every gain `answeredBy: importedName`. ugnest / flask / httpx are
byte-identical — flask's 8 `LocalProxy` rows never move, which is the task's own
identity control. Phantom is FLAT everywhere; `exactReplacedByFan` and
`exactReplacedByAmbiguous` are 0 on both sides.

**Family report, both sides re-tagged with the corrected classifier**
(`moduleAliasMember`, real corpus roots):

| corpus | residual   | `moduleAliasMember` | every other family |
| ------ | ---------- | ------------------- | ------------------ |
| netbox | 118 → 68   | 50 → **0**          | byte-identical     |
| polar  | 1032 → 774 | 259 → **1**         | byte-identical     |
| flask  | 48 → 48    | 0 → 0               | byte-identical     |

D8's denominators reproduce exactly once the two classifier false positives are
removed: 259 + 50 = 309 addressable rows, all 309 answered. The 16 rows decision
1a called non-addressable were a classifier defect, not a population — the
`import y as z` split and flask's `LocalProxy` globals, both fixed under this
task.

**Chain tally**, five corpora × five runs per side: `chainDrift` **0** and
`dispatchDrift` **0** on all 50 oracle runs and all 50 tally runs. Edges netbox
8642 → 8692 (+50), polar 16538 → 16796 (+258), ugnest / flask / httpx flat.

**Perf**, interleaved B/A/A/B, min per side, `/usr/bin/time -l`:

| corpus | wall B → A      | Δ      | peak RSS B → A    | Δ      |
| ------ | --------------- | ------ | ----------------- | ------ |
| netbox | 14.10s → 13.88s | −1.6 % | 2354 MB → 2371 MB | +0.7 % |
| polar  | 18.73s → 19.17s | +2.3 % | 2328 MB → 2351 MB | +1.0 % |

Well inside the +25 % / +20 % budget. **Ruby parity**: resolver 42,057 sites, 0
mismatches, 0 drift; walker 500 files, 0 mismatches — both against
`/Users/artk0re/Dev/Tools/tea-rags-mcp`. **Walker version stays 5**;
`npm run gen:lang-compat` regenerated nothing.

**One defect the A/B caught, and it is why the A side was measured twice.** The
alias arm first shipped calling `moduleMemberTarget`, whose re-export hop asks
which file in the PROJECT declares a bare name. polar's
`from .db.postgres import sql` reaches a shim that re-exports sqlalchemy's
`select`, the project declares exactly one `select`, and the hop pinned it on
every `sql.select(Model)` — 10 rows, `agreeExternal → phantom`, 0.15 % → 0.17 %.
Inside the cap and still wrong. The arm now takes the DECLARATION half only
(`moduleDeclarationTarget`); the hop stays on the composed-module-text arm above
it, where netbox's rows depend on it. Re-measured: phantom back to 84, all 258
gains kept.

---

## Task E4.6b-1 — Chain heads that are calls, constructors and casts (`w205u`)

**Depends on E4.6a** (39 of the 44 constructor rows have a module-alias head).

**Target:** 77 rows in the two chain-head families — 44 `constructorChainHead`
and 33 of 35 `callResultChainHead`. Per corpus: polar 39 + 12 + 15 + 3 = 69,
netbox 4 + 2 = 6, httpx 1, flask 1, ugnest 0.

The 22 `untypedFieldHop` rows that share these mechanisms are NOT here. They are
`self.<field> = <call>` assignments, and `callResultBindings`
(`contracts/types/codegraph-local-binding.ts:103`) records single-IDENTIFIER
targets only — a `self.field` target has no channel at all, so the mechanisms
this task builds have nothing to read at that site. Task E4.6c adds the channel
and consumes the two ports built here.

**Files.** MOD `src/core/domains/language/kernel/receiver-type-propagation.ts`;
MOD `src/core/domains/language/python/resolver/python-receiver-type-ports.ts`;
MOD `tests/core/domains/language/kernel/receiver-type-propagation.test.ts`; MOD
`tests/core/domains/language/python/resolver/python-receiver-type-ports.test.ts`.

**Interfaces.**

```ts
// kernel/receiver-type-propagation.ts
/**
 * Split a receiver into HOPS on `.` at bracket depth 0. `Notification(user=self.user)`
 * is ONE hop, not three: the dots inside a call's arguments, a subscript or a
 * literal belong to the argument, not to the chain. Quote-aware, so a dotted
 * string default cannot open a bracket that never closes.
 */
export function splitReceiverHops(receiver: string): string[];
```

```ts
// python-receiver-type-ports.ts — three new private helpers, no new port.
/** `Datatable[Benefit, S]` → `Datatable`; `Datatable` → `Datatable`. Python generics only. */
function stripPythonSubscript(name: string): string;
/** `get_client()` as a chain HEAD: the callee's own recorded return type, or undefined. */
function pythonCallHeadReturnType(
  callText: string,
  ctx,
  mapper,
): TypeRef | undefined;
/** `typing.cast(T, x)` / `cast(T, x)` → instance of `T`, when `cast` came from `typing`. */
function pythonCastHeadType(receiver: string, ctx): TypeRef | undefined;
```

### Steps — E4.6b-1

- [ ] **Step 0.** Fresh agent worktree; ff-merge `worktree-py-frontier-e4` (it
      now carries E4.6a). Green suite. Then TWO reads that decide branches
      below, and REPORT both before writing code: 1. Does the annotation facet
      record a `-> Self` return? Grep `python-annotation-type-source.ts` and
      `walker/passes/python-return-expression.ts` for how `Self` is handled. If
      `Self` is DROPPED, Step 6 adds its emission; if it is recorded as the
      literal name `Self`, Step 6 only adds the substitution. 2. Do Ruby's
      parity harnesses pass on this worktree BEFORE any edit
      (`ruby-resolver-parity.ts --corpus mastodon`)? That is the baseline Step
      3's gate compares against.
- [ ] **Step 1 (RED — the splitter).** In
      `tests/core/domains/language/kernel/receiver-type-propagation.test.ts`: -
      `splitReceiverHops("a.b.c")` → `["a","b","c"]` (unchanged behaviour). -
      `splitReceiverHops("Notification(user=self.user, event=self.t())")` → one
      element, the whole text. -
      `splitReceiverHops("datatable.Datatable[A, B](x.y())")` →
      `["datatable", "Datatable[A, B](x.y())"]`. -
      `splitReceiverHops("d[k.j].m")` → `["d[k.j]", "m"]`. -
      `splitReceiverHops("f('a.b').g")` → `["f('a.b')", "g"]` — quotes count. -
      an UNBALANCED receiver (`"f(a.b"`, which a truncated call text can
      produce) falls back to the whole string as one hop rather than throwing.
- [ ] **Step 2 (GREEN — the splitter).** Implement it as a single left-to-right
      scan tracking depth over `([{` / `)]}` and a quote state for `'` and `"`,
      splitting only at depth 0 outside quotes. Use it in `propagateChain` in
      place of `receiver.split(".")`, and use it in `receiverTypeRefOf`'s
      `receiver.includes(".")` test as well — a receiver whose only dots are
      inside brackets must go to `singleHopType`, not to the chain:

```ts
function receiverTypeRefOf(receiver, atLine, ctx, ports): TypeRef | undefined {
  const hops = splitReceiverHops(receiver);
  if (hops.length > 1) return propagateChain(hops, atLine, ctx, ports);
  return ports.singleHopType(receiver, atLine, ctx);
}
```

      `propagateChain` takes the already-split hops so the split happens once.

- [ ] **Step 3 (GATE — Ruby parity, and the fork it may force).**
      `npx vitest run tests/core/domains/language/ruby tests/scripts/ruby-resolver-parity.test.ts`,
      `npx tsx scripts/spikes/ruby-resolver-parity.ts --corpus mastodon`,
      `npx tsx scripts/codegraph-chain-tally.ts --corpus mastodon --lang ruby`.
      All must read **0 drift against Step 0's baseline**. If any drifts: revert
      the `propagateChain` call site, add
      `splitReceiverHops?: (receiver: string)     => string[]` to
      `ReceiverTypePorts`, default it to `(r) => r.split(".")` in the kernel,
      and have ONLY `createPythonReceiverTypePorts` /
      `createPythonCallBindingPorts` supply the bracket-aware one. Record which
      branch was taken in the commit body — do not decide silently.
- [ ] **Step 4 (RED — constructor and subscript heads).** In
      `python-receiver-type-ports.test.ts`:
      `singleHopType("Notification(user=self.u)",     L, ctx)` → instance of
      `Notification` when `Notification` resolves to a project file, `undefined`
      when it does not. `seedHead("datatable",     "Datatable[A, B](…)", ctx)` →
      `{ type: instance Datatable, consumedMembers: 1 }` when the head is an
      import-bound module whose file declares `Datatable`; `undefined` when the
      file does not declare it.
- [ ] **Step 5 (GREEN — constructor and subscript heads).** In
      `pythonSingleHopType`, the `receiver.endsWith(")")` arm strips the
      subscript before the class test; in `pythonModuleAliasSeed`, the same:

```ts
function stripPythonSubscript(name: string): string {
  const bracket = name.indexOf("[");
  return bracket === -1 ? name : name.slice(0, bracket);
}
// pythonSingleHopType, constructor arm:
const bare = stripPythonSubscript(stripCallArgs(receiver));
// pythonModuleAliasSeed:
const member = stripPythonSubscript(stripCallArgs(firstLink));
```

      `pythonModuleAliasSeed`'s `resolveTypeFile(member, ctx, mapper)` gate
      currently asks the CALLER's imports for `member`, which a module-alias
      head never binds. Widen it exactly one step, and no further: map the
      HEAD's import (through `receiverModuleText`, then E4.6a's
      `resolveExportedModule` when that maps nowhere) and require the resulting
      file to DECLARE `member` as a unique top-level symbol — the same
      `moduleMemberTarget` gate `importedName` uses. A head that maps nowhere,
      or a file that does not declare the class, still returns `undefined`.

- [ ] **Step 6 (RED + GREEN — `-> Self`).** A classmethod whose recorded return
      is `Self` types as an INSTANCE of the receiver's own class, not as a class
      called `Self`. Test:
      `memberTypeOf({form:"class", name:"AccountRepository"},     "from_session", ctx)`
      with `structuredReturnTypes["RepositoryBase.from_session"] = Self` and
      `AccountRepository` inheriting `RepositoryBase` → instance of
      `AccountRepository` (the RECEIVER's class, not the declaring one — that is
      what `Self` means). Implement the substitution in `pythonMemberTypeOf`,
      after `pythonInheritedMemberType` answers, so the MRO walk is unchanged:

```ts
const found = pythonInheritedMemberType(
  recv.name,
  member,
  recv.form,
  ctx,
  mapper,
  linearizers?.for(ctx),
);
if (found?.form === "instance" && found.name === "Self")
  return { form: "instance", name: recv.name };
return found;
```

      If Step 0 found `Self` is dropped rather than recorded, add its emission
      in the annotation facet FIRST, as its own RED test, and keep the
      substitution above unchanged.

- [ ] **Step 7 (RED + GREEN — a call as the head).** Test: a receiver
      `get_client()` at a site whose file imports `get_client` from a project
      module declaring `def get_client() -> PolarSelfClient`, with
      `structuredReturnTypes["get_client"]` present → instance of
      `PolarSelfClient`. Two DECLINE tests that carry the precision argument: a
      callee whose short name has more than one project-wide definition →
      `undefined`; a callee with no return fact → `undefined`.

```ts
function pythonCallHeadReturnType(receiver, ctx, mapper): TypeRef | undefined {
  const callee = stripCallArgs(receiver);
  if (!/^[a-z_]\w*$/.test(callee)) return undefined; // a Class head is the ctor arm
  // Where is it declared? An import binding first, then the caller's own module
  // scope — the same two arms a bare call reaches, and nothing wider.
  const candidates = lookupPythonSymbolsByShortName(ctx, callee);
  if (candidates.length !== 1) return undefined; // run-global key would collide
  const def = candidates[0];
  const bound = findPythonImportBinding(ctx.imports, callee);
  const reachable =
    (def.relPath === ctx.callerFile && def.scope.length === 0) ||
    (bound !== null &&
      this.mapper.mapImportToFile(bound.imp.importText, ctx.callerFile, ctx)
        .kind === "project");
  if (!reachable) return undefined;
  return ctx.structuredReturnTypes?.[def.symbolId];
}
```

      The `candidates.length !== 1` gate is not a cardinality guess — it is what
      makes the run-global `structuredReturnTypes` key (a bare name for a
      top-level def) unambiguous. Without it the map could answer with another
      file's `get_client`. Wire it into `pythonSingleHopType`'s
      `receiver.endsWith(")")` arm, AFTER the constructor test, so a capitalized
      head keeps today's path exactly.

- [ ] **Step 8 (RED + GREEN — `typing.cast`).** `typing.cast(T, x).m()` and
      `cast(T, x).m()` type as an instance of `T`, when `cast` (or `typing`) is
      import-bound to `typing` and `T` resolves to a project file. Three rows on
      polar; it is here because it is four lines and shares the arm. Read the
      first argument by splitting the argument text at the first top-level comma
      with the SAME depth scanner Step 2 built — do not add a second one.
- [ ] **Step 9 (GATE — unit).** Full python + kernel suites, `npx tsc --noEmit`.
- [ ] **Step 10 (GATE — rows).** A/B, five corpora × five runs. Required: polar
      `missed → match` **+69**, netbox **+6**, httpx **+1**, flask **+1**,
      ugnest within wobble. Gross `lost` 0; phantom delta ≤ +0.5 pp; ugnest 0.
      Family report on the A side: `constructorChainHead` → 0 everywhere,
      `callResultChainHead` → 2 (flask's `self_ref()` and netbox's `cls(job)`),
      `untypedFieldHop` **unchanged at 111** — its 22 call-assigned rows are
      E4.6c's, and a drop here means an unintended path opened.
- [ ] **Step 11 (GATE — tally, Ruby, perf).** chain-tally `drift` 0 /
      `dispatchDrift` 0 on five Python corpora; Ruby parity re-run and 0; perf
      pair on netbox and polar within budget. The splitter is the one change in
      this plan with a real perf surface — a per-hop scan instead of a
      `split(".")` — so report the wall numbers even if they are flat.
- [ ] **Step 12.** Commit
      `feat(language): type python call, constructor and cast chain heads (w205u)`,
      then append a **Measured — E4.6b-1** block: the A/B table, which Ruby
      branch Step 3 took, the family deltas, and the perf pair.

### Measured — E4.6b-1 (2026-09-11, dumps under `~/.claude/jobs/dffe3647/tmp/e46b1/`)

**Step 3 took the PORT branch.** The kernel splitter drifted Ruby: 34 mastodon
mismatches on `ruby-resolver-parity --before-root …/tea-rags-mcp`, every one a
`before: null → after: <resolved>` on the shape
`StatusFilter.new(quote.quoted_status, account).filter_state_for_quote`. Gains,
but unmeasured ones, and the gate is parity. `splitReceiverHops` is now an
OPTIONAL port defaulting to `receiver.split(".")`; only
`createPythonReceiverTypePorts` supplies the bracket-aware scan. Re-run:
resolver 42,057 sites / **0 mismatches / 0 drift**, walker 500 files / **0
mismatches**.

**Step 0's other read found a THIRD state, not the two the task listed.** `Self`
is neither dropped nor recorded literally — `python-type-annotation.ts:123`
resolves it to the ENCLOSING class at walk time, so
`structuredReturnTypes["RepositoryBase.from_session"]` read `RepositoryBase`.
The facet now passes the marker for a RETURN annotation only
(`PYTHON_SELF_RETURN`); a parameter and an ivar keep the enclosing-class answer,
because only a return is polymorphic in the receiver. The substitution lives in
`pythonInheritedMemberType`, not in one port, so `selfField` reads it on the
same terms. Walker version stays **5**; `--force-enrichments` would be needed
before a live read, and no reindex was run.

**Row-level A/B**, five corpora × five runs each side, `--samples 500000` so the
per-verdict lists are the WHOLE row set. Every corpus was byte-identical across
its five runs on both sides — zero jedi wobble this time, so the transition
matrix is exact.

| corpus | missed    | fileOnly | wrongFile | phantom | edges           | gross lost |
| ------ | --------- | -------- | --------- | ------- | --------------- | ---------- |
| ugnest | 13 → 13   | 0 → 0    | 0 → 0     | 0 → 0   | 770 → 770       | 0          |
| flask  | 39 → 39   | 6 → 6    | 1 → 1     | 0 → 0   | 345 → 345       | 0          |
| httpx  | 10 → 9    | 5 → 5    | 0 → 0     | 8 → 8   | 491 → 492       | 0          |
| netbox | 66 → 61   | 2 → 2    | 0 → 0     | 26 → 26 | 8692 → 8697     | 0          |
| polar  | 717 → 514 | 11 → 29  | 2 → 16    | 84 → 84 | 16,796 → 17,479 | 0 (+14 OW) |

`missed → match|fileOnly`: httpx **+1**, netbox **+5**, polar **+203**, flask
and ugnest byte-identical. Phantom is FLAT on every corpus (Δ 0.000 pp, ugnest
0); `exactReplacedByFan` and `exactReplacedByAmbiguous` unchanged. `chainDrift`
and `dispatchDrift` **0** on all 50 oracle runs and all 25 tally runs.

**Chain regressions 0. The 14 polar rows re-scored `match → wrongFile` are
ORACLE-WRONG (`Self`), pyright-confirmed.** They are booked as `oracleWrongSelf`
/ `OW:Self` — a new class in the spec's D9, listed there by `relPath:line` — and
E4.6-close subtracts them from the gross-lost column the way D9's other `OW:*`
classes are subtracted from `precisionMissAdjusted`.

pyright, driven straight at those 14 sites through
`scripts/py-oracle/lsp_oracle.ts` (config `roots: [server, sdk/python]`, the
corpus venv, pythonVersion 3.14), answered `CustomerRepository#update@98` /
`#create@71` on **14 of 14** — byte identical to the chain's new target, symbol
and line. jedi answers the class that DECLARED `from_session`, which is the same
mistake the walker's own pre-E4.6b-1 `Self` handling made; the two errors
agreed, which is exactly why these rows read `match` before this task and
`wrongFile` after it.

A control run substituting the DECLARING class for `Self` (everything else
identical) attributes the delta:

| mechanism                               | polar `missed → ok`  | `ok → wrongFile` |
| --------------------------------------- | -------------------- | ---------------- |
| splitter + subscript + call head + cast | **+40** (+3 skipped) | **0**            |
| `-> Self` substitution                  | **+163**             | **14**           |

All 14 are one shape: `repository.update(…)` / `customer_repository.create(…)`,
`answeredBy: localBinding`, now targeting `CustomerRepository#update|#create` in
`server/polar/customer/repository.py`. **The new answers are the ones Python
runs.** `repository = CustomerRepository.from_session(session)`;
`kit/repository/base.py:165` reads
`def from_session(cls, session) -> Self: return cls(session)`; and
`customer/repository.py` OVERRIDES both `create` (line 71) and `update` (line
98). Step 6 therefore ships as measured.

**Family report, A side:** `constructorChainHead` → **0 on every corpus** (httpx
1 → 0, netbox 4 → 0, polar 39 → 0), exactly as predicted. `callResultChainHead`
netbox 3 → 2, polar 30 → 19, flask 2 → 2 (the two rows the task pinned rather
than answered). `untypedFieldHop` polar **82 → 82**, unchanged — its 22
call-assigned rows stay E4.6c's. NO family grew on any corpus; polar's
`untypedNameReceiver` fell 377 → 235, which is the `Self` substitution reaching
E4.1's population.

**Perf**, chain-tally, min of two per side, `/usr/bin/time -l`:

| corpus | wall B → A      | Δ      | peak RSS B → A    | Δ      |
| ------ | --------------- | ------ | ----------------- | ------ |
| netbox | 13.51s → 13.58s | +0.5 % | 2468 MB → 2487 MB | +0.8 % |
| polar  | 18.17s → 18.08s | −0.5 % | 2413 MB → 2429 MB | +0.7 % |

**One harness note.** `codegraph-chain-tally.ts --lang ruby` does not exist —
`no chain spec for language 'ruby' (have: python, java)`. The Ruby gate is the
two parity spikes, and both read 0; the plan's gate command list is wrong here,
not the harness.

---

## Task E4.6b-2 — Bare calls: LEGB reaches `E` before `G` (`w205u`)

**Independent of E4.6a and E4.6b-1** — it touches one file neither of them does,
and may run in a parallel agent worktree.

**Target:** 85 rows, every one of them a NESTED def in the caller's own file:
polar 69, flask 6, netbox 6, httpx 4. Split by verdict, because the two halves
report differently: **47 `missed → match`** (polar 43, netbox 4) and **38
`fileOnly → match`** (polar 26, flask 6, httpx 4, netbox 2). The `fileOnly` half
is the same defect one step further along — the same-file MODULE-LEVEL arm
answered with the file's own top-level def of that name, so the file was right
and the symbol was wrong.

`crossFileBareCall` is folded here as a RECORD, not a mechanism: 4 addressable
rows on polar, 12 `skippedInProject` that belong to D9's external-vocabulary
defect, and 15 whose target is not spelled like the call. Step 6 asserts the
family does not MOVE; nothing in this task tries to answer it.

**Files.** MOD
`src/core/domains/language/python/resolver/strategies/python-global-short-name.ts`;
MOD
`tests/core/domains/language/python/resolver/python-global-short-name.test.ts`.

### Steps — E4.6b-2

- [ ] **Step 0.** Fresh agent worktree; ff-merge `worktree-py-frontier-e4`.
      Green suite. Confirm `isEnclosingScope` and `isBareCallable` are present
      in the strategy file with the one-segment slack docblock — E4.0.5 shipped
      them and this task consumes them. If they are absent, STOP: the branch is
      not the one this plan was written against.
- [ ] **Step 1 (RED).** In `python-global-short-name.test.ts`, four cases, each
      with `call.receiver === null` and `ctx.callerFile` set: 1. **E beats G.**
      The caller's file declares BOTH a module-level `def url` and
      `_list_tabs#url` nested inside `_list_tabs`; the call site is inside
      `_list_tabs` (`callerScope: []`, since `callerScope` omits the caller's
      own container). Expect `_list_tabs#url`, not the module-level one. This is
      the 38-row `fileOnly` half and it FAILS today. 2. **Ambiguity elsewhere
      does not kill E.** The caller's file declares `outer#helper`; six other
      project files declare a `helper` too. Expect `outer#helper`. This is the
      47-row `missed` half and it fails today because `pickSingleCandidate` runs
      over the whole table first. 3. **Deepest scope wins.** `Cls.method#inner`
      and `Cls#inner` both exist in the file, call site inside `Cls.method`
      (`callerScope: ["Cls"]`). Expect `Cls.method#inner` — Python's LEGB
      reaches the nearer frame. 4. **A sibling's nested def is NOT reachable.**
      `other#helper` exists in the file, call site inside an unrelated
      `Cls.method`. Expect the arm to DECLINE and the site to fall through to
      today's behaviour unchanged. Add a fifth, pinning what must not move: a
      bare call to a module-level def in the caller's file still resolves
      through the existing arm, and a bare builtin the file does not shadow
      still DROPs.
- [ ] **Step 2 (GREEN).** One arm, inserted BEFORE the existing same-file
      module-level arm, because the interpreter resolves local → enclosing →
      module and this arm IS the `E`:

```ts
if (call.receiver === null) {
  // ── Enclosing scope wins over module scope, because Python says so ────────
  // A bare name inside `def outer` reaches a `def inner` declared in `outer`'s
  // frame before it reaches the module's own binding of that name. Every one of
  // the 85 addressable same-file bare calls names such a nested def
  // (`_list_tabs#url`, `Blueprint._merge_blueprint_funcs#extend`,
  // `populate_port_template_mappings#generate_copies`), and 38 of them are
  // currently answered by the MODULE-level arm below — right file, wrong symbol.
  //
  // The candidate set is filtered FIRST here, unlike the cardinality guard at
  // the bottom of this method, and the difference is what makes it sound: a
  // nested def in the caller's own enclosing chain is not a guess among
  // project-wide namesakes, it is the binding the interpreter reaches. A
  // project-wide tie among unrelated files cannot make it wrong.
  const enclosing = fallback.filter(
    (def) =>
      def.relPath === ctx.callerFile &&
      def.scope.length > 0 &&
      isEnclosingScope(def.scope, ctx.callerScope),
  );
  // Deepest frame first — `Cls.method#inner` before `Cls#inner`.
  const deepest = enclosing.filter(
    (def) =>
      def.scope.length === Math.max(...enclosing.map((d) => d.scope.length)),
  );
  const nested = pickSingleCandidate(deepest, "strict");
  if (nested)
    return resolved({
      targetRelPath: nested.relPath,
      targetSymbolId: nested.symbolId,
    });

  const sameFileModuleLevel = fallback.filter(
    (def) => def.relPath === ctx.callerFile && isModuleLevel(def),
  );
  // … unchanged from here down
}
```

      `def.scope.length > 0` is what keeps the arm from swallowing the
      module-level case: a top-level def has an empty scope and belongs to the
      arm below. `"strict"` rather than `this.cfg.mode` matches the module-level
      arm it precedes — two nested defs of the same name in the same enclosing
      chain is a real ambiguity and declining is correct.

- [ ] **Step 3 (RED + GREEN — the slack, stated as a test).** `isEnclosingScope`
      admits one extra segment, which lets a class-body member of the CALLER's
      own class through — a known over-admission E4.0.5 measured at zero cost
      for the module-level arm. This arm runs EARLIER, so pin it: a call inside
      `Cls.method` with `Cls#sibling` declared in the same file must resolve to
      `Cls#sibling` only when no nearer frame declares the name, and the
      existing E4.0.5 pins for the module-level arm must still pass unchanged.
      If Step 6's phantom column moves on any corpus, tighten the arm to
      `def.scope.length <= ctx.callerScope.length` (dropping the slack) and
      re-measure — the plan expects this NOT to be needed, and says so here so
      the executor has the fallback rather than inventing one.
- [ ] **Step 4 (GATE — unit).**
      `npx vitest run tests/core/domains/language/python` green;
      `npx tsc --noEmit`. No walker change, so no capability bump and no
      `gen:lang-compat` run.
- [ ] **Step 5 (GATE — rows).** A/B, five corpora × five runs. Required and
      reported as TWO columns: `missed → match` **polar +43, netbox +4**;
      `fileOnly → match` **polar +26, flask +6, httpx +4, netbox +2**. Gross
      `lost` **0** — a `fileOnly` row becoming a `match` is not a loss, and any
      row that was a `match` and is no longer voids the task. Phantom delta ≤
      +0.5 pp, ugnest exactly 0, flask at or under 2 %.
- [ ] **Step 6 (GATE — family + tally).** Family report on the A side:
      `sameFileBareCall` down from 140 to **55** (the NAME_DIFF remainder),
      `crossFileBareCall` **unchanged at 31**, no other family grows.
      chain-tally `drift` 0 / `dispatchDrift` 0, five corpora × five runs. Perf
      pair on netbox and polar — the arm adds one filter over an
      already-computed candidate list, so this should be flat; report it anyway.
- [ ] **Step 7.** Commit
      `feat(language): resolve python bare calls to enclosing-scope defs (w205u)`,
      then append a **Measured — E4.6b-2** block with the two-column A/B table,
      the family before/after, and whether Step 3's fallback was needed.

---

## Task E4.6c — Untyped field hops: constructors, fallbacks and alias annotations (`w205u`)

**Depends on E4.6b-1** — Steps 6 and 7 there build the `Self` substitution and
the call-head return read that Step 4b here consumes at the FIELD site.

**Target:** 48 rows — polar 32, httpx 9, ugnest 7. Four sub-shapes:

| rows | shape                                             | step |
| ---- | ------------------------------------------------- | ---- |
| 12   | `self.f = Ctor(…)` (polar 8 class body, ugnest 4) | 1–3  |
| 3    | `self.f = A(…) if p else B(…)` (httpx)            | 3    |
| 11   | `self.f: Alias` where `Alias` renames an import   | 4a   |
| 22   | `self.f = <call>` (polar 13, httpx 6, ugnest 3)   | 4b   |

It does NOT target the 36 `Mapped[T]` rows: decision 1d routes those to E4.2,
and Step 5 asserts they are still there afterwards rather than quietly absorbed.

**Files.** MOD
`src/core/domains/language/python/walker/passes/python-class-body-fields.ts`;
MOD `src/core/domains/language/python/walker/passes/python-ast-type-source.ts`;
MOD `src/core/domains/language/python/resolver/strategies/shared.ts`; MOD
`src/core/contracts/types/codegraph-extraction.ts` (the `classFieldCallResults`
channel); MOD `src/core/domains/trajectory/codegraph/symbols/run-state.ts` (its
run-global fold, beside `classFieldTypesByClassKey`); MOD
`src/core/domains/language/python/walker/walker.ts`; MOD the matching test files
under `tests/core/domains/language/python/{walker,resolver}/` and
`tests/core/domains/trajectory/codegraph/symbols/`.

### Steps — E4.6c

- [ ] **Step 0.** Fresh agent worktree; ff-merge `worktree-py-frontier-e4` (it
      now carries E4.6a and E4.6b-1). Green suite. Re-run the family report on
      the current HEAD and record `untypedFieldHop` per corpus — it must still
      read **111** (ugnest 7, flask 11, httpx 9, netbox 2, polar 82). A lower
      number means E4.6b-1 opened a path it did not measure; report and stop.
      Then CONFIRM E4.6b-1 shipped both `pythonCallHeadReturnType` and the
      `Self` substitution in `pythonMemberTypeOf` — Step 4b consumes them and
      cannot be written without them.
- [ ] **Step 1 (RED — class-body constructor, import-bound class).**
      `python-class-body-fields.test.ts`: a file that IMPORTS `SlackClient` from
      a project module and writes `_client = SlackClient()` in a class body must
      emit `byShortName["Svc"]["_client"] = "SlackClient"`. The DECLINE cases
      are the whole precision argument and must be written first: a dotted RHS
      (`models.Manager()`) still emits nothing, and a bare `CharField()` whose
      name no import bound and no class in the file declares still emits
      nothing.
- [ ] **Step 2 (GREEN — class-body constructor).** The pass's docblock today
      says a plain construction requires a class the FILE DECLARES, because an
      import binding "cannot tell `netbox.models.querysets` from
      `django.db.models`". That is true of the walker in isolation and false of
      the pipeline: the fact is emitted as a NAME, and the resolve-time consumer
      (`resolveTypeFile` inside `pythonInheritedMemberType`) already refuses a
      name that maps outside the project. So widen the evidence to
      `declared ∪ importBound` for the bare-construction form, and say in the
      docblock WHY it is safe — the emitted name is not an edge, it is a
      candidate the mapper still has to place in the project. Update the
      docblock's "Deliberately SILENT on …" paragraph to cover only the dotted
      form, which stays silent.
- [ ] **Step 3 (RED + GREEN — `or` and ternary right-hand sides).** ugnest
      writes `self._tokens = token_service or ResolveTokenService()` and httpx
      writes
      `self.url = URL(url) if params is None else URL(url, params=params)`. Both
      are `__init__` field assignments whose RHS is not a bare call node. In
      `python-ast-type-source.ts`, extend the field-type inference to two more
      RHS node shapes, and to nothing else: - `boolean_operator` with operator
      `or`: take the RIGHT operand when it is a constructor call and the left is
      a bare identifier — the `param or Default()` idiom. Decline when both
      sides are calls of DIFFERENT classes (a union, and the engine never widens
      — decision 3 of `kernel/return-inference.ts` states the same rule). -
      `conditional_expression`: both arms must be constructor calls of the SAME
      class; anything else declines. Tests: the two real shapes resolve,
      `a or b` (no call) declines, `A() or B()` declines, `A(x) if p else B(y)`
      declines.
- [ ] **Step 4a (RED + GREEN — annotation names through an import alias).**
      polar writes `from polar.order.schemas import Order as OrderSchema` and
      then `data: OrderSchema` on a class, while the member lives on `Order`'s
      ancestor `OrderBase`. The annotation records the LOCAL name; the class key
      needs the SOURCE name. In `shared.ts`, wherever a type NAME is turned into
      a class key (`pythonReceiverClassKey` and its callers), consult
      `findPythonImportBinding(ctx.imports, name)` and use
      `binding.importedName` when it differs from `binding.localName` and the
      binding maps to a project file. Tests: the alias resolves to the source
      class, an unaliased import is byte-identical, and a local name that is NOT
      import-bound is byte-identical.
- [ ] **Step 4b (RED + GREEN — a field assigned from a CALL).** 22 rows, and the
      one place this plan adds a channel.
      `self.payment_repo =     PaymentRepository.from_session(session)` (polar
      13), `self._transport =     self._init_transport(…)` (httpx 6) and
      `self._provider = provider or     get_geo_provider()` (ugnest 3) all
      assign a field from a call whose return type the WALKER cannot know.
      `callResultBindings` records exactly this shape — the callee SPELLING for
      the resolver to fold — but only for single-identifier targets
      (`contracts/types/codegraph-local-binding.ts:103`), so a `self.<field>`
      target has no channel. - CONTRACT: add
      `classFieldCallResults?: Record<string, Record<string,       string>>` to
      `ChunkExtraction` — `shortClassName → field → callee       spelling` —
      with the run-global `byClassKey` companion the class-field channel already
      has, folded in `run-state.ts` beside `classFieldTypesByClassKey` and
      cleared in the same three places. - WALKER: emit it from the same
      `self.<field> = …` scan that fills `classFieldTypes`, for a `call` RHS
      whose callee is an identifier or a dotted attribute, arguments stripped —
      and for the RIGHT operand of an `or` when Step 3's rule admits it. A field
      with a TYPE fact already is not also recorded: the type is the better
      answer, exactly as the annotation branch preempts the constructor branch
      in `collectLocalBindingsForChunk`. - CONSUMER: in
      `pythonInheritedMemberType`, after both existing reads miss, look up the
      callee spelling and fold it with E4.6b-1's two mechanisms —
      `pythonCallHeadReturnType` for a bare `factory()`, the class-head seed
      plus the `Self` substitution for `Cls.from_session`. One level only, per
      decision 3. - Tests: the three real shapes resolve; a field with a type
      fact is unchanged; a callee that resolves outside the project declines; a
      callee with no return fact declines; a walker-5 index carrying no
      `classFieldCallResults` behaves byte-identically.
- [ ] **Step 5 (GATE — unit + rows).** Full python suite, `npx tsc --noEmit`,
      `npm run gen:lang-compat` (walker output changes; version stays 5). A/B,
      five corpora × five runs. Required: polar `missed → match` **+32** (8 +
      11 + 13), httpx **+9** (3 + 6), ugnest **+7** (4 + 3), netbox and flask
      within wobble. `lost` 0, phantom delta ≤ +0.5 pp, ugnest 0. Family report:
      `untypedFieldHop` from 111 to **63**, of which **36 are the `Mapped[T]`
      rows E4.2 owns** and 27 are the declined remainder — assert the 36 are
      still classified `untypedFieldHop` and were not absorbed.
- [ ] **Step 6.** Commit
      `feat(language): type python fields from constructors and alias annotations (w205u)`,
      then append a **Measured — E4.6c** block.

---

## Task E4.6-close — Gates, navigators, and the measurement record (`w205u`)

**Files.** MOD `src/core/domains/language/python/CLAUDE.md`; MOD
`src/core/domains/language/python/capability.ts` (tech text only); MOD
`src/core/domains/language/CLAUDE.md` if and only if a kernel change landed in
E4.6b-1; MOD `docs/superpowers/specs/2026-09-10-python-frontier-e4-design.md`
(the E4.6 section's record); MOD this plan.

### Steps — E4.6-close

- [ ] **Step 0.** Fresh agent worktree; ff-merge `worktree-py-frontier-e4`
      carrying all four implementation tasks. Confirm each of the four Measured
      blocks is present in this plan; a missing one means the task did not close
      and this one does not start.
- [ ] **Step 1 (GATE — the real unit gate).** `npm run test:coverage`, exit 0.
      Not `npm test` — pre-commit skips coverage and says so
      (`.claude/rules/epic-completion-gate.md`). A threshold failure goes to the
      `coverage-expander` subagent with the failing output, per
      `.claude/CLAUDE.md`; it is not fixed by lowering a threshold.
- [ ] **Step 2 (GATE — the whole-increment A/B).** One more A/B, B = the E4.6
      base commit, A = HEAD, five corpora × five runs, so the increment is
      measured end to end rather than as four separate deltas. Expected total
      `missed → match` + `fileOnly → match`, summing the four tasks: polar
      **+429** (a 259, b-2 69, b-1 69, c 32), netbox **+62** (a 50, b-2 6, b-1
      6), httpx **+14** (b-2 4, b-1 1, c 9), flask **+7** (b-2 6, b-1 1), ugnest
      **+7** (c 7) — **519 rows** against a residual of 1,247. Gross `lost` 0
      everywhere; phantom within +0.5 pp; ugnest phantom exactly 0; flask at or
      under 2 %.
- [ ] **Step 3 (GATE — tally, Ruby, perf, one last time).** chain-tally `drift`
      0 and `dispatchDrift` 0, five Python corpora × five runs. Ruby: full ruby
      suite, `ruby-resolver-parity.ts --corpus mastodon`, and chain-tally on
      mastodon AND taxdome — 0 drift. Interleaved B/A/A/B perf on netbox and
      polar, min per side, within +25 % wall / +20 % RSS.
- [ ] **Step 4 (navigators).** `python/CLAUDE.md` gains four invariants, each
      one sentence with its file, and NOTHING that restates a path-scoped
      rule: 1. A package that re-exports a SUBMODULE is answered by
      `resolveExportedModule`, not by `resolveExportedName` — the two terminate
      on different things (a file vs a declaration). 2. `LocalBinding.endLine`
      is the establishing STATEMENT's extent, and the import-shadow rule reads
      it; absence means "treat as `line`", which is what keeps a walker-1 index
      behaving as before. 3. A receiver splits into hops at bracket depth 0.
      Dots inside `(…)`, `[…]`, `{…}` or a string belong to the argument. 4. A
      bare call resolves local → ENCLOSING → module → builtins, in that order,
      and the enclosing arm filters candidates before it picks. If E4.6b-1
      landed the splitter in the kernel rather than behind a port,
      `language/CLAUDE.md` gains one line saying the split is shared and
      Ruby-parity-gated. `capability.ts` codegraph tech text gains the module
      re-export hop and the enclosing-scope arm; `versions.walker` STAYS 5.
- [ ] **Step 5 (records).** Append a **Measured — E4.6 (whole increment)** block
      to this plan: the five-corpus A/B, the family table before and after, the
      perf pair, and the residual composition that remains. Update the spec's
      E4.6 section to point at this plan and to carry the corrected
      `moduleAliasMember` count (325, not 317) and the flask corpus-root note.
      Update D8's E4.6 row with what actually landed.
- [ ] **Step 6.** Commit `docs(plans): record the E4.6 measurement (w205u)` and
      `docs(language): record the E4.6 resolution invariants (w205u)`. Do NOT
      merge to `main` and do NOT push — both are explicit-ask only.

---

## Task order, and what each one unblocks

| order | task       | depends on | unblocks                                | rows |
| ----- | ---------- | ---------- | --------------------------------------- | ---- |
| 1     | E4.6a      | —          | E4.6b-1 (39 rows), E4.6c (mechanism 13) | 309  |
| 1'    | E4.6b-2    | —          | nothing; runs in parallel with E4.6a    | 85   |
| 2     | E4.6b-1    | E4.6a      | E4.6c (its ports 7 and 8)               | 77   |
| 3     | E4.6c      | E4.6b-1    | —                                       | 48   |
| 4     | E4.6-close | all        | the E4.6 record in the spec             | —    |

E4.6a and E4.6b-2 share no file and may run as two concurrent agent worktrees.
Everything else is a straight line.

## What this plan does NOT claim

- **It does not close the residual.** 1,247 residual rows across five corpora;
  this plan addresses 519 of them and names the rest (decision 4).
- **It does not touch the parked dispatch component.** E4.1.3's flag and its
  files belong to another executor. No gate here runs with the fan-out on beyond
  the harnesses' own default `--dispatch`.
- **It does not answer a library-typed receiver.** `log.error(…)` where
  `log = structlog.get_logger()` stays unresolved, deliberately, and decision 2
  explains why a `moduleBindings` channel would not change that.
- **It does not fix the classifier defects it found.** `collectImportBindings`
  binding both sides of `from x import y as z`, and the E4.0.4 report run's
  wrong corpus roots for flask and ugnest, are recorded in decision 1 and 1a and
  left for `scripts/lib/py-residual-families.ts`'s own bead — a measurement tool
  changing under a measurement is not a change this plan can gate.
- **It does not claim a live number.** Every figure here is the offline oracle
  at `--oracle merged --dispatch --workers 8`. Reindex-and-`prime` validation is
  user-gated and is not part of any task's gate.
