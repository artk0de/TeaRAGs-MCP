# Python Frontier E4 — Design

**Status:** approved (user, 2026-09-10 — scope fixed, no approval loop in this
document) **Kind:** epic (one measurement increment + six capability increments)
**Related:** `tea-rags-mcp-9fgdi` (E2), `tea-rags-mcp-qclv2` (E3),
`tea-rags-mcp-w205u.1` / `w205u.2` (deferred out of E3), `tea-rags-mcp-f11nz` /
`6pd5l` / `zhetx` (open from the program), `tea-rags-mcp-f2jsb` / `j0pki`
(dispatch cap and its aggregates), `tea-rags-mcp-4vg1i` / `8qyax` (the merge
that landed on main today) **Worktree:** `.claude/worktrees/py-frontier-e4` at
main `78e6c40b2`

**Name collision, stated once.** The program spec
(`2026-09-03-python-codegraph-unification-program-design.md`) uses **E4** for
the SDK freeze (`z6ry9`). This document's E4 is a different thing: the
**frontier increment 2**, the recall work that follows seams 1–5 and E3
increment 1. Where the two must be distinguished, this one is **Frontier E4**
and the program's is **SDK freeze**. The SDK freeze is unchanged and still last
in the dependency graph; Frontier E4 sits between E3 and it, and every component
Frontier E4 adds is one more consumer proving a contract the freeze will
publish.

---

## Goal

Spend the increment on the families that actually carry the residual, in the
order the residual says — and know that order by measurement rather than by
shape-counting. Two things block that today and both are instrument defects, not
capability defects:

1. **A quarter of polar is outside the denominator.** parso 0.8.7 — the parser
   jedi 0.20.0 pins — rejects Python 3.14 grammar (`match`, PEP 758
   `except A, B:`, the `type` statement), so 20,424 polar rows and 2,331 netbox
   rows are `oracleDegraded` and dropped from every rate this program has
   published. Every claim about polar is a claim about the 75 % jedi could read.
2. **The dispatch layer is not exercised at all.** Both the oracle
   (`py-codegraph-jedi-oracle.ts:225`) and the tally
   (`codegraph-chain-tally.ts:438`) skip a call site whose `CallRef` carries
   `dispatch`, and neither ever calls `resolver.resolveDispatch`. Production
   calls it FIRST (`resolution-runner.ts:557`, cone-before-exact), so a fan-out
   REPLACES the exact chain's single answer. Whatever Python's cone emits today
   is invisible to every number this program has recorded, and every fan-out
   family in E4.1 would be unmeasurable on arrival.

So E4.0 is measurement, and it is the first thing that ships. E4.1–E4.6 are
ordered by what E4.0 attributes, and this document fixes their interfaces so the
ordering can change without a redesign.

---

## Ceiling map — where the chain stands, 2026-09-10

Overall in-project recall, integration `6d9eee602` (seam 5 + E3 increment 1),
seeded jedi oracle, five corpora. Denominator is
`match + missed + wrongFile + phantom`; `oracleDegraded`, `parseFailed` and
`oracleNonCallable` rows are excluded.

| corpus | recall | phantom + wrongFile / edges | edges  | chain sites |
| ------ | ------ | --------------------------- | ------ | ----------- |
| ugnest | 0.970  | 0 / 770 = **0.00 %**        | 770    | 4,731       |
| netbox | 0.969  | 27 / 8,651 = 0.31 %         | 8,651  | 44,126      |
| polar  | 0.951  | 186 / 16,623 = 1.12 %       | 16,623 | 56,710      |
| httpx  | 0.961  | 8 / 491 = 1.63 %            | 491    | 1,549       |
| flask  | 0.874  | 10 / 355 = **2.82 %**       | 355    | 1,346       |

flask is ABOVE the 2 % precision bar and was already above it before E3 — same
nine phantoms and one `wrongFile` on the same 355-edge denominator. Inherited,
recorded, not spent by any increment. A corpus this small puts one phantom at
0.28 pp, which is why the bar is read per corpus and never as a headline.

Per receiverKind after E3, with the residual bucket each one is
(`docs/superpowers/plans/2026-09-10-python-django-managers.md` → "Measurement
record" and "Residual after close"):

| corpus | kind       | n     | recall    | missed | what the residual IS                                        |
| ------ | ---------- | ----- | --------- | ------ | ----------------------------------------------------------- |
| netbox | `chain`    | 248   | **0.972** | 7      | 4 of 7 are `<Model>(…).save()` — constructor-result head    |
| netbox | `localVar` | 212   | 0.764     | 50     | all bare names; head is `layout.Row(…)` — a module alias    |
| netbox | `dynamic`  | 1,523 | 0.973     | 41     | 22 bare names, 17 `cls` receivers                           |
| netbox | `bareCall` | 5,049 | 0.997     | 12     | module-level defs called from a sibling migration function  |
| polar  | `chain`    | 1,610 | 0.953     | 75     | 71 dotted receivers (`item.type`) — untyped field hop       |
| polar  | `localVar` | 447   | 0.888     | 50     | bare names assigned from an unfolded call result            |
| polar  | `dynamic`  | 1,791 | 0.814     | 424    | 391 bare names — branch-bound receivers                     |
| polar  | `bareCall` | 7,972 | 0.947     | 103    | `prompt_setup` decorator-registered CLI commands, same file |
| ugnest | all        | —     | —         | —      | byte-identical through E3; `chain` 0/4 is the whole hole    |
| flask  | `chain`    | 29    | —         | 27     | 11 inherited field, 15 other — n too small to rank          |
| httpx  | `chain`    | 22    | —         | 16     | 10 own field, 3 inherited                                   |

Two readings the rest of this document rests on. First, **the big single-shape
levers are gone**: R4a (inherited field) and R1b (call-result local) were seam
5, the Django manager field was E3, and what is left is 762 missed rows spread
over a dozen shapes with no shape above 424. Second, **the residual is
concentrated in `dynamic` and in polar** — 424 of 762 — and `dynamic` is exactly
the kind a fan-out answers and a 1:1 chain cannot.

---

## E4.0 A — the second oracle

### The problem, in numbers

`jedi_oracle.py` runs TWO parses per file on purpose (`answer_file`, line 443):
`ast.parse` with the oracle interpreter is the ORACLE's own ability to read the
file, and `parso` — jedi's parser, which never raises and returns error nodes
instead — is counted through `grammar.iter_errors`. The host turns a non-zero
count into `oracleDegraded` (`py-codegraph-jedi-oracle.ts:514`), and
`isDegraded` in `scripts/lib/py-oracle-core.ts:275` drops those rows from every
rate.

| corpus | degraded rows | of total sites | cause                                       |
| ------ | ------------- | -------------- | ------------------------------------------- |
| polar  | 20,424        | ~24.7 %        | 26 + 53 files of PEP 758 / `match` / `type` |
| netbox | 2,331         | ~5.3 %         | 2 files with parso grammar errors           |
| others | 0             | 0              | —                                           |

polar runs its `ast.parse` on 3.14 (`oraclePython: "3.14"` in
`scripts/lib/codegraph-corpora.json`), so those files are NOT `parseFailed` —
the oracle reads them fine and jedi answers them from a damaged tree. That is
the worse failure: a degraded row carries an ANSWER, and the only reason it is
not scored is that nobody could say whether the answer meant anything.

### Contract

The second oracle is a peer of `jedi_oracle.py`, not a replacement, and the
contract is **schema identity**: it emits the SAME stdout NDJSON record shape,
so the TS host merges without knowing which engine produced a row.

```text
in  (stdin, NDJSON)   { kind: "config", corpusRoot, venvPython?, roots[], workers }
                      { kind: "file",  relPath, sites: [{ startLine, member, receiver, callText, receiverKind }] }
out (stdout, NDJSON)  { relPath, parseFailed, parsoErrors, answers: [
                          { startLine, member,
                            outcome: { kind: "inProject"|"external"|"unknown",
                                       origin?: PyTargetOrigin,
                                       targets?: [{ relPath, symbolId, defLine, defKind, pinUncertain }] },
                            unlocated?: PyUnlocatedShape,
                            siteFacts?: PySiteFacts } ] }
```

`parsoErrors` stays in the schema and reads `0` from an engine that does not use
parso — the field means "jedi's parser was unhappy", and an engine with no jedi
in it has nothing to report. `PyTargetOrigin`, `PySiteFacts` and
`PyUnlocatedShape` are the existing types in `scripts/lib/py-oracle-core.ts` and
do not change. `symbolId` composition must mirror `compose_symbol_id`
(`jedi_oracle.py:98`) exactly — `Class#method`, `Class.method` for a
`staticmethod` / `classmethod` decorator, bare name at module level,
`Outer.Inner` for nesting, `pinUncertain: true` with `defKind: "nonCallable"`
when the target line starts no `def` or `class`. An engine that cannot read the
target file back reports `defKind: "unknown"`, also `pinUncertain`.

`classify_origin`'s ORDER is part of the contract and not the obvious one
(`jedi_oracle.py:64`): bundled-stub markers, then `site-packages` /
`dist-packages`, then the stdlib DIRECTORY regex, and only THEN the corpus-root
containment test — because ugnest keeps its virtualenv inside its own checkout,
and a root-prefix-first order called Django's own source "project" in 26 of 30
sampled targets. The stdlib NAME test runs LAST and only for a path the corpus
does not contain. The second oracle reuses this function rather than re-deriving
it; if it is written in TypeScript, the port is line-for-line and its unit test
is the same table.

### Candidates

Neither is installed on this machine (`pyright: command not found`,
`ty: command not found`, and neither is in the `uv` cache), so E4.0.1 installs
both. What IS verified here:
`uv run --no-project --python 3.13 --with jedi==0.20.0` resolves **jedi 0.20.0 /
parso 0.8.7 on CPython 3.13.7**, which is the degradation this whole section
exists to route around.

- **pyright** (Microsoft, TypeScript, npm `pyright`). Ships a language server;
  the query is LSP `textDocument/definition` at the callee position, driven from
  a small stdio client. The project is TypeScript, so the client lives under
  `scripts/py-oracle/` next to the host and needs no second runtime. Its own
  parser is maintained against current CPython grammar, which is the whole point
  of choosing it. Risks: it wants a `pythonVersion` / `venvPath` configuration
  per corpus (five different venvs, one on 3.14.0rc2); LSP is stateful, so
  determinism has to be proven rather than assumed; and definition-per-request
  latency across ~20k sites is the number the spike exists to measure.
- **ty** (Astral, Rust, `ty server` speaks LSP). Same query shape, much faster
  in principle, and it reads `pyproject.toml` the way `uv` does. Risks: it is
  young — coverage of the answer space (does it answer `self.x.m()` at all? does
  it follow re-exports?) is unknown offline, and an engine that answers
  `unknown` on the sites we care about buys nothing however fast it is.

The spike decides on evidence, and the decision is recorded in this document's
decision record rather than in code. A THIRD outcome is admissible and must be
stated in the spike report if it holds: **neither passes**, in which case the
denominator stays where it is, the report keeps carrying the degraded counts,
and E4.1–E4.6 proceed against the 75 % of polar that is measurable.

### Merge rule — per FILE, never per site

The host holds one `Map<relPath, OracleReply>` keyed by file
(`py-codegraph-jedi-oracle.ts` `askOracle`), and the merge happens at that
granularity for a reason: jedi's per-process module cache makes one file's
answer depend on what its worker parsed before it (`jedi_oracle.py:539` — the
striped partition plus `maxtasksperchild=1` exists precisely because
`imap(chunksize=4)` moved a flask site between `external` and `unknown` run to
run). Mixing engines WITHIN a file would put two different module resolutions
behind one `jedi.Script` cache and make the row-level provenance unreadable.

```text
--oracle jedi    jedi only. Byte-identical to today. The default.
--oracle lsp     the second engine only. For the agreement measurement.
--oracle merged  per file: jedi's reply UNLESS jedi reported parsoErrors > 0
                 (or parseFailed), in which case the second engine's reply.
```

The second engine lives at `scripts/py-oracle/lsp_oracle.ts` — both candidates
speak LSP, so the file is named for the transport rather than for whichever
engine D7 picks, and switching engines is a launcher record, not a rewrite.

Every row carries `oracleEngine: "jedi" | "lsp"`, and every table the report
prints is broken out by it. The rule is deliberately asymmetric: jedi is primary
because five corpora of published numbers rest on it, and the second engine is a
REPAIR for files jedi could not read, never a tiebreak on files it could. The
one exception is the audit sample (E4.0 C), where both engines answer the same
100 rows on purpose.

### What "the denominator grows" breaks, and how the report keeps it honest

Every published Python number — the E0 final measurement record, seam 4, seam 5,
E3's measurement record — was computed on the OLD denominator, which is
`total − oracleDegraded − parseFailed − oracleNonCallable`. Adding 22,755 rows
(polar 20,424 + netbox 2,331) to the scored population changes those rates even
if not one line of resolver code moves. A number that changes for that reason is
not a regression and must never be reported as one.

So the rule is: **the report carries BOTH, always, side by side.**

| column                | denominator                                                                 |
| --------------------- | --------------------------------------------------------------------------- |
| `recallLegacy`        | jedi-answerable rows only — reproduces every published number byte-for-byte |
| `recallMerged`        | jedi rows + second-engine rows on files jedi could not read                 |
| `nLegacy` / `nMerged` | the two denominators, printed, never inferred                               |
| `oracleEngine`        | per row, so any table can be split by provenance                            |

`recallLegacy` is a REGRESSION GATE, not a legacy artifact: an E4.0 run must
reproduce E3's closing numbers exactly on it (netbox `chain` 0.972, polar
`localVar` 0.888, ugnest byte-identical), or the harness change broke something.
`recallMerged` is the number E4.1–E4.6 are measured against, and the first run
that produces it establishes a NEW baseline that is quoted with its date and its
HEAD, exactly as the E0 final record is.

Determinism is a gate, not a hope. jedi needed a fixed file→process assignment
to be reproducible (`jedi_oracle.py:539`); an LSP-backed engine is stateful in a
different and worse way, since a server accumulates a workspace as it answers.
The requirement is two consecutive full runs on one corpus producing
**byte-identical row dumps** on `(relPath, startLine, callText)` →
`(outcome.kind, origin, targets[0].relPath, targets[0].symbolId)`. Anything less
and the engine does not ship, however good its coverage is.

---

## E4.0 B — fan scoring

### What is not measured today

Python's `PythonCallResolver.resolveDispatch` (`python-resolver.ts:123`) is a
single `ConeDispatchResolver` handed the `PythonConeTypeLocator`. Production
consults it BEFORE the exact chain in the default channel
(`resolution-runner.ts:557`) and a non-empty fan-out REPLACES the chain's
answer; an over-cap `ambiguous` verdict emits NO edges and NO fallback
(`kernel/dispatch-narrowing.ts` terminal, cap from
`dispatchFanoutPolicyFor(ctx.symbolTable)` —
`max(16, ceil(p99 defs-per-member))`). The oracle and the tally both run
`resolveViaChain` only. Consequence: **the size of today's oracle-vs-production
gap is unknown and is exactly the number of Python sites where the cone fires.**
One piece of evidence says it is near zero on ugnest — E3's live validation read
770 edges from `prime`, "the oracle's AFTER dump exactly" — but ugnest is 770
edges and the other four corpora have never been reconciled that way.

**MEASURED (E4.0.3, `w205u`, 2026-09-10).** The gap is 30 sites in 108,462 —
0.03 %, and 28 of them carry a `localVar` receiver, the cone's own precondition:
22 on polar, 6 on httpx, 2 on flask, and none at all on ugnest or netbox. Five
exact `match` edges are lost — four to a fan (flask 1, polar 3), one to a
`single` cone answer — against two the fan rescues, so the published 1:1 recall
is the production recall to three decimal places on all five corpora.
`ambiguousShare` reads 0 everywhere by construction: `ConeDispatchResolver`
collapses over `coneMax` (8) rather than returning `ambiguous`, so the
corpus-adaptive cap — 16 on all five, its floor, against a p99 defs-per-member
of 7 to 11 — never binds a Python call today.

### Design

Fan scoring is an ADDITIVE second scoring pass over the same walk. The 1:1 bar
is untouched, and that is enforced mechanically rather than promised:
`--no-dispatch` reproduces today's columns byte-for-byte, and the E4.0.3 gate is
a diff of the two dumps.

For each scored site the harness now also calls
`production.resolveDispatch(call, ctx)` and records the outcome:

| column          | meaning                                                                         |
| --------------- | ------------------------------------------------------------------------------- |
| `fanOutcome`    | `none` (empty edges) \| `fan` (m ≥ 1 edges) \| `ambiguous` (over cap)           |
| `fan`           | `string[]` of `relPath#symbolId`, sorted, deduped — the dumped fan              |
| `fanSize`       | `fan.length`; 0 for `none`, and for `ambiguous` the `candidateCount`            |
| `fanConfidence` | the per-edge confidence the component assigned (1.0, or `discount / m`)         |
| `fanHitsOracle` | oracle's in-project target ∈ `fan` (file+symbol; file only when `pinUncertain`) |

and the report gains four fan metrics, per corpus and per receiverKind:

- **`recallAtFan`** — `fanHitsOracle` over the sites where the oracle has an
  in-project target and `fanOutcome` is not `none`. Read as "when the fan fires,
  does the right answer survive the narrowing".
- **`fanSizeMean` / `fanSizeP50` / `fanSizeP95`** — over `fanOutcome == "fan"`.
- **`ambiguousShare`** — `ambiguous / (fan + ambiguous)`. This is the cap's
  bite. A share that climbs when a family lands means the cap, not the family,
  is now the binding constraint.
- **`precisionProxy`** — `Σ (1 / fanSize)` over sites where `fanHitsOracle`,
  divided by the same denominator as `recallAtFan`. A 1-edge fan scores 1.0 and
  a 10-edge fan scores 0.1, which is the honest reading of an edge a consumer
  has to pick from ten.

**Why fan and 1:1 are never summed.** They are different products measured
against different bars. A confidence-1 edge is a claim: it is persisted,
navigable, and it is what the ≤ 2 % fabricated+wrongFile precision bar governs.
A fan edge is a HYPOTHESIS SET: it carries `discount / m` confidence, it is
navigation-hidden as Ruby's are, and its own quality metric is `precisionProxy`,
not the phantom bar. Adding a `recallAtFan` win to `recall` would let an
increment "gain recall" by fanning out over every class declaring the member —
the exact pathology `f2jsb` capped after 1.5 M noise edges on taxdome. So the
report prints them in separate column groups with separate denominators, and the
headline recall number for a corpus is and stays the 1:1 one.

**How `ambiguous` and the cap interact, stated so an executor does not misread
it.** `ambiguous` is not a fan of size > cap; it is the DECISION not to emit a
fan at all. It carries no edges, and `resolveDispatchViaComponents` treats it as
decisive — a later component may not re-fan a call an earlier one judged too
ambiguous. So `ambiguous` rows are excluded from `fanSize*` and from
`precisionProxy` (there is no fan to size), counted in `ambiguousShare`, and
counted in `recallAtFan`'s denominator as a MISS when the oracle had an
in-project target. That last choice is deliberate: an over-cap decision that
threw away the right answer is a cost of the cap, and hiding it would make the
cap look free.

---

## E4.0 C — the oracle-disagreement audit

Every rate in this program treats jedi as ground truth. It is not, and two known
shapes prove it: `applySuperMroBlindSpot` (`scripts/lib/py-oracle-core.ts:224`)
already excuses a class of `super()` rows where jedi's answer is wrong for a
cooperative-MI hierarchy, and `oracleNonCallable` (`z796g`) exists because
jedi's `goto` answers an ASSIGNMENT for `table = None` called as
`self.table(...)`, where no callable target exists for any chain to find. Both
were found by opening rows. Nobody has ever measured how much of the `phantom` /
`wrongFile` population is the same thing.

That matters now specifically because of flask. Its 2.82 % precision-miss rate
is the only corpus above the bar, it is 10 rows, and if six of them are oracle
artefacts then the bar was never breached. An increment cannot be asked to fix a
number that is an instrument reading.

**Protocol.** 100 rows, seeded PRNG (`mulberry32`, the same sampler
`samplePyRows` uses — never first-N), stratified across corpora proportional to
each corpus's `phantom + wrongFile` count, with flask over-sampled to its full
10 rows because n is small and the stakes are the bar. For each row:

1. Open the caller at `corpora/<corpus>/<relPath>:<startLine>` and read the
   binding site. This is the same manual method seam 5's decision 1 used, and it
   is the only method that has ever produced a correct attribution here.
2. Ask the second engine the same site (`--oracle lsp`), recording its answer as
   a third column.
3. Classify into exactly one of:

| class                  | meaning                                                                       |
| ---------------------- | ----------------------------------------------------------------------------- |
| `chainWrong`           | the chain's target is genuinely wrong; the oracle is right                    |
| `oracleWrongMro`       | cooperative `super()` / MI — the blind spot, possibly beyond its current gate |
| `oracleWrongSingleton` | module-level singleton or re-exported instance; jedi points at the assignment |
| `oracleWrongCache`     | the two engines disagree AND jedi's answer moves between runs — a cache flip  |
| `bothWrong`            | neither names the runtime target                                              |
| `undecidable`          | dynamic enough that no static answer exists                                   |

The second engine is the TIEBREAKER, not the judge: a row where the two engines
agree and the chain differs is `chainWrong` with high confidence; a row where
they disagree goes to manual reading and the reading wins.

**Output.** A table of the six classes per corpus, and a single derived number
per corpus: **`precisionMissAdjusted`** =
`(phantom + wrongFile − oracleWrong*) / edges`, printed BESIDE the unadjusted
rate and never instead of it. If flask's adjusted rate lands under 2 %, that is
recorded as a finding about the instrument, and the raw 2.82 % still stands in
the ceiling map.

---

## E4.0 D — family attribution, and the ordering it produces

The deliverable that orders E4.1–E4.6. Same method as seam 5 decision 1 and E3
decision 1: bucket every row of the FINAL tree by the mechanism that WOULD have
answered it, per corpus, in counts, from the row dumps rather than from a grep
over source. What is new is that the buckets are now families rather than single
shapes, and that two of them require running the harness twice.

Families, each with the column name the report prints and the increment it
feeds:

| family                 | detection                                                                         | feeds |
| ---------------------- | --------------------------------------------------------------------------------- | ----- |
| `unionBranchReceiver`  | `x = A() if c else B()`, `A \| B` annotation, `Optional[T]` on the binding        | E4.1  |
| `protocolReceiver`     | the receiver's annotated type is a `Protocol` subclass in-project                 | E4.1  |
| `transparentWrapper`   | `Mapped[T]`, `Annotated[T, …]`, `ClassVar[T]`, `Final[T]`, `Required/NotRequired` | E4.2  |
| `sqlalchemyRow`        | `session` / `select(X)` / `.execute` / `stmt` receivers (E3 increment-2 table)    | E4.2  |
| `pydanticRow`          | `model_validate` / `model_dump` / `model_copy`                                    | E4.2  |
| `drfViewAttr`          | `self.get_serializer()`, `self.request.user`, `self.get_object()`                 | E4.3  |
| `celeryEnqueue`        | `.delay(` / `.apply_async(` on a project task                                     | E4.3  |
| `djangoUrlRoute`       | `path("…", views.X)` / `as_view()` argument positions                             | E4.3  |
| `pytestFixture`        | a test-function parameter whose name is a project `@pytest.fixture` def           | E4.3  |
| `typeVarGeneric`       | `def f(x: T) -> T` with a `TypeVar` bound in scope                                | E4.4  |
| `asyncForm`            | `(await x).m()`, `async for`, `asyncio.gather(...)` results                       | E4.5  |
| `sameFileBareCall`     | callee `def` in the caller's own file, lost to cross-file ambiguity               | E4.6  |
| `constructorChainHead` | `Model(...).save()` — the chain head is a constructor result                      | E4.6  |
| `untypedFieldHop`      | dotted receiver whose field carries no type fact (polar's 71)                     | E4.6  |
| `runtimeOnly`          | computed `getattr`, `__getattr__` proxy, monkeypatch, metaclass, string dispatch  | OUT   |

Two families cannot be counted from one run:

- **`pytestFixture` needs the tests walked.** Production excludes test paths via
  `buildCodegraphExclusionFilter`, and the harness reproduces that exclusion
  exactly. So the family is measured TWICE — once with the standard exclusion
  and once with `CODEGRAPH_EXCLUDE_TESTS=false` — and the report prints both
  populations with the delta between them. The delta IS the family's size; the
  standard run remains the baseline for every other number.
- **`sqlalchemyRow` / `pydanticRow` have zero recall mass and are counted in
  EDGES.** E3's increment-2 measurement on polar found 2,550 SQLAlchemy rows and
  223 pydantic rows with **0 `missed`** — every one is `agreeExternal` or
  `bothUnresolved`, i.e. outside the recall denominator by construction. Their
  column is `edgesGained`, never `recall`, and the honest bar for them is the
  phantom rate on 1,978 `agreeExternal` rows exposed to a flip — nine times
  increment 1's netbox exposure.

**The ordering rule.** E4.1–E4.6 are re-ordered by measured `missed` count
descending, with two overrides that are stated now so they are not argued later:
a family whose rows are all outside the recall denominator never outranks one
with recall mass, however large its edge count; and a family whose fix is a
relocation of existing Ruby machinery (E4.1's narrowers) may be pulled forward
regardless of rank, because its cost is bounded by a parity gate rather than by
design. The resulting table is written into this document's decision record with
its counts, and THAT table — not this list's order — is the execution order.

---

## E4.1 — dispatch fan-out

Python has one dispatch component (`ConeDispatchResolver`, passed bare) where
Ruby has four composed through `resolveDispatchViaComponents`
(`ruby-resolver.ts:143` — `[table, union, cone, dynamic]`). Two moves, in this
order.

**The relocation.** Ruby's narrowing cascade already lives in the kernel
(`kernel/dispatch-narrowing.ts`: `ArityNarrower`, `KwargNarrower`,
`VisibilityNarrower`, `BlockNarrower`, `LiteralReceiverNarrower`,
`DuckVocabularyNarrower`, `resolveNarrowedFanout`), but the composition that
uses them is Ruby-private in
`ruby/resolver/strategies/ruby-dynamic-dispatch.ts`, alongside
`classifyRubyLiteralReceiver` and `rubyDynamicFanoutSuppressed`
(`ruby-dynamic-fanout-gates.ts`). What relocates is the COMPOSITION —
`buildDispatchCascade(opts) → DispatchCandidateNarrower[]` plus the shared
terminal — and Ruby keeps its literal map, its duck vocabulary and its
suppression gates as injected language data behind a thin adapter.
Byte-identical relocation protocol, the two Ruby risk files untouched, and the
gate is the standing triple: Ruby suite green with no test edits,
`codegraph-chain-tally --lang ruby` byte-identical on mastodon AND taxdome,
`ruby-resolver-parity` mismatches 0.

**The Python side.** `PythonCallResolver.resolveDispatch` stops being
`this.cone.resolveDispatch` and becomes
`resolveDispatchViaComponents([union, cone, dynamic], call, ctx)`, matching
Ruby's precedence for the same reason Ruby has it: a union receiver NAMES its
possible types, CHA only knows descendants, so stronger evidence goes first.
Python's `union` component reads PEP 604 `A | B` and `Optional[T]` off the
annotation facet's `TypeRef` — the `union` form already exists in the neutral
contract and `python-receiver-type-ports.ts` already declines it on purpose ("a
`container` or `union` receiver yields nothing"), so this is turning a
deliberate decline into a fan rather than inventing a channel. Python's
`dynamic` component is the narrowed short-name fan for an untyped receiver,
which is what polar's 391 bare-name `dynamic` misses are. **Protocol receivers**
fan to in-project implementors: structural, so the candidate set is "classes
declaring every member of the protocol", capped by the same policy.

Confidence, cap and visibility are NOT re-decided here: fan edges carry
`discount / m` as `resolveNarrowedFanout` already assigns, the cap is
`dispatchFanoutPolicyFor` (`max(16, ceil(p99))`), over-cap is `ambiguous` with
no edges and no fallback, and fan edges stay navigation-hidden exactly as Ruby's
are. The measurement is E4.0 B's fan columns; the 1:1 bar must not move.

## E4.2 — transparent wrappers, SQLAlchemy, pydantic

The two arms E3 deferred, beads `w205u.1` (dependency manifest) and `w205u.2`
(vocabulary arms), plus the wrapper family. `w205u.1` ships with **nested
manifests** this time, because root-only reading was measured useless on the one
corpus that needs it: polar declares its stack in `server/pyproject.toml` and
`sdk/python/pyproject.toml` and has no root manifest at all. The gate reads the
nearest manifest at or above a file's directory, memoised per directory, and
falls back to per-file imports when there is none — the fallback is not a
degradation to apologise for, it is what E3 already runs on.

`transparentWrapper` is the cheap half and is language-level rather than
framework-level: `Mapped[T]`, `Annotated[T, …]`, `ClassVar[T]`, `Final[T]`,
`Required[T]` / `NotRequired[T]` all mean "the value is a T" for the purpose of
typing a receiver, and the annotation facet currently sees a subscript it does
not unwrap. One unwrap rule in the type-fact reader, applied before the
`container` / `union` classification, keyed on a frozen name set. SQLAlchemy's
`Mapped[T]` falls out of it for free, which is why the wrapper and the
vocabulary ship together: whatever remains after unwrapping is genuinely
framework knowledge (`select(X)` returning a `Select` bound to `X`, `session`
methods returning project entities), and THAT goes in the vocabulary arm behind
the manifest gate with a remove clause, as E3's Task 3 was written.

The bar for this increment is `edgesGained` and phantom exposure, not recall — 0
`missed` rows, measured. 1,978 polar `agreeExternal` rows are exposed to a flip,
so the A/B checks that column explicitly per corpus and any conversion of
`agreeExternal` into a project edge fails the increment.

## E4.3 — DRF, Celery, pytest fixtures, Django `path()`

Framework vocabularies in the `defineFrameworkVocabulary` shape E3 established,
ordered among themselves by E4.0 D's counts. DRF's `self.get_serializer()` /
`self.request.user` are attribute-type facts on a view class the manifest gate
identifies; Celery's `.delay` / `.apply_async` are the Python analogue of Ruby's
enqueue verb map — the receiver is the task function and the edge target is its
body; `path("…", views.X)` is a string-addressed registry, the same seam as
Ruby's route-to-controller resolution; pytest fixtures are a parameter-name →
`@pytest.fixture` def binding that only exists when tests are walked, which is
why E4.0 D measures it twice. Nothing here ships without its own A/B and its own
remove clause, and `pytestFixture` additionally requires a decision on whether
production should walk tests at all — that decision belongs to the tests-tier
bead, not to this epic; E4.3 measures the family and states the cost.

## E4.4 — TypeVar substitution and Protocol structural dispatch

`def f(x: T) -> T` with a `TypeVar` bound: the return type is the ARGUMENT's
type, so it is a substitution at the call site rather than a fact in the store.
The seam is `ReceiverTypePorts.returnTypeOf` — it answers from
`structuredReturnTypes` today, and it grows an arm that, when the recorded
return is a type variable, resolves it against the call's own argument types.
`-> Self` is the degenerate and most common case, already exercised by polar's
`RepositoryBase.from_session`. The Protocol half is E4.1's fan made precise:
where a structural match is UNIQUE in-project, it is a 1:1 edge rather than a
fan of one.

## E4.5 — async forms

`(await x).m()`, `async for item in agen`, `asyncio.gather(a(), b())`. The
walker records the awaited expression rather than the `await` node, so the
existing call-result and iteration channels can fold it; `gather` is a container
whose elements are the awaited callees' returns, which is the first place a
container element type is actually needed. Sized by E4.0 D before it is designed
further — polar and httpx are the corpora that carry it, and neither has yet had
its async rows counted separately.

## E4.6 — same-file `Cls#m` and constructor-result chain heads

Three small, measured, independent shapes. `globalShortName` grew a same-file
arm in seam 5; polar's remaining 103 `bareCall` misses are
`prompt_setup`-decorated CLI commands in the caller's own file, which says the
arm's gate is narrower than the shape. `constructorChainHead` is
`Model(...).save()` — netbox's 4 of 7 remaining `chain` misses — where the chain
head is a constructor result the fold already knows how to type but is not asked
to. `untypedFieldHop` is polar's 71 dotted receivers whose field has no type
fact from any source; it is the residual that will still be there after
everything else, and it is named so that it is not mistaken for a defect in the
fold.

**Superseded by the plan, which measured the sub-shapes this sketch guessed
at:** `docs/superpowers/plans/2026-09-10-python-e4-6-typed-residuals.md`. Four
tasks shipped — E4.6a (module aliases), E4.6b-1 (chain heads that are calls,
constructors and casts), E4.6b-2 (bare calls in LEGB order), E4.6c (untyped
field hops) — and what each one actually landed is D11 below. Two corrections
this section's numbers depend on:

- **`moduleAliasMember` is 325 rows, not the 317 D8 published.** The E4.0.4
  report run passed `--corpus-root …/tea-rags-bench/corpora/<c>` for all five
  corpora, but flask lives at `~/Dev/OpenSource/codegraph-test/flask` and ugnest
  at `~/Dev/Collaborate/ugnest` (`scripts/lib/codegraph-corpora.json`). For
  those two every tier-2 source read missed. Re-tagged against the real roots,
  flask re-splits `moduleAliasMember` 0 → **8**, `untypedNameReceiver` 22 → 13,
  `pytestFixture` 0 → 1; ugnest is unchanged. Every other E4.6 family count
  reproduces exactly. A wrong root does not fail — it silently turns every
  tier-2 read into a miss, which is how D8 shipped flask's numbers wrong.
- **The shapes are not the ones named here.** `constructorChainHead` is not
  `Model(...).save()` needing a fold it already has; it is `propagateChain`
  splitting a receiver on every `.`, including the ones inside an argument list.
  `untypedFieldHop` is not one residual — 36 of its 111 rows are SQLAlchemy
  `Mapped[T]` and belong to E4.2, 48 to E4.6c, 27 to nothing. The plan's
  decision 1 carries the full sub-shape attribution.

---

## Interaction with `4vg1i` / `8qyax` — the merge that landed on main today

`78e6c40b2` merged two changes that touch ground E4 stands on. Neither
conflicts, and both change what E4 may claim.

### Persisted return-type channels (`8qyax`, commit `83a60aa22`)

`CodegraphPass1FileAggregates` gained `structuredReturnTypes` (keyed
`"<fqClass>#method"`) and `functionReturnTypes` (keyed by bare function name);
`buildPass1Aggregates` writes them when non-empty, and `CodegraphRunState`
hydrates them in `absorb` under the same **batch-wins** guard as the ancestry
channels — a key the current run walked outranks the persisted one — followed by
`markContributed`, without which pass 2 falls back per-file and reinstates the
batch-scoped behaviour being repaired. Measured on taxdome: an incremental run
lost 168 edges, of which these two recover 131 (`structuredReturnTypes` 111,
`functionReturnTypes` 20, additive); every other type-inference family recovers
exactly zero and stays batch-scoped. The failure they fix is a PRECISION one —
`repo.fetch.render` degraded from a pinned edge to a cone carrying a phantom.

What this means for E4, in three parts:

1. **The oracle is unaffected and must stay that way.** The harness builds ONE
   in-memory symbol table from a full walk and assembles `structuredReturnTypes`
   / `functionReturnTypes` itself (`py-codegraph-jedi-oracle.ts:180`), so it has
   never had the incremental gap. Every E4.0 number is a full-walk number. The
   correct reading is that the LIVE incremental path has moved TOWARD the
   oracle, not that the oracle changed.
2. **Python's chain-type strategy is the direct beneficiary.** `chainType` is
   the only reader of `structuredReturnTypes` (`python/CLAUDE.md`), and seam 5's
   R1b fold — a local bound to a cross-file call result — resolves through it.
   Before `8qyax` that fold was correct on a full run and silently weaker on an
   incremental one. E4.4's TypeVar arm and E4.6's constructor-chain-head arm
   both read the same channel, so they inherit the repair rather than needing
   their own.
3. **E4.2 grows the persisted slice and must say so.** Every wrapper unwrap and
   every vocabulary arm that publishes a return fact adds entries to
   `structuredReturnTypes`, which is now written to the pass-1 slice. The slice
   is a JSON blob in one column and needs no migration, but the size claim in
   `8qyax`'s docblock (6,518 entries on taxdome, against 11,099 ancestry keys)
   is the baseline an E4.2 executor re-measures on netbox and polar before
   claiming the cost is free.

`callResultBindings` — the chunk-level channel seam 5 added — is NOT persisted
and is not affected: it is per-chunk walker output, rebuilt whenever the file is
walked, and the resolver folds it against the run-global return maps at resolve
time. The two are complementary, and only the second half was ever at risk.

### Entry-narrowing counter gate (`4vg1i`, commit `2c321ba26`)

`landedOnSharedTemplate` now takes `receiverKind` and returns `false` for
anything but `constant` (`resolution-runner.ts:397`), and the per-kind count
surfaces on `CodegraphResolveKindRow.callsUnnarrowedTemplate`, rendered by
`prime` as a `· N unnarrowed` suffix. On taxdome the headline dropped 2,507 →
1,858; the 649 removed rows were non-constant receivers that never had a target
to narrow to.

Three consequences for E4:

1. **It is not a fan metric and must not be used as one.** The registries it
   reads (`selfDispatchTemplates`, `selfInstantiatingClassMethods`) are
   Ruby-only and empty for Python, and the counter is now additionally gated to
   `constant`. Python reads 0 in every bucket, before and after E4.1. Fan
   quality is measured by E4.0 B's `recallAtFan` / `precisionProxy`, full stop.
2. **It hands E4 a free live-validation assertion.** Every Python bucket's
   `· N unnarrowed` count must read 0 in `prime` after an E4 live run. A
   non-zero there would mean the gate broke or that Python started filling a
   Ruby-only registry — either way a defect, and it costs nothing to check.
3. **`ambiguousFanout` is the column E4.1 actually moves.** It is already on
   `CodegraphResolveKindRow` per kind (`f2jsb` / `j0pki`), it counts over-cap
   dispatch decisions, and it currently reads 0 for Python because the cone
   never returns `ambiguous` (bounded by design — it collapses to `poly-base`
   instead). Adding a `dynamic` component makes it live. E4.1's live gate reads
   it per kind and compares against E4.0 B's `ambiguousShare` from the offline
   run; a large divergence means the corpus-adaptive cap saw a different p99
   live than offline, which is a real thing that can happen when the symbol
   table is hydrated rather than freshly built.

---

## Standing constraints

Verbatim from the program, restated here so an executor needs one document.

- **Precision bar unchanged.** Confidence-1 edges: fabricated + `wrongFile` ≤ 2
  % of edges, ugnest phantom 0, and at most +0.5 pp of phantom per increment.
  flask's inherited 2.82 % is recorded, not spent.
- **Gross `lost` 0 at every step**, per corpus, measured by the row-level diff —
  not net, not "no regression on the headline".
- **Perf per increment**: chain-tally wall ≤ +25 %, peak RSS ≤ +20 %, measured
  interleaved B/A/A/B with the min of each side. **No per-call filesystem
  probes** — membership questions go to `hasFile` / `hasFilesUnder`.
- **Ruby risk files** (`ruby/resolver/type-propagation.ts`,
  `ruby/walker/type-sources/ast-inference.ts`) are touched only by
  byte-identical relocations, parity 0, no incidental improvements riding along.
- **Existing tests are never rewritten.** Moved, yes. A pin that now has a
  better answer is edited only with a bead comment naming the row and the
  corpus.
- **Execution.** One fresh Opus executor per task, each in its own agent
  worktree, ff-merging `worktree-py-frontier-e4` in Step 0. Tool calls ≤ 8 min,
  writes ≤ 120 lines. Commits `type(scope): subject (bead)`, body ≤ 100 columns,
  trailers `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01FNCoxgrknsrkLSDjn1p5Mm`.
  Walker / capability version bumps per
  `.claude/rules/language-capability-sync.md`. Live validation is user-gated.
  Never push.

---

## Decision record

### D1 — measurement before capability, and E4.0 is not skippable

Two of the four E4.0 parts (fan scoring, family attribution) are PRECONDITIONS
for E4.1 rather than reporting niceties: a fan-out family shipped against a
harness that never calls `resolveDispatch` cannot be gated at all. The other two
(second oracle, disagreement audit) bound the honesty of every claim E4 makes.
So E4.0 ships whole, first, and its report is the input to the ordering.

### D2 — the second oracle repairs a denominator, it does not replace jedi

jedi carries five corpora of published numbers and a hand-audited blind-spot
model (`applySuperMroBlindSpot`, `oracleNonCallable`). Replacing it wholesale
would invalidate every one of those numbers to fix a 25 %-of-one-corpus problem.
Per-FILE fallback keeps the published population byte-identical and adds a
disjoint one. The report carries `recallLegacy` alongside `recallMerged`
permanently, not as a migration aid.

### D3 — 1:1 and fan are separate products with separate bars

Stated in E4.0 B and repeated here because it is the decision most likely to be
eroded under pressure to show a bigger number: the headline recall for a corpus
is the confidence-1 recall. `recallAtFan` is reported beside it, never added to
it, and `precisionProxy` is the fan's own quality bar. The failure mode this
prevents has a measured precedent — 1.5 M noise edges on taxdome (`f2jsb`).

### D4 — `ambiguous` counts as a recall miss in the fan denominator

An over-cap decision that discarded the right answer is a cost of the cap. It is
counted so the cap can be tuned on evidence, and it is excluded from `fanSize*`
/ `precisionProxy` because there is no fan to size.

### D5 — pytest fixtures are measured with tests walked, and shipped separately

Walking tests changes the corpus, and every other number in the report is on the
standard exclusion. So the family gets its own paired run and its own delta
column, and the question of whether production should walk tests stays with the
tests-tier bead.

### D6 — the spike's deliverable is this decision record, not code

E4.0.1 writes throwaway scripts under `scripts/spikes/` and they are NOT kept.
What ships out of it is a filled-in decision below, naming the engine, the
measured numbers behind the choice, and the third outcome if it applies.

### D7 — second-oracle choice: **pyright** (measured 2026-09-10, `52163fa2e`)

Chosen: **pyright**. On polar's parso-degraded files — 102 of 107 inside the
production walk, 12,494 sites / 12,491 distinct keys, 22.0 % of the walk's
56,710 — pyright answers 10,964/12,491 (87.8 %): 4,717 in-project (37.8 %, 4,616
symbol-pinned) and 6,247 external. Determinism **byte-identical over two runs,
different 0**; **2.2 s per 1k sites**; peak server RSS 1,967 MB. Agreement with
jedi on the 500-site both-parse sample (seed 20260910): **132/132 = 100.0 %**
where both answer in-project, 85.4 % on origin over all 500, 0 disagreements.

Rejected **ty 0.0.80** on one measured reason: 28 of those 500 rows where jedi
answers in-project read `sitePackages` under ty, every one under
`sdk/python/polar/**` — polar's in-repo SDK resolved to the installed
`polar_sdk`, the duplicate-package trap `order_roots` / `build_sys_path` exist
for (`vua9f`, `7dsyq`: 1,610 rows scored phantom). pyright's count is 1, and
that one is the probe's column heuristic. Everything else favoured ty and none
of it was decisive: 0.7 s per 1k, 412 MB, byte-identical, the same 4,717
in-project answers (49 more symbol-pinned), 104/105 = 99.0 % agreement.

The five opened disagreements: (1) `server/scripts/loadtest_setup.py:214`
`run()` — jedi `setup#run`, pyright typeshed `asyncio.run`; **probe-wrong**, the
client takes the first `run(` on the line and the row is the bare inner call, so
E4.0.2 must carry a column. (2) `sdk/python/polar/v2026_04/client.py:60`
`resolve_base_url()` and (3) `…/services/benefits.py:304` `send_request()` —
jedi in-repo, ty `sitePackages`; **ty-wrong**, the shadow above, on the very
file `vua9f` measured. (4) `dev/cli/cli.py:90` `check_env_file_exists()` — jedi
`dev/cli/shared.py#…`, ty `dev/cli/cli.py:41`, the `from … import (` binding;
**ty-wrong**, it stops at the binding where pyright takes the second hop. (5)
`server/polar/backoffice/external_events/endpoints.py:193` `get_by_id()` on a
`Repository.from_session(...)` receiver — jedi `unknown`, both engines
`kit/repository/base.py#RepositoryIDMixin#get_by_id`; **jedi-wrong**, 11 rows of
the sample carry it, and it is the class a second oracle adds.

Versions: pyright 1.1.414
(`npx --yes --package pyright@1.1.414 pyright-langserver --stdio`), ty 0.0.80
`7fd8e1569` (`uvx ty@0.0.80 server`), node v24.14.1, jedi 0.20.0 / parso 0.8.7
on CPython 3.14.0rc2 — both engines cache-local and pinned, neither installed
globally. E4.0.2 must reproduce pyright's per-corpus config: `python.pythonPath`
at the corpus venv, `python.analysis.pythonVersion` at the manifest's
`oraclePython`, `python.analysis.extraPaths` at its declared roots,
`VIRTUAL_ENV` in the child env — and answer `workspace/configuration` PER ITEM,
since a one-element reply leaves the server on defaults and drove `unknown` from
8.6 % to 50.4 %.

### D8 — family attribution table (measured 2026-09-10, `181284b9e`)

Five corpora, `--oracle merged --dispatch`, every residual row
(`missed | fileOnly | wrongFile`) attributed to exactly one family by
`scripts/lib/py-residual-families.ts`. `other` is **0 on every corpus**. Full
tables, the receiverKind splits and the E3 cross-check are in the plan's E4.0.4
measurement record.

**THIS TABLE IS THE EXECUTION ORDER.** The scope order above is superseded.

| #   | increment                            | families and their measured mass                                                                                     | rows         | why here                                                                                                                                                                                                                                                                            |
| --- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **E4.1** dispatch fan-out            | `untypedNameReceiver` 432, `unionBranchReceiver` 18, `protocolReceiver` 0                                            | **450**      | Largest recall mass by 133 rows AND the relocation override: the narrowers already exist in the kernel, so cost is bounded by a parity gate rather than by design. Both overrides point the same way.                                                                               |
| 2   | **E4.6a** module-alias member        | `moduleAliasMember` 317                                                                                              | **317**      | Second-largest single family and the cheapest shape in the set — `from pkg import submodule` where the submodule is a private module the package re-exports (polar `_datatable` as `datatable`, netbox `layout`). One import-mapper arm, no framework knowledge.                    |
| 3   | **E4.6b** bare calls and chain heads | `sameFileBareCall` 140, `constructorChainHead` 44, `callResultChainHead` 35, `crossFileBareCall` 31                  | **250**      | Four independent shapes on one seam (`globalShortName`'s gate and the call-result fold). `crossFileBareCall` is new: 31 rows the same-file arm cannot reach.                                                                                                                        |
| 4   | **E4.6c** untyped field hop          | `untypedFieldHop` 111                                                                                                | **111**      | The named residual. Kept last inside E4.6 because it is what remains after the other three, exactly as the spec predicted.                                                                                                                                                          |
| 5   | **E4.4** class-object and MRO        | `classObjectReceiver` 83, `superMro` 23, `typeVarGeneric` 0                                                          | **106**      | `cls(...)` / `Cls.method()` on an inherited member, plus the `super()` rows the chain resolves to the wrong base. `typeVarGeneric` measured 0 — the `-> Self` arm has no residual mass on these corpora and folds into this increment rather than earning its own.                  |
| 6   | **E4.5** async and container forms   | `containerElementHop` 4, `asyncForm` 0                                                                               | **4**        | Below the 30-row bar. NOT an increment: fold `containerElementHop` into E4.6b's call-result fold and drop `asyncForm` until a corpus produces rows.                                                                                                                                 |
| 7   | **E4.2** wrappers and vocabularies   | `transparentWrapper` 9 recall + 68 edges; `sqlalchemyRow` 0 recall / 2,872 edges; `pydanticRow` 0 recall / 223 edges | **9 recall** | The no-recall-mass override: 3,095 edge rows never outrank 450 recall rows, however large. Ships on `edgesGained` + the phantom-exposure bar, after every recall increment.                                                                                                         |
| 8   | **E4.3** framework vocabularies      | `drfViewAttr` 0, `celeryEnqueue` 0, `djangoUrlRoute` 0, `pytestFixture` 4                                            | **4**        | Every arm measured 0 on these corpora and `pytestFixture` is 4 rows with tests walked. **Not worth an executor.** Fold what survives into E4.2's vocabulary arm and re-measure on a corpus that carries DRF or Celery — netbox is Django without DRF-heavy views, polar is FastAPI. |
| —   | **OUT**                              | `runtimeOnly` 0 (2 with netbox's tests walked)                                                                       | 0            | Declared out of scope and measured at zero, which is the finding: computed `getattr` / metaclass dispatch is not a Python recall problem on these corpora.                                                                                                                          |

**Below the bar.** Three increments fall under the 30-row threshold and are
folded rather than scheduled: E4.5 (4 rows), E4.3 (4 rows), and E4.4's
`typeVarGeneric` arm (0 rows). That removes two whole executors from the program
and moves their mass into E4.6b and E4.2.

**Row 5 is DELIVERED too, measured in D12 (2026-09-11).** `classObjectReceiver`
closed **83 → 39** and `superMro` **23 → 1**, against the 44 addressable rows
the E4.4 plan claimed and the 106 this table published. The gap is not a
shortfall: 32 of the 83 are `cls(...)` constructor calls that D12 records as
oracle debt, 8 are folded with counts, and the rest landed. Nothing in row 5 was
left for a later increment except the one `superMro` survivor, which is
annotation debt rather than an MRO question.

**Rows 2–4 are DELIVERED, measured in D11 (2026-09-11).** `moduleAliasMember`
reads 309 addressable against the 317 this table published — the real count is
325 and 16 of them are classifier false positives — and it closed **309 → 1**.
Row 3 split into E4.6b-1 (chain heads: `constructorChainHead` 44 → **0**,
`callResultChainHead` 35 → 23) and E4.6b-2 (bare calls 131 → 93);
`crossFileBareCall` was folded rather than planned, at 4 addressable rows. Row 4
closed `untypedFieldHop` 110 → **54**, having first routed 36 of its 111 rows to
E4.2 as `Mapped[T]` unwraps and declined 27. Whole-increment delivery is **624
rows bad → good** against the plan's 519, with gross lost adjusted 0 on every
corpus. Rows 1 (E4.1), 5 (E4.4) and 7 (E4.2) still stand as written; E4.1's
`untypedNameReceiver` mass fell 432 → 280 as a side effect of E4.6b-1's `Self`
substitution, so re-measure before scheduling it.

**What the table changes about the spec's own order.** E4.6, written as the
"three small, measured, independent shapes" increment, carries 678 rows — more
than half the residual and more than E4.1. It splits into three scheduled
increments. E4.2 and E4.3, written second and third, drop to last and to
"folded". Nothing about E4.1 moves.

### D9 — the oracle-disagreement audit: two new blind spots, and flask stands

100 rows, seed 20260910, stratified over `phantom ∪ wrongFile` (207 rows) with
flask taken as a full census. pyright answered every sampled site as tiebreaker.
Classes and per-corpus counts are in the plan's E4.0.4 record; the three results
this decision records are:

1. **flask's 2.82 % is real fabrication, not an instrument reading.** All 11 of
   its rows are `chainWrong`; nine are `open(path, mode)` resolved by
   `globalShortName` to `FlaskClient#open`. `precisionMissAdjusted` = the raw
   rate. E4 owns the bar.
2. **netbox and httpx are almost entirely instrument.** Adjusted 0.31 % → 0.03 %
   and 1.63 % → 0.00 %. polar 0.97 % → 0.68 % [0.57–0.77].
3. **Two blind spots neither `applySuperMroBlindSpot` nor `oracleNonCallable`
   covers**, found by reading: jedi answers nothing for a `@classmethod` on a
   `StrEnum` / `IntEnum` subclass (18 rows), and it resolves polar's in-repo SDK
   to the installed distribution through `server/polar/__init__.py`'s
   `extend_path` (8 rows) — the same duplicate-package trap D7 rejected ty for,
   on the other engine. `oracleWrongCache`, `oracleWrongSingleton`, `bothWrong`
   and `undecidable` drew **zero** rows.

A fourth result is a defect the audit found rather than a rate: **the chain
fabricates edges ACROSS languages.** polar's `range(...)` resolves to a
TypeScript `Paginator.tsx#range` and `GitHub()` to `Icons.tsx#GitHub`, through
`globalShortName` and `importedName`. The harness builds one symbol table over
every `CODEGRAPH_LANGUAGES` extension on purpose, and neither strategy checks
the candidate's language. Tracked as its own bead; it is not an E4 family.

**Fixed by E4.0.5 (`08b8d5f12`, bd tea-rags-mcp-w205u.8)** — the cross-language
defect and result 1's `FlaskClient#open` family turned out to be one seam, and
one commit closes both. Short-name candidates are now gated to same-language,
bare-callable, non-builtin definitions. Measured against the merged oracle on
all five corpora, `phantom + wrongFile` fell 207 → 121: flask 11 → 1
(precision-miss 3.21 % → 0.30 %), polar 161 → 86 (1.00 % → 0.54 %), netbox 27 →
26, httpx and ugnest unchanged. Zero correct rows lost anywhere.

The sample list, per corpus, class abbreviated `CW` = `chainWrong`, `OW:*` = the
oracle-wrong classes:

- **flask (11, all CW):** `examples/tutorial/flaskr/auth.py:27`,
  `src/flask/app.py:443,445,465,467`, `src/flask/blueprints.py:126,128`,
  `src/flask/cli.py:1022`, `src/flask/config.py:208,293`,
  `src/flask/sansio/scaffold.py:46`.
- **httpx (4, all OW:EnumClassmethod):** `httpx/_main.py:137`,
  `httpx/_models.py:748,755,769`.
- **netbox (12):** OW:Mro — `dcim/api/serializers_/devices.py:223`,
  `dcim/models/cables.py:278,347,356,382`, `dcim/models/devices.py:1248,1338`,
  `ipam/models/asns.py:59`, `ipam/models/vlans.py:113,318`,
  `tenancy/models/tenants.py:54`; CW — `utilities/filters.py:42`.
- **polar (73):** 51 CW, 14 OW:EnumClassmethod, 8 OW:ShadowedPackage. The full
  list is `audit-sample-list.txt` under the E4.0.4 dumps.

**A THIRD oracle-wrong class, found by E4.6b-1 (2026-09-11, bd
tea-rags-mcp-w205u.16): `oracleWrongSelf`, abbreviated `OW:Self`.** jedi
resolves the result of a `-> Self` classmethod to the class that DECLARED it
rather than to the receiver's class, so every member the subclass overrides
scores against the base. It is the same mistake the walker's own pre-E4.6b-1
`Self` handling made, which is why these rows read `match` while the chain was
also wrong — the two errors agreed. pyright and the runtime both say the
receiver class.

14 polar rows, all `repository = CustomerRepository.from_session(session)` then
`repository.update(…)` / `.create(…)`. `kit/repository/base.py:165` is
`def from_session(cls, session) -> Self: return cls(session)`, and
`customer/repository.py` OVERRIDES `create` (line 71) and `update` (line 98).
pyright answered `CustomerRepository#update@98` / `#create@71` on **14 of 14**,
byte-identical to the chain's new target; run with `lsp_oracle.ts` driven
directly on those sites, dumps under `~/.claude/jobs/dffe3647/tmp/e46b1/`.

- **polar (14, all OW:Self):** `backoffice/customers/endpoints.py:910`,
  `checkout/service.py:3042`, `customer/service.py:399,614,656,744`,
  `customer_email_update/service.py:157`,
  `customer_portal/endpoints/oauth_accounts.py:292`,
  `customer_portal/service/customer.py:205,288,430,459`,
  `customer_portal/service/customer_session.py:265`,
  `customer_seat/service.py:852`.

These 14 moved `match → wrongFile` when E4.6b-1 landed, and they are the WHOLE
of that task's gross-lost column. They are an instrument reading, not a
regression: E4.6-close subtracts them exactly as D9's other `OW:*` classes are
subtracted from `precisionMissAdjusted`.

**A FOURTH class, found by E4.4a (2026-09-11, bd tea-rags-mcp-w205u):
`oracleEnumClsMember`, abbreviated `OW:EnumCls`.** It is result 3's enum blind
spot reached through a different receiver, and it is worth its own name because
the two fail for different reasons: `OW:EnumClassmethod` is jedi answering
nothing for `codes.is_redirect()` on the CLASS, while this one is jedi typing
`cls` on an enum subclass through `enum.pyi` and never reaching the project at
all — every row carries `origin: typeshedStub`. Five polar rows, all
`cls.<x>_statuses()` inside `class SubscriptionStatus(StrEnum)` in
`server/polar/models/subscription.py`, all answered by the chain with the
`SubscriptionStatus.<x>_statuses` declared twenty lines above the call. They
moved `agreeExternal → phantom` when `clsMember` landed, which is why polar's
phantom count rises while its precision does not: +0.03 pp against a +0.5 pp
cap.

**The oracle debt this decision records is RETIRED, by a tiebreak stage rather
than by another audit (2026-09-11, E5.0d, bd tea-rags-mcp-1v12o.1.4).** Every
row where the chain and jedi disagree now goes to pyright on every run, and a
fixed rule re-scores it into a THIRD denominator beside `legacy` and `merged`.
`OW:Mro`, `OW:EnumClassmethod`, `OW:ShadowedPackage`, `OW:Self`, `OW:Mapped` and
E4.4a's `oracleEnumClsMember` stop being paragraphs a later increment has to
remember to subtract: the harness measures them. The `cls(...)` rows are
withheld as `oracleSelfReference`, and a row pyright cannot decide is withheld
as `undecidable` rather than scored either way.

The classes reproduce. Precision miss falls **1.603 % → 0.000 %** on httpx
(against D9 result 2's hand-adjusted 1.63 % → 0.00 %) and **0.298 % → 0.011 %**
on netbox (against 0.31 % → 0.03 %), where 25 of 26 phantoms are the `super`/MRO
rows this decision lists. **flask does not move — 0.287 % under all three
denominators — which is result 1 holding under an automatic rule**: its rows are
real fabrication, pyright backs jedi on every one of them (`agreesWithChain` 0
of 33), and the same is true of the 63 `chainWrong` rows E4.0.4 attributed
across the corpora. `third` is 0 everywhere: where pyright answers, it names one
of the two targets already on the table. Counts, per-corpus tables and the
byte-identity gate are in the E5.0 plan's Task E5.0d block.

### D10 — dynamic `single` falsified (measured 2026-09-10, E4.1.3)

A name-only fan is **not precision-safe for Python**. Built, wired and measured
on all five corpora (`--oracle merged --workers 8`), the `dynamic` component
books **+83 new 1:1 matches against +85 new fabricated edges** — flask +6/+6,
netbox +5/+5, polar +72/+72, httpx 0/+2, ugnest 0/0 — with gross `lost` 0 and
`recall@fan` **0.344 on polar (n=122)** and 0.364 on netbox (n=11) against the
0.85 bar. Both E4.1.3 stop rules therefore fired, and the component now ships
**parked behind `CODEGRAPH_PY_DYNAMIC_DISPATCH`, default OFF**: with the flag
absent `resolveDispatch` composes the cone alone and every column is the
pre-E4.1.3 one, byte for byte.

**Why the estimate was wrong, and it was not a rounding error.** D8's
attribution predicted 232 `single` (1 wrong) at fan recall 0.980. It was
computed over the 373 residual rows E4.0.4 attributed to `untypedNameReceiver` —
every one of which HAS an in-project oracle target. **The component does not
fire on that set.** It fires on every bare untyped name the chain declines, ~5×
as many sites (polar 929 dispatch-answered against 330 attributed), and the
surplus is receivers whose real type is a LIBRARY type that happens to share a
member name with exactly one project class. Selection bias, not variance: the
denominator excluded precisely the population that produces the false positives.

**What a re-attempt needs**, in the order it buys the most:

1. **Receiver-type evidence, not member names.** A file-scope binding view — a
   module-level `log = structlog.get_logger()` is 31 of polar's 72 phantoms and
   is invisible because `callResultBindings` reach the resolver per CHUNK, so a
   method's context cannot see its own module's bindings. Then E4.6b's
   return-type fold for the in-project call results, and a binding for
   `except … as e` (8 more polar rows).
2. **A real decline vocabulary.** `PYTHON_CORE_MEMBERS` is 36 names and is far
   too small to carry this: `aggregate`, `title`, `natural_key`, `get_source`,
   `list_templates`, `errors`, `label`, `submit`, `stream` are all Django, `str`
   or Jinja members with a coincidental project owner. A typeshed/stdlib +
   framework MEMBER set, used as a decline set, is the shape that scales; four
   ad-hoc gates (builtin-named receiver, `_SCREAMING_SNAKE` constant,
   foreign-headed call binding, `self.<member>` no file declares) took ugnest
   from 4 phantoms to 0 and did nothing for the other four corpora.
3. Only then re-flip the flag and re-run the same A/B. Demoting `single` to
   `discount / 1` is NOT the fix: the harness splits by edge COUNT, so a demoted
   single still persists a 1:1 edge and still reads `phantom`.

**`union` (E4.1.4) is deferred**, below the 30-row bar: 18 rows, all polar, is
not worth a walker change that lifts the annotation facet's union drop and the
three declines that change guards. It is recorded here and left unscheduled.

### D11 — E4.6 measured (2026-09-11, `w205u`, whole increment against `3a3283e1d`)

Four tasks shipped and were measured end to end, five corpora × five runs each
side, `--oracle merged --dispatch --workers 8 --samples 500000`, B from a
detached checkout of the E4.6 base. **Zero unstable rows on any corpus on either
side**, so the transition matrix is exact. Full tables, the per-family report
and the perf pair are in the plan's "Measured — E4.6 (whole increment)" block.

| corpus | match           | missed    | fileOnly | wrongFile | phantom | edges           | recallMerged        | gross lost |
| ------ | --------------- | --------- | -------- | --------- | ------- | --------------- | ------------------- | ---------- |
| ugnest | 765 → 771       | 24 → 17   | 0 → 0    | 0 → 1     | 0 → 0   | 770 → 777       | 0.9696 → **0.9772** | 0          |
| flask  | 326 → 330       | 40 → 36   | 6 → 6    | 1 → 1     | 0 → 0   | 345 → 349       | 0.8740 → **0.8847** | 0          |
| httpx  | 469 → 477       | 14 → 6    | 5 → 5    | 0 → 0     | 8 → 8   | 491 → 499       | 0.9611 → **0.9775** | 0          |
| netbox | 8,225 → 8,284   | 116 → 57  | 2 → 2    | 0 → 0     | 26 → 26 | 8,642 → 8,695   | 0.9859 → **0.9929** | 0          |
| polar  | 15,859 → 16,372 | 989 → 441 | 34 → 54  | 2 → 17    | 84 → 88 | 16,541 → 17,574 | 0.9393 → **0.9697** | 0 (+18 OW) |

**624 rows moved bad → good** — ugnest +6, flask +4, httpx +8, netbox +59, polar
+547 — against the plan's predicted 519. The mix is not the predicted one: the
38 `fileOnly → match` rows E4.6b-2 expected were a jedi-composer spelling defect
rather than a resolver gap and never moved, while polar's `missed` half
over-delivered (+547 against +429) and 11 `skippedInProject` rows across three
corpora turned out to be answerable.

**Precision held on every corpus.** Phantom rate moved at most −0.026 pp
anywhere — ugnest stays exactly 0, flask stays at 0.000 %, httpx 1.629 → 1.603
%, netbox 0.301 → 0.299 %, polar 0.508 → 0.501 % — so nothing approaches the
+0.5 pp cap and nothing approaches flask's 2 % bar. `exactReplacedByFan`,
`exactReplacedByAmbiguous` and `exactReplacedBySingle` are identical on both
sides of every corpus. `chainDrift` and `dispatchDrift` are 0 on all 50 oracle
runs and all 50 chain-tally runs.

**polar's 18 lost rows are the two `OW:*` classes this decision record already
carries, and they reproduce row for row**: the 14 `OW:Self` rows D9 lists by
`relPath:line`, and 4 `OW:Mapped` rows behind a SQLAlchemy `declared_attr`
returning `Mapped[T]`. pyright answered the chain's target on all 18.
**`precisionMissAdjusted` for polar is 0.489 %, below its own B side, and gross
lost adjusted is 0 on every corpus.** Chain regressions: 0.

**Families closed.** `moduleAliasMember` 309 → 1 (netbox 50 → 0, polar 259 → 1),
`constructorChainHead` 44 → 0 on all three corpora that carried it.
`callResultChainHead` 35 → 23, `untypedFieldHop` 110 → 54, bare calls 131 → 93.
NO family grew on any corpus. Residual across the five corpora, on the three
verdicts the oracle dump samples, 1,194 → 584.

**A production defect the increment fixed, and a second one closing it found.**
`ResolverInputs.classFieldTypesByClassKey` had reached NEITHER `CallContext` the
resolution runner builds since f0xaa — production resolved without an arm both
offline harnesses built, so every oracle number published between f0xaa and
E4.6c was measured against an instrument production did not match. E4.6c
threaded it. E4.6-close then checked the whole channel set and found two more in
the same state on the FILE-EDGE context only, `functionReturnTypes` and
`instantiatedTypes`, inherited from the provider the runner was extracted from.
All twelve channels now flow through one function both sites spread, and a
contract test derives its list from `keyof ResolverInputs` so a new channel
fails the type check until it is mapped and the assertion until it is threaded.
Neither newly-threaded channel has a Python reader, so the A/B above measures
the four tasks and not the threading.

**One instrument limitation this measurement had to work around, recorded
because the next cross-`3a3283e1d` A/B will hit it too.** `oracleTargetRelPath`
landed in E5.0b, after the E4.6 base, so a B-side dump carries no oracle target
and `py-residual-families.ts` classifies every bare call as `crossFileBareCall`
there. The family table folds `sameFileBareCall` + `crossFileBareCall` into one
row rather than reporting a split the B side cannot produce. Separately, the
oracle's `--json` payload samples `missed` / `wrongFile` / `phantom` /
`skippedInProject` and not `fileOnly`, so residual counts derived from a dump
run below the plan's, which counted `fileOnly` too.

### D12 — E4.4 measured (2026-09-11, `w205u`, three tasks against `f5f27197f` and `c0e22b1b4`)

**The sub-shape attribution the plan was built on, re-tagged from E4.0.4's five
`--oracle merged --dispatch` dumps under the CORRECTED corpus roots.** Both E4.4
families are byte-identical to D8 under the correction: `classObjectReceiver`
83, `superMro` 23.

| sub-shape                                                   | `receiverKind` | flask | httpx | netbox |  polar | ugnest |   rows | owner            |
| ----------------------------------------------------------- | -------------- | ----: | ----: | -----: | -----: | -----: | -----: | ---------------- |
| **a** `cls.m()` inside a classmethod                        | `dynamic`      |     0 |     0 | **17** | **16** |  **1** | **34** | E4.4a            |
| **b** `cls(...)` constructor call                           | `bareCall`     |     1 |     0 |      6 |     25 |      0 | **32** | oracle debt (D3) |
| **c1** `Cls.m()`, class SAME FILE, member inherited         | `constant`     |     0 |     0 |      0 | **10** |      0 | **10** | E4.4b            |
| **c2** `Cls.m()` declined as a core member (`values`)       | `constant`     |     0 |     0 |      3 |      0 |      0 |      3 | folded           |
| **c3** `Cls.m()` imported, mapper reads `unknown` (PEP 420) | `constant`     |     0 |     0 |      0 |      0 |      3 |      3 | E4.6a mapper     |
| **c4** SCREAMING_SNAKE module constant holding an INSTANCE  | `constant`     |     0 |     0 |      0 |      1 |      0 |      1 | folded           |
| **e** `type(self).m()` / `self.__class__.m()`               | —              |     0 |     0 |      0 |      0 |      0 |  **0** | —                |
| **total**                                                   |                | **1** | **0** | **26** | **52** |  **4** | **83** |                  |

`superMro`'s 23 split 19 / 3 / 1: nineteen `super().__init__` rows whose base is
spelled through a package module alias, three whose base short name is declared
in two files, and one `self:`-annotated generic mixin with no base at all.

**44 rows were claimed and 44 landed.** E4.4a **+34** (netbox +17, polar +16,
ugnest +1 — the predicted count per corpus exactly), E4.4b **+10** on polar,
E4.4c **+22** on polar (19 alias rows and 3 sibling rows, the predicted count
per shape). `classObjectReceiver` closed **83 → 39** and `superMro` **23 → 1**
across the increment, gross lost **0** on every corpus of every A/B, and
netbox's `super` match held at **248** on every run — D9's `oracleWrongMro` rows
were not chased and did not move.

**32 rows are oracle debt, and the mechanism is worth recording because it will
recur.** Every `cls(...)` constructor row in the set resolves, in BOTH engines,
to the enclosing classmethod: `cls` is a parameter, its definition line is the
`def` line, and the harness attributes that line to the method that owns it.
Until the harness learns to withdraw a non-callable oracle answer — D9's
`oracleNonCallable` class — those rows are unscoreable by construction, and
emitting a constructor edge for them SPENDS precision without buying recall.
Twenty-two more rows went to E4.6a's mapper (19 `super()` alias rows and 3 PEP
420 namespace rows), and 8 were folded with counts.

**Four branches measured ZERO on five corpora, and that is a result.**
`type(self).m()` and `self.__class__.m()` return zero matches across every
residual row on all five corpora, although `CLASS_OBJECT_RECEIVERS` lists them
beside `cls`; two-argument `super()` is likewise absent; and `typeVarGeneric` —
the half of the spec's E4.4 sketch that would have needed TypeVar substitution —
is 0. Four branches removed from every later increment on evidence, which is
worth as much as the rows gained.

**The one survivor and the one channel defect.** `kit/repository/base.py:187` is
`RepositorySoftDeletionMixin`, which has NO base at all — the brackets are a PEP
695 type-param list and the source itself carries `# type: ignore[safe-super]` —
so it is annotation debt for E4.6's fold, not an MRO question, and decision 5's
"Protocol base" filing was wrong. Separately, `classExtends` is keyed by class
SHORT name and unioned run-global, so a namesake in another file overwrites it;
E4.4c guards the ONE hop whose file-qualified key is in hand, and every deeper
hop of the legacy walk, plus every other reader of that map, still trusts a
run-global short-name index.

---

## E4 — the whole increment measured

Five corpora × five runs per side against the **E4 baseline `78e6c40b2`** (=
main when E4 started), both sides driven by the SAME harness — the current
`scripts/` tree against detached source checkouts — so a harness change inside
E4 cannot be read as a capability change. The baseline carries `walker` 4 and no
`resolver/dispatch/` directory at all; the measurement supplies that module as a
no-op shim, which is exactly what the baseline behaves like, and composes
`[cone]` on both sides because `CODEGRAPH_PY_DYNAMIC_DISPATCH` is unset (D10).
Every chain column is byte-identical across the five runs of each side.

| corpus |               match |      phantom |               edges |        recallLegacy |        recallMerged |    precision-miss |
| ------ | ------------------: | -----------: | ------------------: | ------------------: | ------------------: | ----------------: |
| ugnest |       765 → **772** |        0 → 0 |       770 → **778** | 0.9696 → **0.9785** | 0.9696 → **0.9785** |     0.00 → 0.13 % |
| flask  |       332 → **336** |    9 → **0** |           355 → 349 | 0.8901 → **0.9008** | 0.8901 → **0.9008** | 3.10 → **0.29 %** |
| httpx  |       473 → **481** |        8 → 8 |       491 → **499** | 0.9693 → **0.9857** | 0.9693 → **0.9857** |     1.63 → 1.60 % |
| netbox |   8,227 → **8,303** |  26 → **25** |   8,651 → **8,711** | 0.9877 → **0.9949** | 0.9861 → **0.9952** |     0.31 → 0.29 % |
| polar  | 15,861 → **16,430** | 155 → **93** | 16,626 → **17,625** | 0.9550 → **0.9810** | 0.9394 → **0.9731** | 0.97 → **0.62 %** |

**664 rows bad → good** — ugnest +7, flask +4, httpx +8, netbox +76, polar +569
— and the residual across the three verdicts a dump samples falls **1,200 →
521**. **Precision improved on four corpora and held on the fifth.** flask's
3.10 % was the bar breach D9 recorded and it is now **0.29 %**, its nine
`open(path, mode)` phantoms gone; polar 0.97 → 0.62 %, netbox 0.31 → 0.29 %,
httpx 1.63 → 1.60 %. ugnest's 0.00 → 0.13 % is a single `wrongFile` row on a
778-edge denominator. Nothing anywhere approaches the 2 % bar.

**Gross lost is 14 rows, all on polar, all one class already in this record.**
They are D9's `OW:Self` list, row for row — the 14 sites where jedi resolves a
`-> Self` classmethod's result to the DECLARING class and pyright confirms the
chain's answer. Zero rows entered the residual on the other four corpora, and no
lost row belongs to any other class, so **chain regressions across the whole of
E4 are 0** and `precisionMissAdjusted` for polar is below its own baseline.

**Families, baseline → now.** `moduleAliasMember` 309 → 1,
`constructorChainHead` 44 → 0, `untypedFieldHop` 110 → 54, `classObjectReceiver`
83 → 39, `superMro` 23 → 1, bare calls 133 → 93. **No family grew on any
corpus.** What is left is concentrated where D8 said it would be:
`untypedNameReceiver` 280 rows, which is E4.1's parked fan-out, and it is now
more than half of polar's residual.

---

## Risks

- **The second oracle answers a different question than jedi.** A type checker
  reasons about types; `goto definition` on a call is a lookup. Where they
  diverge — a `@property`, a descriptor, an overload set — the merged rows carry
  a different bias from the legacy ones. Mitigation: the 500-site both-parse
  agreement sample in E4.0.1 measures this before the engine ships, and
  `oracleEngine` on every row means any table can be split if it shows up later.
- **LSP nondeterminism.** A server accumulates workspace state. The two-run
  byte-identical gate is the mitigation, and it is a hard gate: an engine that
  fails it does not ship, and the "neither" outcome is admissible.
- **Fan scoring inflates apparent progress.** Mitigated structurally by D3 and
  by `--no-dispatch` reproducing today's columns byte-for-byte as an E4.0.3
  gate.
- **The cap moves under a bigger fan population.** `dispatchFanoutPolicyFor` is
  corpus-adaptive (p99 defs-per-member), so adding a `dynamic` component can
  change the cap on the same corpus, which changes `ambiguousShare` for reasons
  unrelated to the increment. Mitigation: the report prints `p99DefsPerMember`
  and the resolved `cap` per corpus in every run, so a moved cap is visible
  rather than inferred.
- **E4.2's `agreeExternal` exposure.** 1,978 polar rows, nine times E3's netbox
  exposure, all of them one vocabulary decision away from becoming project edges
  that jedi calls phantom. Mitigation: the A/B checks the `agreeExternal` column
  explicitly per corpus, and the increment carries a remove clause.
- **Walking tests changes more than the fixture family.** Test files import
  project code, so the symbol table and every short-name ambiguity computation
  moves. Mitigation: the tests-walked run is a SEPARATE population reported as a
  delta; it never becomes the baseline.

---

## What E4 does NOT claim

- It does not close runtime-only dispatch. Computed `getattr`, `__getattr__`
  proxies, monkeypatching, metaclasses and string dispatch are counted by E4.0 D
  and declared out of scope: they need traces, and this program is static by
  constraint (`m99j1` — production stays LSP-free).
- It does not raise the confidence-1 precision bar or spend it. Every increment
  is measured against fabricated + `wrongFile` ≤ 2 % with a +0.5 pp
  per-increment cap, and flask's inherited 2.82 % is a level E4 reports, not a
  debt E4 pays.
- It does not claim the merged denominator is comparable to the legacy one.
  Numbers on the two populations are printed side by side and never subtracted
  from each other.
- It does not make fan edges navigable. They stay hidden from navigation exactly
  as Ruby's are, and their confidence stays `discount / m`.
- It does not put a type checker in production. Both candidate engines are
  measurement-only, run offline from `scripts/`, and nothing they produce is
  read by the indexer.
- It does not decide whether production should walk test files.
- It does not re-open E3's deferred design. `w205u.1` / `w205u.2` ship as
  written, with nested manifests as the one change, because nothing in them was
  found wrong — only unranked.

---

## Beads and follow-ups

Epic `tea-rags-mcp-w205u` (frontier increment 2) with children: E4.0 measurement
(four tasks, created by the plan), E4.1 dispatch fan-out, E4.2 folding
`w205u.1` + `w205u.2`, E4.3, E4.4, E4.5, E4.6. Open from the program and
unabsorbed here: `f11nz`, `6pd5l`, `zhetx`. The SDK freeze (`z6ry9`) stays last
and gains Frontier E4's components as additional two-consumer evidence.

Plan: `docs/superpowers/plans/2026-09-10-python-e4-0-measurement.md` (E4.0).
E4.1–E4.6 plans are written when E4.0's report fills D7 and D8.
