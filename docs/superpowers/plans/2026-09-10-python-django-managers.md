# Python Django Managers — E3 Increment 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close netbox's `chain` hole, which seam 5 measured and then handed
here whole. After the recall frontier landed, netbox `chain` sits at **0.403
(100/248)** and 141 of the remaining 148 misses are ONE shape:
`<Model>.objects.<projectManagerMethod>()`. The model's `objects` attribute is
assigned in a CLASS BODY — `objects = RestrictedQuerySet.as_manager()` on
`NetBoxModel`, `objects = ObjectTypeManager()` on `ObjectType` — and no channel
in the walker reads a class-body assignment, so the fold stops on hop 1 and the
receiver is untyped. Teaching the walker to read those two assignment shapes,
into the class-key field channel the MRO walk already reads, is the whole recall
lever: 141/141 of the measured gain, all of it landing on the manager class's
OWN methods, none of it needing an inheritance walk past hop 0. The framework
vocabulary that names Django's boundary and its fluent/terminal verbs ships
alongside it, buys **zero oracle-scoreable recall** (measured, table below), and
exists for edge density on the 1,000-plus rows where jedi itself cannot answer —
so it ships behind its own A/B with a remove clause, exactly as seam 5 shipped
`namingConvention`.

**Architecture:** Three layers, one new gate. The **dependency manifest** is the
Python analogue of `WalkContext.gemfileContent`: a raw string read ONCE per run
at the two composition roots that already read the Gemfile
(`CodegraphRunState.loadGemfile`, `IndexingPipelineBase#readGemfile`), threaded
through `WalkInput` / `WalkContext` / `CallContext`, and parsed behind a
content-keyed memo the way `catalogueForGemfile` parses a Gemfile. The
**walker** gains one class-body assignment reader that emits into the EXISTING
`classFieldTypes` / `classFieldTypesByClassKey` channels — no new channel, so
the MRO field walk seam 4 built inherits `objects` through `NetBoxModel` and
`PrimaryModel` for free. The **resolver** gains
`python/resolver/frameworks/django.ts` in the Ruby `defineFrameworkVocabulary`
shape, registered in a typed `PYTHON_FRAMEWORKS` array the engine folds over,
supplying the Django boundary names plus the fluent and terminal verb sets that
`memberTypeOf` consults when a folded receiver type is a project queryset.

**Tech Stack:** TypeScript (NodeNext, `strict`), vitest, tsx for the corpus
harnesses. New code in `src/core/domains/language/python/resolver/frameworks/`,
`src/core/domains/language/python/walker/`, `src/core/domains/language/kernel/`,
and the two offline harnesses under `scripts/`.

**Spec:**
`docs/superpowers/specs/2026-09-03-python-codegraph-unification-program-design.md`
— the E3 epic row ("pyproject-gated modules: Django (Manager / QuerySet returns,
field → attribute types, …)"), the `FrameworkModule<TEntry>` + `ManifestGate`
row of the contract spine, "Relocation protocol", "Decision records". Pull-order
entry 6 records that this seam is **unrankable from E0** — "jedi answers 0 of
the 4,769 `managerQuerySet` / `dependsInjection` sites, so their call-site count
is a lower bound on the lever, not a measurement of it" — and the attribution
below is the first measurement that replaces that guess. Predecessor:
`docs/superpowers/plans/2026-09-10-python-recall-frontier.md` (seam 5 — the
chain fold, `ReceiverTypePorts`, the MRO field walk, the plan format this one
reuses, and decision 11, whose `chain` row names this increment by name:
"netbox's is 141 Django-manager rows = E3 framework vocabularies"). Ruby
precedent: `.claude/rules/resolver-architecture.md` §2–§3.

---

## Decision record

### E3 increment 1 — Django managers and querysets (`9fgdi`)

**1. The attribution, measured before anything was designed.** Row dumps from
the seam-5 closing A/B at integration HEAD `fd6108761`, seeded jedi oracle, five
corpora, AFTER rows
(`/Users/artk0re/.claude/jobs/dffe3647/tmp/rf9/final-*.ndjson`). Every row whose
receiver names a manager, a queryset or a queryset-typed local was bucketed
D1–D5 by receiver SHAPE, then the netbox source was opened at the declaring
class to name the manager form. Counts are ROWS.

netbox, every verdict, so the phantom exposure is visible next to the recall:

| Family                                                | missed  | agreeExternal | bothUnresolved | total     |
| ----------------------------------------------------- | ------- | ------------- | -------------- | --------- |
| **D1** `<Model>.objects.<m>()`                        | **141** | 2,880         | 688            | **3,709** |
| **D2** fluent `<Model>.objects.<django>(…).<m>()`     | 0       | 194           | 443            | 637       |
| **D3** terminal `…get(…).<m>()` / `get_object_or_404` | 0       | 4             | 15             | 19        |
| **D4** `self.queryset.<m>()` / `qs.<m>()` locals      | 0       | 41            | 348            | 389       |
| **D5** DRF `self.request.*` / serializer / form       | 0       | 1             | 3              | 4         |

The 141 D1 misses, by oracle target — five manager classes, nothing else:

| oracle target                               | rows | declaring file                         | manager form                      |
| ------------------------------------------- | ---- | -------------------------------------- | --------------------------------- |
| `ObjectTypeManager#get_for_model`           | 71   | `netbox/core/models/object_types.py`   | `objects = ObjectTypeManager()`   |
| `ObjectTypeManager#with_feature`            | 34   | same                                   | same                              |
| `CustomFieldManager#get_for_model`          | 14   | `netbox/extras/models/customfields.py` | `objects = CustomFieldManager()`  |
| `ObjectTypeManager#public`                  | 8    | `netbox/core/models/object_types.py`   | same                              |
| `ContactGroupManager#annotate_contacts`     | 4    | `netbox/tenancy/models/contacts.py`    | `objects = ContactGroupManager()` |
| `UserManager#create_user`                   | 3    | `netbox/users/models/users.py`         | `objects = UserManager()`         |
| `ObjectTypeManager#get_by_natural_key`      | 3    | `netbox/core/models/object_types.py`   | same                              |
| `CustomFieldManager#get_defaults_for_model` | 3    | `netbox/extras/models/customfields.py` | same                              |
| `ObjectTypeManager#get_for_models`          | 1    | `netbox/core/models/object_types.py`   | same                              |

**Every one of the 141 resolves on the manager class's OWN method** — hop 0 of
the MRO walk. Not one needs an inheritance walk, and not one needs a fluent or
terminal verb. `ObjectType.objects.get_for_model(m)` is
`memberTypeOf(class ObjectType, "objects") → instance ObjectTypeManager`, then
`resolvePythonMemberOnTypeThroughMro("ObjectTypeManager", "get_for_model")`,
which seam 4 already built and seam 5 already wired into `chainType`.

**2. So the recall lever is Task 2 alone, and the vocabulary buys zero scoreable
recall.** D2/D3/D4/D5 contribute 0 missed rows on netbox: jedi cannot follow
`.objects.filter(…)` either, so those 1,049 rows sit in `agreeExternal` (oracle
says external) or `bothUnresolved` (oracle says nothing) and are OUTSIDE the
recall denominator (`match + fileOnly + wrongFile + missed`). Answering them
therefore cannot raise recall. It can only:

- turn a `bothUnresolved` into a `chainOnly` — a real edge the oracle cannot
  score, which is edge DENSITY and shows up in `codegraph-chain-tally` (809 rows
  across D2/D4 on netbox, 11 on ugnest), or
- turn an `agreeExternal` into a **phantom** — which is what the bar in decision
  6 forbids (239 netbox rows and 646 ugnest rows are exposed).

The vocabulary ships anyway, because edge density is the E3 epic's stated exit
("per-framework oracle deltas on the corpus that exercises it") and because
`memberTypeOf` needs the boundary predicate regardless. It ships behind its own
A/B and its own remove clause (decision 7).

**3. Why the phantom exposure is 0 and not a hope.** Both flip directions were
checked against the source, not assumed.

- Every netbox project QuerySet reached through `.as_manager()` defines ONLY
  non-Django names: `RestrictedQuerySet#restrict`,
  `ObjectChangeQuerySet#valid_models`, `NotificationQuerySet#unread`,
  `SharedObjectQuerySet#restrict_to_shared`,
  `ConfigContextQuerySet#get_for_object`,
  `ConfigContextModelQuerySet#annotate_config_context_data`,
  `ASNRangeQuerySet#annotate_asn_counts`, `IPRangeQuerySet#get_intervals`,
  `PrefixQuerySet#annotate_hierarchy`, `VLANGroupQuerySet#annotate_utilization`,
  `VLANQuerySet#get_for_site` / `get_for_site_group` / `get_for_device`. Zero
  overlap with the 24 Django built-ins that appear as D2 members.
- The one project override of a Django name, `ObjectTypeQuerySet#create`, is
  reached only through `ObjectTypeManager.get_queryset()`, and
  `ObjectType.objects` is `ObjectTypeManager()` — whose MRO is
  `[ObjectTypeManager, django.db.models::Manager]`. `create` is not on it, so
  `ObjectType.objects.create(…)` (1 agreeExternal row) DROPs at the boundary.
- `add_related_count` (16 agreeExternal rows) is declared by `django-mptt`, not
  by netbox's own `TreeManager` / `TreeQuerySet`. External, DROPs.
- `ContentType.objects.<m>()` (183 agreeExternal rows, `get_for_model` 76,
  `get_by_natural_key` 37, `get_for_id` 5, `get_for_models` 2) is Django's own
  model. It has no class-body assignment in the project, so no field fact, so
  the fold stops on hop 1 exactly as it does today. This is the one place the
  oracle disagrees with itself across the same member name, and the receiver
  class is what separates the 76 external rows from the 85 in-project ones.

**4. ugnest activates, and it is byte-identical anyway.** The orchestrator's
brief predicted "only netbox must activate". Wrong: ugnest's root
`requirements.txt:3` declares `Django==6.0.3`, so the manifest gate turns the
vocabulary ON for the anchor corpus whose phantom count must stay 0. It is safe
regardless, and for a stronger reason than the gate: **ugnest declares no
project Manager or QuerySet class at all** —
`rg '^class \w+\(.*(QuerySet|Manager).*\)'` and
`rg '= .*(as_manager\(\)|Manager\(\))'` both return nothing across its sources.
Its 416 D1 `agreeExternal` rows are Django built-ins on models with the implicit
default manager, so there is no class-body assignment to read, no field fact to
emit, and hop 1 stays untyped. ugnest's expected delta on every task in this
plan is **0 rows changed**, which makes it the plan's regression canary.

**5. Manifest presence across the five corpora, measured.**

| corpus | root manifests                                                                     | names `django`        | vocabulary active |
| ------ | ---------------------------------------------------------------------------------- | --------------------- | ----------------- |
| netbox | `pyproject.toml`, `requirements.txt`                                               | yes (`Django==6.0.8`) | **yes**           |
| ugnest | `pyproject.toml`, `requirements.txt`, `requirements-dev.txt`                       | yes (`Django==6.0.3`) | **yes**           |
| flask  | `pyproject.toml`                                                                   | no                    | no                |
| httpx  | `pyproject.toml`, `requirements.txt`                                               | no                    | no                |
| polar  | none at the root (`server/pyproject.toml`, `sdk/python/pyproject.toml` are nested) | n/a                   | no                |

Two facts the parser must respect, both from netbox. Its `pyproject.toml` says
`dynamic = ["version", "dependencies"]` and carries no dependency list at all,
so `requirements*.txt` is NOT an optional extra — it is the only place netbox
names Django. And the token is spelled `Django`, so the match is
case-insensitive. The match is also EXACT after PEP 503 normalisation:
`django-cors-headers`, `django-mptt`, `django-filter` and eleven more normalise
to themselves and must not satisfy a `django` gate.

Root-only, exactly as `loadGemfile` is root-only. polar's nested manifests are
therefore invisible; that is recorded, not fixed, because polar's SQLAlchemy
families need no gate they do not already fail (decision 8).

**6. Which class-body RHS becomes a field fact, and which emits NOTHING.** The
walker cannot ask whether `RestrictedQuerySet` descends from
`django.db.models::QuerySet` — that is run-global `classAncestors`, and a
per-file pass has neither. So the emit gate is SYNTACTIC and the boundary test
stays in the resolver. Three shapes emit, everything else is silent:

| class-body RHS                                         | fact     | netbox sites | rationale                                                                   |
| ------------------------------------------------------ | -------- | ------------ | --------------------------------------------------------------------------- |
| `<Name>.as_manager()`                                  | `<Name>` | 26           | `as_manager` is Django's own verb; the queryset's members ARE the manager's |
| `<Name>()` where `<Name>` ends `Manager` or `QuerySet` | `<Name>` | 11           | name-suffix convention; all 9 distinct netbox manager classes match         |
| `<Name>.from_queryset(<QS>)()`                         | `<QS>`   | **0**        | syntactically unambiguous, shipped for completeness                         |

`objects = models.Manager()` / `Manager()` — the Django default — emits
**NOTHING**, not an "external" fact. Two reasons, and the second is the decisive
one. The fold's stop-at-unknown-hop already produces an untyped receiver, and
`chainType` returns `CONTINUE` on an untyped receiver, so absence is
byte-identical to today's behaviour. A fact that resolves external would make
`chainType` DROP where the call currently falls through, changing which strategy
answers 3,093 netbox rows for no measured gain. Absence is the conservative half
of "never CONTINUE to `globalShortName`": the receiver never becomes typed, so
no vocabulary answer is ever produced, and the call reaches the same strategy it
reaches today.

`from_queryset` in BASE position —
`class CustomFieldManager(models.Manager.from_queryset(RestrictedQuerySet))`,
which is netbox's DOMINANT manager form (4 of 9 classes) — is already handled
and needs no change: `collectPythonClassAncestors` writes
`PYTHON_UNRESOLVABLE_BASE` for a computed base and `python-ancestor-policy.ts`
answers `UNKNOWN_BASE` for it, which is correctly non-committal. All 17
`CustomFieldManager` rows and all 3 `UserManager` rows resolve on hop 0 and
never consult that branch.

The name-suffix rule is a convention, and conventions are guesses. It is
acceptable here for a reason the alternatives are not: the fact it produces is
never an ANSWER, only a receiver TYPE, and every answer downstream still has to
pin a real symbol on that type's MRO or DROP. A wrong `objects: FooManager`
guess on a class where `FooManager` is not a manager resolves the member on
`FooManager` — which is what the name says it is — or produces nothing.

**7. What the vocabulary is for, given decision 2.** Four facets, each with
exactly one consumer, and each measured:

| facet                      | contents                                                                                                          | consumer                                 | measured demand                                          |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------- |
| `boundaryBases`            | `django.db.models::QuerySet`, `::Manager`, `::BaseManager`, `django.db.models.manager::Manager` / `::BaseManager` | `isQuerysetType` → gates the other three | precondition; netbox 26 `.as_manager()` classes reach it |
| `fluentSelfMembers`        | 15 verbs returning the same queryset                                                                              | `memberTypeOf`, same-type arm            | 0 recall; 637 D2 density rows on netbox                  |
| `instanceTerminalMembers`  | 5 verbs returning one MODEL instance                                                                              | `memberTypeOf`, owner arm                | 0 recall; 19 D3 density rows on netbox                   |
| `positionalClassShortcuts` | `get_object_or_404` → arg 0                                                                                       | `singleHopType`, call-receiver arm       | **0 rows on netbox as a receiver** (61 as a bare call)   |

Declined, with the reason each:

- `values` / `values_list` — return dicts and tuples, not the queryset. Typing
  them as self would fabricate a queryset receiver for a dict. 24 netbox rows
  would flip the wrong way.
- `collectionMembers` (`all()` iterated to an element type) — needs RF.7
  container typing off an annotation, which Python does not have here. Out of
  scope, stated so the next increment does not re-open it.
- `get_or_create` / `update_or_create` — return a `(obj, created)` TUPLE.
  Element typing is the same missing mechanism. 7 netbox rows.
- `restrict`, `annotate_utilization`, `valid_models` and every other PROJECT
  queryset method — never in the vocabulary. The vocabulary names the LIBRARY's
  boundary; a project method is resolved by the MRO walk, which is the whole
  point. `restrict` alone is 91 netbox `bothUnresolved` rows that land as
  `chainOnly` edges through the MRO, not through a vocabulary entry.

**8. Remove clause, stated up front so the executor does not defend it.** If
Task 3's A/B moves phantom by more than +0.5 pp of edges on ANY corpus, or moves
ugnest off phantom 0, the offending ARM is removed — not tuned. The arms are
independently removable by construction: `fluentSelfMembers`,
`instanceTerminalMembers` and `positionalClassShortcuts` are three separate
frozen Sets read at three separate places, and deleting one leaves the other two
and Task 2's recall intact. Task 2 is never removed by this clause: its 141 rows
are `missed → match`, which cannot create a phantom.

**9. The manager-owner representation for the terminal arm.**
`Model.objects.get(pk).save()` needs `get` to yield the MODEL, and by then the
fold has forgotten which model the manager came from. Three representations were
considered.

- **A fifth kernel port**, or an owner threaded through `propagateChain`.
  Rejected: `ReceiverTypePorts` is a language-neutral contract that Ruby, TS and
  Java share, and "which model owns this manager" is a Django concept. It does
  not belong in `kernel/`.
- **An optional facet on `TypeRef`** (`{form:"instance", name, querysetOf}`).
  Rejected: `TypeRef` is a closed discriminated union with builders and
  comparers in `kernel/type-ref.ts` that Ruby uses on every hop. Widening the
  `class | instance` arm ripples into a file this plan may not touch.
- **CHOSEN — the owner rides in `TypeRef.name` under an `@` spelling**:
  `RestrictedQuerySet@Site`. Precedent is dense and local: `qualifyPythonBase`
  already writes `module::Class` into a base spelling,
  `python-ancestor-policy.ts` writes `A|B` for a star-import disjunction, and
  `pythonClassKey` writes `relPath::classFq`. `@` is legal in neither a Python
  identifier nor a dotted module path, so it cannot collide with either half of
  a name. Ruby never produces one, so Ruby reads are unaffected.

The tag leaks out of the fold — `chainType` receives the final `TypeRef` — so it
is stripped at ONE funnel, `pythonBareTypeName(name)` in the new
`python-django-type.ts`, applied at the four Python reads that treat a type name
as a class name: `chainType`'s `resolveTypeFile` call and its
`resolvePythonMemberOnTypeThroughMro` call, `pythonInheritedMemberType`'s
own-class read, and `resolvePythonMemberOnType`. The invariant is stated once,
in that helper's doc comment.

Honest scope note: this representation exists for 19 netbox rows that the oracle
cannot score. If Task 3's A/B removes the terminal arm under decision 8, the tag
and the funnel go with it and Task 2 is unaffected.

**10. Walker version bump 4 → 5, and why a data-only change still needs one.**
`.claude/rules/language-capability-sync.md` says to bump `versions.walker` when
a change alters "what that language PRODUCES for an already-indexed project". A
class-body field fact is new DATA in an existing channel — the channel shape is
untouched — but a file walked by walker 4 has no `objects` entry, so its
`<Model>.objects.<m>()` sites stay untyped forever. That is exactly the
condition the version guards, so: bump to 5, extend the comment block in
`python/capability.ts`, run `npm run gen:lang-compat`, commit the regenerated
artifacts. The hint the bump produces is the right one —
`--force-enrichments codegraph --languages python`, not a full reindex, because
the chunk set does not move.

**11. Projected end state if every task lands, stated against decision 11 of
seam 5.** netbox `chain` 0.403 → **0.972 (241/248)**; the residual 7 rows are
the multi-line constructor receivers and `self.customlink` that decision 11
already called branch-bound. netbox `dynamic` (0.972) and `localVar` (0.764) are
NOT projected to move: their misses are `cls` (17 rows), instance locals, and
iteration variables, none of which is a manager shape. Overall netbox
`inProjectEdgeRecall` moves by 141 matches on a denominator of 8,318 oracle
rows, roughly +1.7 pp. polar, flask and httpx: **0 rows changed** (no root
manifest, or no Django). ugnest: **0 rows changed** (decision 4). This is the
whole honest claim; nothing here moves polar's `dynamic` floor or netbox's
`index` row.

---

## Global Constraints

- **Precision first.** Every new answer is a project symbolId or silence. No
  fan-out, no file-only fallback, no CONTINUE into `globalShortName` from a
  Django boundary. `Model.objects.filter()` with no project queryset DROPs, as
  it does today.
- **No task may convert an existing `agreeExternal` into a project edge.** The
  A/B in every task's gate checks that column explicitly, per corpus.
- **Ruby is untouched.** Not one file under `src/core/domains/language/ruby/` is
  edited by this plan. `gemfileContent` keeps every reader and writer it has;
  the new `dependencyManifest` field is ADDITIVE and Ruby never sets or reads
  it. Task 1 touches `contracts/types/language.ts`,
  `contracts/types/codegraph-resolution.ts`, `kernel/extraction-passes.ts` and
  the two composition roots, so it runs the FULL Ruby resolver and walker suites
  and compares row-for-row against the pre-task tree. Any diff fails the task.
- **Business-logic tests are immutable.** Existing tests are never rewritten.
  The only permitted edit is a pin that now has a different, better answer — and
  that edit carries a bead comment naming the row and the corpus.
- **ugnest is the canary.** Its expected delta is 0 rows on every task (decision
  4). A non-zero ugnest delta is a bug report, not a result.
- **Perf budget, measured on netbox.** Wall ≤ +25 %, RSS ≤ +20 % against the
  pre-task tree. The vocabulary is frozen `Set`s built at module load; the
  manifest is parsed ONCE per run behind a content-keyed memo; the gate is
  evaluated once per FILE in the walker and once per `classAncestors` identity
  in the resolver. Nothing in this plan may add per-call-site AST work or
  per-call-site filesystem access.
- **No filesystem access below the composition roots.** The manifest is read by
  `CodegraphRunState.loadDependencyManifest` and
  `IndexingPipelineBase#readDependencyManifest` and nowhere else, exactly as the
  Gemfile is. The resolver and the walker receive a STRING.
- **No new env flags.**
- **Commits.** `feat(language): … (9fgdi)` for new capability,
  `refactor(language): … (9fgdi)` for a pure relocation. Body wrapped at ≤ 100
  columns. `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` trailer.
- **Execution.** A fresh Opus executor per task, each in its own worktree. Tool
  calls ≤ 8 min; writes ≤ 120 lines per call.

---

## File Structure

```text
src/core/
├── contracts/types/
│   ├── language.ts                              MOD  WalkInput/WalkContext.dependencyManifest
│   └── codegraph-resolution.ts                  MOD  CallContext.dependencyManifest
├── domains/language/
│   ├── kernel/
│   │   ├── extraction-passes.ts                 MOD  toWalkContext threads the manifest
│   │   └── dependency-manifest.ts               NEW  parse + content-keyed memo, language-neutral
│   └── python/
│       ├── capability.ts                        MOD  walker 4 → 5, tech text
│       ├── CLAUDE.md                            MOD  navigator: the class-body field channel
│       ├── index.ts                             MOD  wire the vocabulary into the resolver
│       ├── resolver/
│       │   ├── frameworks/
│       │   │   ├── django.ts                    NEW  DJANGO_VOCABULARY
│       │   │   ├── framework-module.ts          NEW  definePythonFrameworkVocabulary
│       │   │   ├── index.ts                     NEW  PYTHON_FRAMEWORKS + vocabularyForManifest
│       │   │   └── types.ts                     NEW  PythonFrameworkVocabulary
│       │   ├── python-django-type.ts            NEW  owner tag: build / parse / strip
│       │   ├── python-receiver-type-ports.ts    MOD  memberTypeOf + singleHopType arms
│       │   └── strategies/
│       │       ├── python-chain-type.ts         MOD  strip the owner tag at the two reads
│       │       └── shared.ts                    MOD  strip the owner tag at two reads
│       └── walker/
│           ├── walker.ts                        MOD  collectPythonClassBodyFieldTypes
│           └── passes/python-class-body-fields.ts  NEW  the assignment reader (pure)
├── domains/ingest/pipeline/base.ts              MOD  readDependencyManifest
└── domains/trajectory/codegraph/symbols/
    ├── run-state.ts                             MOD  loadDependencyManifest
    └── provider.ts                              MOD  attach it to CallContext

scripts/
├── lib/codegraph-corpora.ts                     —    unchanged
├── ts-codegraph-typechecker-oracle.ts           MOD  extractFile takes the manifest
├── codegraph-chain-tally.ts                     MOD  read + thread the manifest
└── py-codegraph-jedi-oracle.ts                  MOD  read + thread the manifest

tests/core/domains/language/
├── kernel/dependency-manifest.test.ts           NEW
└── python/
    ├── walker/class-body-field-types.test.ts    NEW
    └── resolver/frameworks/django-vocabulary.test.ts  NEW
```

---

## Context the implementer needs

### The channels, exactly as they exist today

`FileExtraction` carries two field channels and the walker fills both from ONE
gate (`walker/walker.ts`, `pythonSelfFieldType`):

```ts
// walker.ts:83, 88 — both derived from `self.<field> = …` and nothing else
const classFieldTypes = collectPythonClassFieldTypes(input.tree.rootNode);
const classFieldTypesByClassKey = collectPythonClassFieldTypesByClassKey(
  input.tree.rootNode,
  input.relPath,
);
// walker.ts:134-135 — emit-only-non-empty
if (Object.keys(classFieldTypes).length > 0)
  out.classFieldTypes = classFieldTypes;
if (Object.keys(classFieldTypesByClassKey).length > 0)
  out.classFieldTypesByClassKey = classFieldTypesByClassKey;
```

- `classFieldTypes: Record<shortClassName, Record<field, typeName>>` — per FILE,
  read by `PythonSelfFieldSymbolResolutionStrategy` and by the own-class arm of
  `pythonInheritedMemberType`.
- `classFieldTypesByClassKey: Record<"<relPath>::<dotted class FQ>", Record<field, typeName>>`
  — absorbed RUN-GLOBAL (`run-state.ts`, and `absorbTypeChannels` in the tally),
  read by `pythonInheritedMemberType` for the own class AND for every ancestor
  the C3 linearizer returns. **This is the channel that makes `objects` on
  `NetBoxModel` visible from `Site`.**

Both are `Record<string, Record<string, string>>` — a bare TYPE NAME, no
`TypeRef`. `pythonInheritedMemberType` wraps a hit as
`{ form: "instance", name: fieldType }`.

### The fold, and where the two new arms go

`propagateReceiverType(receiver, atLine, ctx, ports)` in
`kernel/receiver-type-propagation.ts` splits `a.b.c`, seeds the head, then calls
`ports.memberTypeOf(current, link, ctx)` per link, STOPPING at the first
`undefined`. Python's four ports are built once per resolver in
`createPythonReceiverTypePorts` (`python-receiver-type-ports.ts:200`). The two
arms this plan adds:

- `memberTypeOf` — after `pythonInheritedMemberType` answers `undefined`, ask
  the Django vocabulary: is `recv` a project queryset (its MRO reaches a
  `boundaryBases` spelling), and is `member` a fluent or terminal verb?
- `singleHopType` — before the `receiver.endsWith(")")` CapWords check, ask the
  vocabulary whether the stripped callee is a `positionalClassShortcuts` entry.

### How an external base is spelled

`collectPythonClassAncestors` → `qualifyPythonBase` writes
`<moduleText>::<ClassName>`. Measured spellings this plan must match:

| source                                                        | `classAncestors` value                         |
| ------------------------------------------------------------- | ---------------------------------------------- |
| `from django.db.models import QuerySet` + `class X(QuerySet)` | `django.db.models::QuerySet`                   |
| `from django.db import models` + `class X(models.Manager)`    | `django.db.models::Manager`                    |
| `class X(Manager.from_queryset(QS), TreeManager_)`            | `<unresolvable>`, `mptt.managers::TreeManager` |

`PYTHON_UNRESOLVABLE_BASE` is `"<unresolvable>"` (`walker/walker.ts:521`) and
`python-ancestor-policy.ts:188` already answers `UNKNOWN_BASE` for it. The
boundary predicate must treat it as "keep walking the other bases", never as
"this is not a queryset".

### The Gemfile precedent, end to end

| layer             | Ruby today                                                                            | Python equivalent to build                                       |
| ----------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| contract, walk    | `WalkInput.gemfileContent` / `WalkContext.gemfileContent` (`language.ts:212`, `:422`) | `dependencyManifest` on both                                     |
| contract, resolve | `CallContext.gemfileContent` (`codegraph-resolution.ts:314`)                          | `CallContext.dependencyManifest`                                 |
| projection        | `toWalkContext` (`kernel/extraction-passes.ts:73`)                                    | same function, one more `if`                                     |
| resolve root      | `CodegraphRunState.loadGemfile(root)` (`run-state.ts:640`)                            | `loadDependencyManifest(root)`, same one-per-run guard           |
| chunker root      | `IndexingPipelineBase#readGemfile` (`pipeline/base.ts:357`)                           | `readDependencyManifest`, same try/catch                         |
| parse + memo      | `catalogueForGemfile` (`ruby/gemfile.ts:64`), `Map` keyed by content                  | `dependencyNamesOf`, `Map` keyed by content                      |
| harness           | not threaded                                                                          | `extractFile(..., manifest)` + `buildCallContext(..., manifest)` |

---

## Task 1 — Dependency-manifest facility

**Files:**

- NEW `src/core/domains/language/kernel/dependency-manifest.ts`
- NEW `tests/core/domains/language/kernel/dependency-manifest.test.ts`
- MOD `src/core/contracts/types/language.ts` (`WalkInput`, `WalkContext`)
- MOD `src/core/contracts/types/codegraph-resolution.ts` (`CallContext`)
- MOD `src/core/domains/language/kernel/extraction-passes.ts` (`toWalkContext`)
- MOD `src/core/domains/trajectory/codegraph/symbols/run-state.ts`
- MOD `src/core/domains/trajectory/codegraph/symbols/provider.ts`
- MOD `src/core/domains/trajectory/codegraph/symbols/resolution-runner.ts`
- MOD `src/core/domains/ingest/pipeline/base.ts`
- MOD `src/core/domains/ingest/pipeline/chunker/infra/worker.ts` (+ the pool
  options type it reads `engine.gemfileContent` from)
- MOD `scripts/ts-codegraph-typechecker-oracle.ts`,
  `scripts/codegraph-chain-tally.ts`, `scripts/py-codegraph-jedi-oracle.ts`

**Interfaces:**

```ts
/** Manifest files read at the project root, in this order. */
export const DEPENDENCY_MANIFEST_FILES: readonly string[];

/** Read every manifest file present at `root` and join them. Absent ⇒ undefined. */
export function readDependencyManifestAt(root: string): string | undefined;

/** PEP 503 name normalisation: lowercase, runs of `-_.` collapse to `-`. */
export function normalizeDistributionName(raw: string): string;

/** Distribution names a manifest declares. Memoised by the raw string. */
export function dependencyNamesOf(
  manifest: string | undefined,
): ReadonlySet<string>;

/** Does the manifest declare this distribution? `undefined` manifest ⇒ false. */
export function dependencyManifestDeclares(
  manifest: string | undefined,
  name: string,
): boolean;
```

**Steps:**

- [ ] Write `tests/core/domains/language/kernel/dependency-manifest.test.ts`
      first, RED. Cover, with the strings measured on the corpora:
      `Django==6.0.8` in a requirements body ⇒ declares `django`
      (case-insensitive); `django-cors-headers==4.9.0`, `django-mptt==0.18.0`,
      `django-filter==26.1` alone ⇒ does NOT declare `django`; a PEP 621 array
      `dependencies = [\n  "fastapi==0.141.1",\n  "sqlalchemy[asyncio]>=2.0.51",\n]`
      ⇒ declares `fastapi` and `sqlalchemy` (extras stripped); a poetry section
      `[tool.poetry.dependencies]\npython = "^3.12"\ndjango = "^5.0"` ⇒ declares
      `django` but a `dependencies = [` line outside a poetry section does NOT
      declare `dependencies`; `# Django==1.0` ⇒ nothing; `-r base.txt`,
      `--index-url https://x`, `-e .` ⇒ nothing;
      `pytest ; python_version < "3.11"` ⇒ declares `pytest`; `undefined` ⇒
      empty set and `dependencyManifestDeclares(undefined, "django") === false`;
      calling `dependencyNamesOf` twice with the same string returns the SAME
      Set identity (the memo).
- [ ] Create `kernel/dependency-manifest.ts`. Language-neutral by design — it
      parses a text blob into distribution names and knows nothing about Python
      syntax beyond the two spellings above. Full body:

```ts
/**
 * A project's dependency manifest, as a raw string, and the distribution names
 * it declares (bd tea-rags-mcp-9fgdi, E3 increment 1).
 *
 * The Python analogue of `ruby/gemfile.ts`, and deliberately the same SHAPE:
 * the composition root reads the manifest ONCE per run and threads the RAW
 * string; the parse lives here behind a memo keyed by that string, so a project
 * pays for it once and every call site is an O(1) `Set.has`.
 *
 * Root-only, like the Gemfile. A nested `server/pyproject.toml` is invisible —
 * polar declares SQLAlchemy that way and is therefore ungated, which is
 * recorded rather than fixed because nothing measured needs it yet.
 *
 * The reader is line-oriented rather than a TOML parser on purpose. netbox's
 * `pyproject.toml` says `dynamic = ["version", "dependencies"]` and names Django
 * NOWHERE — only `requirements.txt` does — so the facility has to read both
 * shapes anyway, and one scanner that handles both is smaller than a TOML parser
 * plus a requirements parser plus the code that decides which file is which.
 */

/** Manifest files read at the project ROOT, in this order, joined by `\n`. */
export const DEPENDENCY_MANIFEST_FILES: readonly string[] = [
  "pyproject.toml",
  "requirements.txt",
  "requirements-dev.txt",
  "setup.cfg",
  "setup.py",
];

/** Bytes read per manifest file. A manifest is metadata; anything larger is not one. */
export const DEPENDENCY_MANIFEST_MAX_BYTES = 262_144;

/** PEP 503: lowercase, and every run of `-`, `_` or `.` becomes a single `-`. */
export function normalizeDistributionName(raw: string): string {
  return raw.toLowerCase().replace(/[-_.]+/g, "-");
}

/** A TOML section header line — `[tool.poetry.dependencies]` — or null. */
const SECTION = /^\[([^\]]+)\]\s*$/;
/** A poetry dependency table, including per-group ones. */
const POETRY_DEPS = /^tool\.poetry(\.group\.[^.]+)?\.dependencies$/;
/** A requirement specifier's leading distribution name, extras and all. */
const REQUIREMENT =
  /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(?:[=<>!~;@].*)?$/;
/** A quoted string, single or double. */
const QUOTED = /["']([^"']+)["']/g;

const namesByManifest = new Map<string, ReadonlySet<string>>();
const EMPTY: ReadonlySet<string> = Object.freeze(new Set<string>());
```

```ts
/** Record `raw` as a requirement specifier, if it looks like one. */
function addRequirement(into: Set<string>, raw: string): void {
  const match = REQUIREMENT.exec(raw.trim());
  if (match === null) return;
  into.add(normalizeDistributionName(match[1]));
}

/**
 * Distribution names a manifest declares, PEP 503 normalised.
 *
 * Three spellings, all of which the five corpora produce:
 *   - a bare requirements line   `Django==6.0.8`
 *   - a quoted array entry       `  "sqlalchemy[asyncio]>=2.0.51",`
 *   - a poetry table key         `django = "^5.0"` under `[tool.poetry.dependencies]`
 *
 * A quoted line is read as ARRAY entries and never also as a bare line: a TOML
 * assignment's left-hand side outside a poetry table is a key like
 * `dependencies` or `requires-python`, not a distribution.
 */
export function dependencyNamesOf(
  manifest: string | undefined,
): ReadonlySet<string> {
  if (manifest === undefined) return EMPTY;
  const cached = namesByManifest.get(manifest);
  if (cached !== undefined) return cached;

  const names = new Set<string>();
  let section = "";
  for (const line of manifest.split("\n")) {
    const withoutComment = line.split("#")[0];
    const trimmed = withoutComment.trim();
    if (trimmed === "") continue;
    const header = SECTION.exec(trimmed);
    if (header !== null) {
      section = header[1];
      continue;
    }
    // pip control lines carry no distribution: `-r`, `-c`, `-e`, `--index-url`.
    if (trimmed.startsWith("-")) continue;
    const quoted = [...trimmed.matchAll(QUOTED)];
    if (quoted.length > 0) {
      for (const entry of quoted) addRequirement(names, entry[1]);
      continue;
    }
    if (POETRY_DEPS.test(section)) {
      const key = trimmed.split("=")[0].trim();
      if (key !== "" && key !== "python")
        names.add(normalizeDistributionName(key));
      continue;
    }
    if (trimmed.includes("=") && !trimmed.includes("==")) continue; // a TOML key
    addRequirement(names, trimmed);
  }

  const frozen: ReadonlySet<string> = Object.freeze(names);
  namesByManifest.set(manifest, frozen);
  return frozen;
}

/** Does the manifest declare this distribution? An absent manifest declares nothing. */
export function dependencyManifestDeclares(
  manifest: string | undefined,
  name: string,
): boolean {
  return dependencyNamesOf(manifest).has(normalizeDistributionName(name));
}
```

- [ ] Run the test file GREEN. No other file has been touched yet.
- [ ] Thread the contract. In `contracts/types/language.ts`, add to BOTH
      `WalkInput` and `WalkContext`, immediately after `gemfileContent`:

```ts
  /**
   * Raw contents of the project's dependency manifest — every file in
   * `DEPENDENCY_MANIFEST_FILES` that exists at the root, joined by newlines,
   * read ONCE per run (bd tea-rags-mcp-9fgdi, E3 increment 1). The Python
   * analogue of {@link gemfileContent}: extraction-time consumers gate
   * framework-conditional grammar on it via `dependencyManifestDeclares`.
   * Undefined ⇒ no manifest ⇒ every framework gate falls back to per-file
   * import evidence. Ruby does not read it and Python does not read
   * `gemfileContent`; the two converge into one field when Ruby is relocated.
   */
  dependencyManifest?: string;
```

      Add the same field, with a `CallContext`-flavoured version of that
      comment, to `CallContext` in `contracts/types/codegraph-resolution.ts`
      beside `gemfileContent` (line 314).

- [ ] In `kernel/extraction-passes.ts::toWalkContext`, mirror the existing
      absent-key discipline exactly — a second `if`, not a spread:

```ts
if (input.dependencyManifest !== undefined) {
  ctx.dependencyManifest = input.dependencyManifest;
}
```

- [ ] Composition root 1, the codegraph resolve path. In `run-state.ts`, beside
      `gemfileContent` / `gemfileLoaded`, add
      `dependencyManifest: string | undefined` and
      `private dependencyManifestLoaded = false`, and:

```ts
  /**
   * Read the project's dependency manifest ONCE per run, guarded exactly as
   * {@link loadGemfile} is. Every file in `DEPENDENCY_MANIFEST_FILES` that
   * exists at the root is read and the results are joined with a newline, so a
   * project that names its dependencies in `requirements.txt` while its
   * `pyproject.toml` says `dynamic = ["dependencies"]` — netbox — is still
   * described. Absent / unreadable ⇒ `undefined` ⇒ every framework gate off.
   */
  loadDependencyManifest(root: string): void {
    if (this.dependencyManifestLoaded) return;
    this.dependencyManifestLoaded = true;
    const parts: string[] = [];
    for (const file of DEPENDENCY_MANIFEST_FILES) {
      try {
        parts.push(readFileSync(join(root, file), "utf8").slice(0, DEPENDENCY_MANIFEST_MAX_BYTES));
      } catch {
        // This project does not carry that manifest file.
      }
    }
    this.dependencyManifest = parts.length === 0 ? undefined : parts.join("\n");
  }
```

      Reset `this.dependencyManifest = undefined` (and
      `this.dependencyManifestLoaded = false`) at EVERY seam that today resets
      `gemfileContent` — `run-state.ts` lines 845, 928, 1005, 1041. A missed
      reset is a cross-project leak, which is the bug class `6goqa` is named
      after.

- [ ] Call it beside every `this.runState.loadGemfile(root)` in `provider.ts`
      (lines 926, 1121, 1154). Attach it beside every
      `gemfileContent: this.runState.gemfileContent` in `resolution-runner.ts`
      (lines 297, 388) and in the `walker.walk({…})` at `provider.ts:1706`.
- [ ] Composition root 2, the chunker walk path. In `ingest/pipeline/base.ts`,
      add `readDependencyManifest(absolutePath)` with the same body as above
      (extract the shared read into a helper exported from
      `kernel/dependency-manifest.ts` — `readDependencyManifestAt(root)` —
      rather than writing it twice; the run-state method becomes a memoised
      caller of it). Pass the result into `createChunkerPool` alongside
      `gemfileContent`, add it to the pool's options type, and thread it to
      `worker.ts:135`'s `walker.walk({…})` as
      `dependencyManifest: engine.dependencyManifest`.
- [ ] Harnesses, so the A/B measures production. In
      `scripts/ts-codegraph-typechecker-oracle.ts`, add a fifth parameter:
      `extractFile(repoRoot, relPath, composer, factory, dependencyManifest?: string)`
      and pass it into `walker.walk({…})`. In
      `scripts/codegraph-chain-tally.ts`, call `readDependencyManifestAt(root)`
      once before the pass-1 loop, pass it to every `extractFile`, and add
      `dependencyManifest` to the object `buildCallContext` returns. Do the same
      in `scripts/py-codegraph-jedi-oracle.ts` (`extractFile` at line 170, the
      context object at line 214) using `corpusRoot`.
- [ ] `npx tsc --noEmit` clean; `npm run test:coverage` exit 0.
- [ ] **Ruby parity gate.** `npx vitest run tests/core/domains/language/ruby`
      green with no test edits, and
      `npx tsx scripts/codegraph-chain-tally.ts --lang ruby --corpus <mastodon>`
      → `edges` / `fileOnly` / `unresolved` byte-identical to the pre-task tree.
- [ ] **Python neutrality gate.** Row dumps ×5 BEFORE and AFTER this task must
      be byte-identical: nothing reads `dependencyManifest` yet.
- [ ] Commit:
      `feat(language): thread a dependency manifest through walk and resolve (9fgdi)`.

---

## Task 2 — Manager field facts from class-body assignments, and the Django gate

The recall lever. The framework registry is introduced HERE, not in Task 3,
because the walker's emit gate is a registry facet, and a facet ships with its
consumer.

**Files:**

- NEW `src/core/domains/language/python/resolver/frameworks/types.ts`
- NEW `src/core/domains/language/python/resolver/frameworks/framework-module.ts`
- NEW `src/core/domains/language/python/resolver/frameworks/django.ts`
- NEW `src/core/domains/language/python/resolver/frameworks/index.ts`
- NEW
  `src/core/domains/language/python/walker/passes/python-class-body-fields.ts`
- NEW `tests/core/domains/language/python/walker/class-body-field-types.test.ts`
- MOD `src/core/domains/language/python/walker/walker.ts`

**Interfaces:**

```ts
export interface PythonFrameworkVocabulary {
  readonly framework: string;
  /** Distribution names that activate this framework, PEP 503 normalised. */
  readonly activatedBy: ReadonlySet<string>;
  /** Module prefixes whose presence in a file's imports activate it with NO manifest. */
  readonly importPrefixes: readonly string[];
  /** `X.<verb>()` in a class body yields a manager type. `as_manager` yields X. */
  readonly managerFactoryVerbs: ReadonlySet<string>;
  /** `X.from_queryset(Q)()` yields Q rather than X. */
  readonly querysetFactoryVerbs: ReadonlySet<string>;
  /** `X()` in a class body yields X when X's short name ends with one of these. */
  readonly managerClassSuffixes: readonly string[];
  /** Declared by the project, or (no manifest at all) imported by this file. */
  isActive(
    manifest: string | undefined,
    imports: readonly ImportRef[],
  ): boolean;
}

export const PYTHON_FRAMEWORKS: readonly PythonFrameworkVocabulary[];

/** The active frameworks for this project and file. Folded, never disjoined inline. */
export function pythonActiveFrameworks(
  manifest: string | undefined,
  imports: readonly ImportRef[],
): readonly PythonFrameworkVocabulary[];
```

**Steps:**

- [ ] `frameworks/types.ts` — the interface above, with a doc paragraph naming
      the Ruby precedent: typed array registry, one module file per framework,
      the engine folds over it (`.claude/rules/resolver-architecture.md`, the
      "No inline disjunction over data constants" and "Registry is a typed
      array" sections).
- [ ] `frameworks/framework-module.ts` — the factory. The activation decision
      lives here ONCE so no module restates it:

```ts
export function definePythonFrameworkVocabulary(
  framework: string,
  data: Omit<PythonFrameworkVocabulary, "framework" | "isActive">,
): PythonFrameworkVocabulary {
  return Object.freeze({
    framework,
    ...data,
    isActive: (manifest, imports) => {
      // A manifest is EVIDENCE IN BOTH DIRECTIONS: a project that declares its
      // dependencies and does not name this framework is not using it, whatever
      // one file's imports say. Only a project with NO manifest at all — polar,
      // whose manifests are nested one directory below the root — falls back to
      // the file's own imports, and there a `django.` import IS the evidence.
      const declared = dependencyNamesOf(manifest);
      if (declared.size > 0) {
        for (const name of data.activatedBy)
          if (declared.has(name)) return true;
        return false;
      }
      return imports.some((imp) =>
        data.importPrefixes.some(
          (prefix) =>
            imp.importText === prefix ||
            imp.importText.startsWith(prefix + "."),
        ),
      );
    },
  });
}
```

- [ ] `frameworks/django.ts` — the data. Task 3 appends three more facets to
      this same object; nothing here is provisional.

```ts
/**
 * Django's receiver vocabulary (bd tea-rags-mcp-9fgdi, E3 increment 1).
 *
 * `managerClassSuffixes` is a NAMING CONVENTION and is deliberately narrow. All
 * nine of netbox's manager classes end in `Manager` — `ObjectTypeManager`,
 * `CustomFieldManager`, `ContactGroupManager`, `UserManager`, `GroupManager`,
 * `IPAddressManager`, `ScriptModuleManager`, `ModuleBayManager`, `TreeManager` —
 * and every `.as_manager()` receiver ends in `QuerySet`. The convention costs
 * little when wrong: the fact it produces is a receiver TYPE, and every answer
 * downstream still has to pin a real symbol on that type's MRO or say nothing.
 */
export const DJANGO_VOCABULARY = definePythonFrameworkVocabulary("django", {
  activatedBy: new Set(["django"]),
  importPrefixes: ["django"],
  managerFactoryVerbs: new Set(["as_manager"]),
  querysetFactoryVerbs: new Set(["from_queryset"]),
  managerClassSuffixes: ["Manager", "QuerySet"],
});
```

- [ ] `frameworks/index.ts` — the typed registry and the fold. One line per
      framework; no consumer ever writes an inline disjunction.

```ts
export const PYTHON_FRAMEWORKS: readonly PythonFrameworkVocabulary[] =
  Object.freeze([DJANGO_VOCABULARY]);

export function pythonActiveFrameworks(
  manifest: string | undefined,
  imports: readonly ImportRef[],
): readonly PythonFrameworkVocabulary[] {
  return PYTHON_FRAMEWORKS.filter((framework) =>
    framework.isActive(manifest, imports),
  );
}
```

- [ ] Write
      `tests/core/domains/language/python/walker/class-body-field-types.test.ts`
      first, RED. Parse real Python with `tree-sitter-python` the way the
      neighbouring walker tests do, and assert on the two returned maps. The
      cases, each a shape measured on netbox:

| source                                                                  | `byShortName` entry                                                   |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `class Site(Model):\n    objects = RestrictedQuerySet.as_manager()`     | `{ Site: { objects: "RestrictedQuerySet" } }`                         |
| `class ObjectType(Model):\n    objects = ObjectTypeManager()`           | `{ ObjectType: { objects: "ObjectTypeManager" } }`                    |
| `class MB(Model):\n    _objects_raw = TreeManager()`                    | `{ MB: { _objects_raw: "TreeManager" } }`                             |
| `class X(Model):\n    objects = Manager.from_queryset(RQS)()`           | `{ X: { objects: "RQS" } }`                                           |
| `class X(Model):\n    objects = models.Manager()`                       | **nothing** (`Manager` is not the class's own short name — see below) |
| `class X(Model):\n    name = CharField(max_length=1)`                   | **nothing** (no suffix match)                                         |
| `class X(Model):\n    objects = []`                                     | **nothing** (RHS not a call)                                          |
| `class X:\n    def f(self):\n        objects = Manager()`               | **nothing** (not a class BODY assignment)                             |
| `class Outer:\n    class Inner(Model):\n        objects = FooManager()` | `byClassKey["p.py::Outer.Inner"]`, not `Outer`                        |

      Plus: `dependencyManifest` naming no django ⇒ the walker emits nothing at
      all; a file with no manifest and no `django` import ⇒ nothing; the
      existing `self.x = Foo()` facts are UNCHANGED in both channels when the
      gate is on and when it is off.

- [ ] `walker/passes/python-class-body-fields.ts` — pure, no gate inside it.
      Mirrors `collectPythonClassFieldTypesByClassKey`'s scope walk so the two
      channels can never disagree about nesting, and returns BOTH maps from one
      pass (the colocation rule: every field of a structure populated in one
      place).

```ts
export interface PythonClassBodyFieldTypes {
  /** `shortClassName -> field -> typeName`, the per-file channel. */
  readonly byShortName: Record<string, Record<string, string>>;
  /** `<relPath>::<dotted class FQ> -> field -> typeName`, the run-global one. */
  readonly byClassKey: Record<string, Record<string, string>>;
}

/**
 * Manager and queryset attributes declared in a CLASS BODY (bd
 * tea-rags-mcp-9fgdi, E3 increment 1) — `objects = RestrictedQuerySet.as_manager()`
 * on `NetBoxModel`, `objects = ObjectTypeManager()` on `ObjectType`.
 *
 * The existing field collectors read `self.<field> = …` inside a method, which
 * is where Python binds INSTANCE state. A Django manager is bound in the class
 * body instead, so nothing read it and `Model.objects` was untyped on hop 1 of
 * the chain fold: 141 of netbox's 148 `chain` misses, all of them resolving on
 * the manager class's own method once the receiver is typed.
 *
 * Attribution is to the INNERMOST enclosing class, and the field name is taken
 * verbatim — netbox uses `objects` on 37 models and `_objects_raw` on one, and
 * nothing here special-cases either spelling.
 *
 * Deliberately silent on `objects = models.Manager()`: the RHS names Django's
 * own default manager, and a fact for it would make the chain fold DROP where
 * the call currently falls through to a later strategy. Absence keeps that path
 * byte-identical. The suffix test below is what declines it — `Manager` is
 * rejected because it is the SUFFIX itself and not a longer name ending in it.
 */
export function collectPythonClassBodyFieldTypes(
  root: AstNode,
  relPath: string,
  vocabularies: readonly PythonFrameworkVocabulary[],
): PythonClassBodyFieldTypes;
```

- [ ] The RHS reader, the one gate both maps share (the shape
      `pythonSelfFieldType` has in `walker.ts`). Three accepted forms, and the
      evidence differs per form:

```ts
/**
 * `<Name>.as_manager()` | `<Name>()` | `<Name>.from_queryset(<Q>)()` read off
 * ONE assignment node, or `undefined`.
 *
 * The evidence is the VERB where there is one and the NAME where there is not.
 * `as_manager` and `from_queryset` are Django's own spellings, so any CapWords
 * receiver in front of them is accepted. A plain construction `<Name>()` has no
 * verb, so the name carries the whole claim: its short name must END with a
 * `managerClassSuffixes` entry and be STRICTLY LONGER than it. That second
 * clause is what declines `models.Manager()` and `QuerySet()` — Django's own
 * classes, whose members the fold must not look for in the project.
 */
function pythonClassBodyFieldType(
  node: AstNode,
  vocabularies: readonly PythonFrameworkVocabulary[],
): { readonly field: string; readonly type: string } | undefined;
```

      Body outline, to be written against the tree-sitter-python grammar:
      accept `node.type === "assignment"`; require `left.type === "identifier"`
      (a class-body attribute; `self.x` and subscripts are other collectors');
      require `right.type === "call"`; then match the callee:

      1. callee is a `call` whose own callee is an `attribute` named by
         `querysetFactoryVerbs` ⇒ the type is the FIRST positional argument of
         the INNER call, when that argument is a CapWords identifier or dotted
         name (`Manager.from_queryset(RQS)()` ⇒ `RQS`).
      2. callee is an `attribute` whose attribute name is in
         `managerFactoryVerbs` ⇒ the type is `lastSegment(object.text)`, when
         that is CapWords (`RestrictedQuerySet.as_manager()` ⇒
         `RestrictedQuerySet`).
      3. callee is an `identifier` or `attribute` ⇒ take
         `lastSegment(callee.text)`; accept only when some vocabulary's
         `managerClassSuffixes` has an entry `s` with
         `name.endsWith(s) && name.length > s.length`.

      Everything else returns `undefined`. `vocabularies` is folded with
      `.some(...)`, never disjoined inline.

- [ ] Wire it into `walker.ts`. The gate is evaluated ONCE per file, right after
      `imports` is collected, and the facts merge INTO the existing channels so
      the MRO field walk needs no change at all:

```ts
// bd tea-rags-mcp-9fgdi (E3 increment 1) — Django binds a model's manager in
// the CLASS BODY (`objects = RestrictedQuerySet.as_manager()`), which no
// `self.<field>` collector can see. Gated per project by the dependency
// manifest, per file by its imports when there is no manifest, so a project
// that does not use the framework walks byte-identically.
const frameworks = pythonActiveFrameworks(input.dependencyManifest, imports);
const classBodyFields =
  frameworks.length === 0
    ? undefined
    : collectPythonClassBodyFieldTypes(
        input.tree.rootNode,
        input.relPath,
        frameworks,
      );
```

      then merge, AFTER the two existing collectors have run and BEFORE the
      emit-only-non-empty guards, with the class-body fact yielding to an
      explicit `self.<field>` one (a constructor assignment is the narrower
      statement about an instance):

```ts
for (const [key, fields] of Object.entries(
  classBodyFields?.byShortName ?? {},
)) {
  classFieldTypes[key] = { ...fields, ...(classFieldTypes[key] ?? {}) };
}
for (const [key, fields] of Object.entries(classBodyFields?.byClassKey ?? {})) {
  classFieldTypesByClassKey[key] = {
    ...fields,
    ...(classFieldTypesByClassKey[key] ?? {}),
  };
}
```

      Note the spread ORDER — the new facts go in FIRST so an existing
      `self.<field>` fact overwrites them. That keeps every pre-task answer
      exactly as it was.

- [ ] `PythonExtractInput` gains `dependencyManifest?: string`, forwarded from
      `WalkInput` by the same line that forwards `gemfileContent` in the Ruby
      walker. Python's `index.ts` composes its walker through
      `composeExtractionWalker`, so no pass signature changes.

- [ ] Turn the new test file GREEN. `npx tsc --noEmit` clean.
- [ ] **Row-level oracle A/B, five corpora.** BEFORE = the pre-task tree, same
      worker count; the dump drivers and diff script live under
      `/Users/artk0re/.claude/jobs/dffe3647/tmp/flask-lost/`, the headline
      analyzer under `/Users/artk0re/.claude/jobs/dffe3647/tmp/rf9/`. Expected,
      and each row is a gate:

| corpus | expected                                                                                                              |
| ------ | --------------------------------------------------------------------------------------------------------------------- |
| netbox | `chain` recall 0.403 → **≈0.97** (141 `missed` → `match`); phantom and wrongFile unchanged; `agreeExternal` unchanged |
| ugnest | **0 rows changed** — the canary (decision 4)                                                                          |
| polar  | 0 rows changed (no root manifest, no `django.` imports)                                                               |
| flask  | 0 rows changed                                                                                                        |
| httpx  | 0 rows changed                                                                                                        |

- [ ] **Gross `lost` 0.** Diff the row SETS, not the totals: every row whose
      BEFORE verdict was `match` must still be `match`, and no `agreeExternal`
      may become `phantom` or `wrongFile` on any corpus.
- [ ] **Chain-tally drift 0 on all five.** `edges` rises on netbox by the new
      answers; `chainDrift` must read 0.
- [ ] **Perf A/B on netbox**, two runs each side: wall ≤ +25 %, RSS ≤ +20 %. The
      scan is one extra pass over class bodies in files that already parse, so
      the expectation is inside noise.
- [ ] **Ruby parity 0** — `walker.ts` is Python's, but `WalkInput` is shared.
      Ruby walker and resolver suites green, no test edits.
- [ ] `npm run test:coverage` exit 0.
- [ ] Commit:
      `feat(language): type Django manager attributes from class-body assignments (9fgdi)`.

---

## Task 3 — The Django receiver vocabulary and the two fold arms

Zero measured recall (decision 2). It ships for edge density on the rows jedi
cannot score, and it carries the remove clause from decision 8. Task 2's recall
is already banked and this task must not move it.

**Files:**

- MOD `src/core/domains/language/python/resolver/frameworks/types.ts`
- MOD `src/core/domains/language/python/resolver/frameworks/django.ts`
- NEW `src/core/domains/language/python/resolver/python-django-type.ts`
- MOD `src/core/domains/language/python/resolver/python-receiver-type-ports.ts`
- MOD
  `src/core/domains/language/python/resolver/strategies/python-chain-type.ts`
- MOD `src/core/domains/language/python/resolver/strategies/shared.ts`
- MOD `src/core/domains/language/python/index.ts` (thread the manifest into the
  ports factory, the way `linearizers` and `mapper` are threaded)
- NEW
  `tests/core/domains/language/python/resolver/frameworks/django-vocabulary.test.ts`

**Interfaces:**

```ts
// frameworks/types.ts — four more facets on PythonFrameworkVocabulary
  /** `classAncestors` spellings that make a project class a queryset or manager. */
  readonly boundaryBases: ReadonlySet<string>;
  /** Members that return the SAME queryset type. */
  readonly fluentSelfMembers: ReadonlySet<string>;
  /** Members that return ONE instance of the manager's owning model. */
  readonly instanceTerminalMembers: ReadonlySet<string>;
  /** `fn(Cls, …)` returning an instance of its first positional class argument. */
  readonly positionalClassShortcuts: ReadonlySet<string>;

// python-django-type.ts
/** Separator for the manager-owner tag. Legal in no Python identifier or module path. */
export const PYTHON_TYPE_OWNER_SEPARATOR = "@";
/** `RestrictedQuerySet` + `Site` becomes `RestrictedQuerySet@Site`. */
export function pythonOwnedTypeName(type: string, owner: string): string;
/** `RestrictedQuerySet@Site` becomes `{ type: "RestrictedQuerySet", owner: "Site" }`. */
export function parsePythonOwnedTypeName(name: string): { type: string; owner?: string };
/** `RestrictedQuerySet@Site` becomes `RestrictedQuerySet`. The one strip funnel. */
export function pythonBareTypeName(name: string): string;
/** Does this project class reach a framework boundary base through its MRO? */
export function pythonTypeReachesFrameworkBoundary(
  typeName: string,
  ctx: CallContext,
  mapper: PythonImportFileMapper,
  linearizer: AncestorLinearizer<CallContext> | undefined,
  vocabularies: readonly PythonFrameworkVocabulary[],
): PythonFrameworkVocabulary | undefined;
```

**Steps:**

- [ ] Extend `frameworks/django.ts` with the four data facets. Each entry below
      was checked against Django's `QuerySet` and `Manager` API and against the
      24 built-in member names the netbox rows actually produce; the declines
      are decision 7's.

```ts
  // Members of a QuerySet that return the SAME queryset. `values` and
  // `values_list` are NOT here: they return dicts and tuples, and typing them as
  // self would hand a dict receiver a queryset's members (24 netbox rows would
  // flip the wrong way). `union` / `intersection` / `difference` ARE here — they
  // return a queryset of the same model.
  fluentSelfMembers: new Set([
    "filter", "exclude", "all", "order_by", "reverse", "distinct",
    "select_related", "prefetch_related", "annotate", "alias",
    "only", "defer", "using", "none", "union", "intersection", "difference",
  ]),
  // Members that return ONE model instance. `get_or_create` and
  // `update_or_create` are NOT here: they return an `(obj, created)` TUPLE, and
  // element typing is a mechanism this increment does not have (7 netbox rows).
  instanceTerminalMembers: new Set(["get", "first", "last", "create", "earliest", "latest"]),
  // A module-level helper returning an instance of its first positional class
  // argument. `get_list_or_404` is declined — it returns a LIST.
  positionalClassShortcuts: new Set(["get_object_or_404"]),
  // What makes a project class a queryset or a manager. The spellings are the
  // ones `qualifyPythonBase` writes; both the `from django.db import models` and
  // the `from django.db.models import QuerySet` import styles appear in netbox.
  boundaryBases: new Set([
    "django.db.models::QuerySet",
    "django.db.models::Manager",
    "django.db.models::BaseManager",
    "django.db.models.query::QuerySet",
    "django.db.models.manager::Manager",
    "django.db.models.manager::BaseManager",
  ]),
```

- [ ] `python-django-type.ts` — the owner tag and its one strip funnel. Decision
      9 is the rationale; restate it in the module doc, including the sentence
      the invariant depends on:

```ts
/**
 * A Python receiver type name may carry a manager-OWNER tag —
 * `RestrictedQuerySet@Site` — written by the Django fold arm so a terminal
 * member (`.get(…)`) can answer with the MODEL rather than the queryset.
 *
 * EVERY read that treats a type name as a CLASS name strips it here. There are
 * four: `chainType`'s `resolveTypeFile` guard and its
 * `resolvePythonMemberOnTypeThroughMro` call, `pythonInheritedMemberType`'s
 * own-class read, and `resolvePythonMemberOnType`. A fifth read added later
 * that forgets this will look up a class named `Foo@Bar` and answer nothing —
 * a silent miss, not a wrong edge, which is the failure direction this program
 * accepts.
 *
 * `@` is legal in neither a Python identifier nor a dotted module path, so a
 * tagged name cannot collide with an untagged one. Precedent: `::` in
 * `qualifyPythonBase`, `|` in `python-ancestor-policy.ts`, `<unresolvable>` in
 * the walker.
 */
```

      `pythonTypeReachesFrameworkBoundary` walks the type's C3 MRO with the
      linearizer already threaded into the ports and answers the first
      vocabulary whose `boundaryBases` one of the base spellings matches. Two
      clauses, because netbox produces both:

      - `RestrictedQuerySet(QuerySet)` ⇒ base spelling
        `django.db.models::QuerySet` ⇒ boundary reached, plainly.
      - `CustomFieldManager(models.Manager.from_queryset(RestrictedQuerySet))`
        ⇒ its ONLY base is `PYTHON_UNRESOLVABLE_BASE`, so no spelling can ever
        match. A computed base is answered by the second clause instead: the
        walk saw an unreadable base AND the class's own short name ends with a
        `managerClassSuffixes` entry (strictly longer than it, the Task 2 rule).
        That reuses a convention this plan has already committed to rather than
        inventing a second one, and it is what makes the DOMINANT netbox manager
        form — 4 of 9 classes — visible at all.

      A walk that reaches neither clause answers `undefined` and the fold's
      Django arms never fire, which is the pre-task behaviour. Memoise per
      `(classAncestors identity, typeName)`, following the `WeakMap` pattern
      `PythonNamingConventionSymbolResolutionStrategy.descendantsOf` uses, so
      the walk is paid once per type per run rather than per call site.

- [ ] Write
      `tests/core/domains/language/python/resolver/frameworks/django-vocabulary.test.ts`
      first, RED. Build a `CallContext` the way the neighbouring resolver tests
      build one, with `classAncestors`, `classFieldTypesByClassKey` and a symbol
      table, and assert:

      1. `Site.objects.restrict(user)` where `Site.objects` is
         `RestrictedQuerySet` and `RestrictedQuerySet(QuerySet)` declares
         `restrict` ⇒ `resolved(RestrictedQuerySet#restrict)`.
      2. `Site.objects.filter(x).restrict(user)` ⇒ same target — the fluent arm
         kept the type across `filter`.
      3. `Site.objects.filter(x).nonexistent()` ⇒ `DROP`, never `CONTINUE`.
      4. `Site.objects.values(x).restrict(user)` ⇒ `CONTINUE` (`values` is not
         fluent, the fold stops, nothing is claimed).
      5. `Site.objects.get(pk=1).save()` ⇒ resolves `save` on `Site`'s MRO —
         the terminal arm plus the owner tag.
      6. `ObjectType.objects.create(x)` where `create` is declared on
         `ObjectTypeQuerySet` but `ObjectType.objects` is `ObjectTypeManager()`
         ⇒ `DROP`. This is the measured precision case from decision 3.
      7. `ContentType.objects.get_for_model(m)` with no field fact on
         `ContentType` ⇒ `CONTINUE` (the fold never types hop 1).
      8. A project class `FooBar(QuerySet)` under a manifest naming no django
         ⇒ every arm silent.
      9. `pythonBareTypeName("RestrictedQuerySet@Site") === "RestrictedQuerySet"`,
         and an untagged name round-trips unchanged.

- [ ] Add the `memberTypeOf` arm in `python-receiver-type-ports.ts`, AFTER
      `pythonInheritedMemberType` answers `undefined` so nothing already
      answered can change:

```ts
const bare = pythonBareTypeName(recv.name);
const inherited = pythonInheritedMemberType(
  bare,
  member,
  recv.form,
  ctx,
  mapper,
  linearizer,
);
if (inherited !== undefined) {
  // The field read just answered. This is the ONE place that holds BOTH
  // halves — `bare` is the model, `inherited.name` the manager it declared —
  // so it is where the owner tag is attached and nowhere else.
  const owned = pythonTypeReachesFrameworkBoundary(
    inherited.name,
    ctx,
    mapper,
    linearizer,
    vocabularies,
  );
  return owned === undefined
    ? inherited
    : { form: "instance", name: pythonOwnedTypeName(inherited.name, bare) };
}
// The framework arm. A project queryset answers its OWN members through the
// walk above; this is only for the LIBRARY verbs, which no project class
// declares and which therefore reach here untyped.
const framework = pythonTypeReachesFrameworkBoundary(
  bare,
  ctx,
  mapper,
  linearizer,
  vocabularies,
);
if (framework === undefined) return undefined;
if (framework.fluentSelfMembers.has(member)) return recv; // same type, tag intact
if (framework.instanceTerminalMembers.has(member)) {
  const { owner } = parsePythonOwnedTypeName(recv.name);
  return owner === undefined ? undefined : { form: "instance", name: owner };
}
return undefined;
```

      Two properties of that shape are load-bearing. The tag is attached ONLY
      when the field's type is a framework queryset, so every non-Django field
      answer is byte-identical to Task 2's. And the fluent arm returns `recv`
      itself, tag and all, which is what carries the owner across
      `filter(…).exclude(…)` to the terminal member.

- [ ] Add the `singleHopType` arm for `positionalClassShortcuts`, before the
      existing `receiver.endsWith(")")` CapWords branch: strip the args, and if
      the callee is a shortcut entry, read the RECEIVER TEXT's first positional
      argument; when it is a CapWords name that `resolveTypeFile` places in the
      project, answer `{ form: "instance", name: that }`. Anything else falls
      through to the existing branch unchanged.
- [ ] Strip the owner tag at the four reads decision 9 names. Each is a
      one-token wrap: `pythonBareTypeName(type.name)` at
      `python-chain-type.ts`'s `resolveTypeFile` guard and its
      `resolvePythonMemberOnTypeThroughMro` call, and
      `pythonBareTypeName(bareType)` at the head of `pythonInheritedMemberType`
      and `resolvePythonMemberOnType` in `strategies/shared.ts`.
- [ ] Thread the manifest into the ports factory.
      `createPythonReceiverTypePorts` already closes over `mapper` and
      `linearizers`; the vocabularies are the third such run-scoped input. The
      resolver reads `ctx.dependencyManifest` per call and folds
      `pythonActiveFrameworks` behind a `Map` keyed by the manifest string, so
      the activation decision is one lookup per call site and zero allocations.

- [ ] Turn the new test file GREEN. `npx tsc --noEmit` clean.
- [ ] **Row-level oracle A/B, five corpora**, same protocol as Task 2. Expected:

| corpus              | expected                                                                                                                                                             |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| netbox              | recall UNCHANGED from Task 2 (no `missed` row is a D2/D3/D4 shape); `phantom` +0; `agreeExternal` unchanged on all 239 exposed rows; `chainOnly` rises by up to ~800 |
| ugnest              | **0 rows changed** — it declares no project queryset, so no boundary is ever reached                                                                                 |
| polar, flask, httpx | 0 rows changed                                                                                                                                                       |

- [ ] **Remove clause, evaluated here (decision 8).** Phantom up by more than
      +0.5 pp of edges on any corpus, or ugnest off phantom 0 ⇒ delete the
      offending ARM — `fluentSelfMembers`, `instanceTerminalMembers` or
      `positionalClassShortcuts` — and re-run. Do NOT tune the member sets. If
      `instanceTerminalMembers` goes, `python-django-type.ts` and the four strip
      sites go with it.
- [ ] **Chain-tally on all five**: `chainDrift` 0; report the `edges` delta per
      corpus, because on this task edges ARE the result.
- [ ] **Perf A/B on netbox**, two runs each side: wall ≤ +25 %, RSS ≤ +20 %. The
      boundary walk is memoised per type per run and the member sets are frozen
      `Set`s, so the added work is one `Set.has` per otherwise-unanswered hop.
- [ ] `npm run test:coverage` exit 0.
- [ ] Commit:
      `feat(language): resolve Django queryset verbs through a framework vocabulary (9fgdi)`.

---

## Task 4 — Gates, navigators, capability, and the next-increment record

**Files:**

- MOD `src/core/domains/language/python/capability.ts`
- MOD `.claude-plugin/tea-rags/rules/language-compatibility.md` (GENERATED)
- MOD `README.md` lang-compat block (GENERATED)
- MOD `src/core/domains/language/python/CLAUDE.md`
- MOD `src/core/domains/language/CLAUDE.md`
- MOD
  `docs/superpowers/specs/2026-09-03-python-codegraph-unification-program-design.md`
  (append the E3 increment-1 decision record)

**Steps:**

- [ ] **Walker version 4 → 5** (decision 10). In `python/capability.ts`, add to
      the comment block above `versions` and bump the integer:

```ts
  // walker 5: bd tea-rags-mcp-9fgdi (E3 increment 1) — CLASS-BODY assignments
  // now contribute to `classFieldTypes` / `classFieldTypesByClassKey`:
  // `objects = RestrictedQuerySet.as_manager()` types `Model.objects`. A file
  // walked by walker 4 carries no such field, so every `Model.objects.<m>()`
  // site in it stays untyped until the codegraph layer is recomputed.
  versions: { chunking: 1, walker: 5, codegraphSchema: 2 },
```

      Extend `codegraph.tech` with the two new mechanisms, in the same clause
      style the existing string uses: class-body manager attribute typing, and a
      dependency-manifest-gated Django receiver vocabulary. Then
      `npm run gen:lang-compat` and commit the regenerated rule file and README
      block alongside — the drift-guard test fails CI otherwise.

- [ ] **`python/CLAUDE.md`**, under "Walker — monolith and one type-fact pass",
      add the one invariant a green suite will not catch: the two field channels
      now have TWO sources with a fixed precedence, and the ordering is
      load-bearing.

```md
- Class-body assignments (`objects = <QS>.as_manager()`) feed the SAME two field
  channels as `self.<field> = …`, and they merge UNDERNEATH: a constructor
  assignment for the same field name wins. Reversing the spread order silently
  retypes every field a class declares twice.
- The class-body reader runs only when a framework vocabulary is active
  (`pythonActiveFrameworks`), which is a per-PROJECT decision from the
  dependency manifest with a per-FILE import fallback. A project with a manifest
  that does not name the framework is NEVER activated by its imports — a
  declared manifest is evidence in both directions.
```

- [ ] **`domains/language/CLAUDE.md`**, in the section that lists what the
      kernel owns, add one line for `kernel/dependency-manifest.ts`: it is the
      language-neutral manifest reader and memo, root-only by design, and it is
      where `gemfileContent` converges when Ruby is relocated. Link, do not
      restate, the resolver-architecture rule for the registry shape.

- [ ] **Record the next increment's measurement, so it is not re-derived.**
      Append to the program spec's "Decision records", verbatim:

      > **E3 increment 2 — SQLAlchemy and Pydantic on polar, measured
      > 2026-09-10 and NOT designed.** Same dumps as increment 1
      > (`final-polar.ndjson`). Every family is 100 % OUTSIDE the recall
      > denominator — zero `missed` rows — so the increment cannot raise recall
      > on this corpus and is edge-density work only.
      >
      > | family                                                 | missed | agreeExternal | bothUnresolved | total |
      > | ------------------------------------------------------ | ------ | ------------- | -------------- | ----- |
      > | SQLAlchemy `session` / `self.session` receiver          | 0      | 776           | 185            | 961   |
      > | SQLAlchemy `select(X)…` chain receiver                  | 0      | 875           | 51             | 926   |
      > | SQLAlchemy `.execute(…)` / `.scalars(…)` chain receiver | 0      | 129           | 68             | 197   |
      > | SQLAlchemy `statement` / `stmt` / `query` local         | 0      | 198           | 268            | 466   |
      > | **SQLAlchemy total**                                    | **0**  | 1,978         | 572            | 2,550 |
      > | Pydantic `model_validate` / `_json`                     | 0      | 116           | 4              | 120   |
      > | Pydantic `model_dump` / `_json`                         | 0      | 81            | 17             | 98    |
      > | Pydantic `model_copy`                                   | 0      | 5             | 0              | 5     |
      > | **Pydantic total**                                      | **0**  | 202           | 21             | 223   |
      >
      > polar's recall after seam 5 is `chain` 0.946, `localVar` 0.842,
      > `dynamic` 0.814, and decision 11 of the recall-frontier plan attributes
      > the residual to branch-bound receivers and `getattr` dispatch — not to
      > either framework. Two structural notes for whoever picks it up: polar
      > has **no root dependency manifest** (its manifests are
      > `server/pyproject.toml` and `sdk/python/pyproject.toml`), so the gate
      > falls back to per-file imports and increment 2 must either accept that
      > or teach the reader about nested roots; and 1,978 `agreeExternal` rows
      > are exposed to the phantom bar, which is nine times increment 1's
      > netbox exposure.

- [ ] `npm run test:coverage` exit 0; drift-guard green.
- [ ] Commit:
      `docs(language): record E3 increment 1 and the measured increment-2 baseline (9fgdi)`.

---

## Measurement record — what to fill in when the plan lands

The plan claims these and nothing else. Fill the AFTER column from the closing
A/B and put the numbers in the bead.

| corpus | kind       | n     | recall before | recall after (claimed) | recall after (measured) |
| ------ | ---------- | ----- | ------------- | ---------------------- | ----------------------- |
| netbox | `chain`    | 248   | 0.403         | ≈0.972                 |                         |
| netbox | `localVar` | 212   | 0.764         | 0.764 (unchanged)      |                         |
| netbox | `dynamic`  | 1,524 | 0.972         | 0.972 (unchanged)      |                         |
| netbox | `bareCall` | 5,051 | 0.997         | 0.997 (unchanged)      |                         |
| ugnest | all        | —     | —             | byte-identical         |                         |
| polar  | all        | —     | —             | byte-identical         |                         |
| flask  | all        | —     | —             | byte-identical         |                         |
| httpx  | all        | —     | —             | byte-identical         |                         |

Precision, every corpus: `phantom` and `wrongFile` counts unchanged after Task
2; after Task 3, phantom within +0.5 pp of edges and ugnest at exactly 0. Gross
`lost` 0 on every task.

## What this plan does NOT claim

- It does not move netbox `localVar` (0.764) or `dynamic` (0.972). Their misses
  are `cls` receivers, instance locals and iteration variables — measured, not
  assumed (decision 11).
- It does not touch polar, flask or httpx. Any non-zero delta there is a bug.
- It does not close the D2 / D3 / D4 families as RECALL. The oracle cannot score
  them; the only honest metric for those rows is edge count.
- It does not read nested dependency manifests, so a monorepo whose framework is
  declared one directory down falls back to per-file import evidence.
- It does not type `values()` / `values_list()` / `get_or_create()` results, or
  the element type of an iterated queryset. Those need container typing, which
  is a different mechanism and a different increment.
