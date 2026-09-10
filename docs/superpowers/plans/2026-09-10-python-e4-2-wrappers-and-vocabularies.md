# Python Frontier E4.2 — Wrappers and Framework Vocabularies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close D8's row 7 — `transparentWrapper` 9 recall rows, the 36
`untypedFieldHop` rows E4.6 routed here, and the 3,095 edge-density rows
(`sqlalchemyRow` 2,872 + `pydanticRow` 223) — and revive the two arms E3
deferred, beads `w205u.1` (dependency-manifest gate) and `w205u.2` (vocabulary
arms). The measured answer is asymmetric and this plan is shaped around that
asymmetry: **one table entry buys all 45 recall rows, and the three vocabulary
arms buy zero edges on all five corpora.** `Mapped` is the only wrapper name
missing from `PYTHON_TRANSPARENT_FIRST` — `Annotated`, `ClassVar`, `Final`,
`Required`, `NotRequired` and `InitVar` are already there, `Optional[T]` is
already a nilable union that `typeRefReceiverForm` collapses, and a forward-ref
string is already unquoted by `pythonTypeRefFromText`. Against that, every one
of polar's 2,850 SQLAlchemy rows and 223 pydantic rows is a call INTO the
library (`session.execute`, `stmt.where`, `select(X)`, `X.model_validate(d)`)
whose target is external and therefore is not an edge, and **zero** residual
rows on any corpus have a SQLAlchemy result or a pydantic factory result as
their receiver. The arms cannot gain an edge; they can only fabricate one.

**Measured addressable mass:** **45 recall rows, all polar** — 9
`transparentWrapper` (`self.tiers.calculate`,
`self.access_token_encrypted .decrypt`, `payout.status.is_cancelable`) plus the
36 `untypedFieldHop` `Mapped[T]` rows E4.6's decision 4 routed here. Every one
is a SQLAlchemy `Mapped[T]` class-body annotation whose inner type is a project
class; 27 of them are confirmed row-by-row against the oracle target (7 of 9 and
20 of 36 match the oracle's own class exactly, the remainder reach it through
the MRO). netbox, flask, httpx and ugnest contribute **0 recall rows** to this
increment. Edge-density gain, measured before design: **0** on `sqlalchemyRow`,
**0** on `pydanticRow`, **0** on the Django fluent and terminal arms, **21** on
the Django queryset-local shape — and those 21 need a receiver the vocabulary
cannot type, so they leave here as a named follow-up rather than as a task.

**Architecture:** Three moves, in strictly decreasing measured value. (1) One
name — `Mapped` — enters `PYTHON_TRANSPARENT_FIRST` and its bare form enters
`PYTHON_DECLINED_TYPE_NAMES`, exactly as `Annotated` / `ClassVar` / `Final`
already sit in both. No gate, no vocabulary, no framework knowledge: `Mapped[T]`
means "the value is a T" the way `ClassVar[T]` does, and the annotation source
already carries a class-body `x: T = …` into both field channels
(`python-type-annotation.ts`, `python-annotation-type-source.ts`,
`python-type-channels.ts`). (2) `WalkContext.gemfileContent` generalises into a
language-neutral `dependencyManifest` facility that reads `pyproject.toml`,
`requirements*.txt` and `setup.cfg` at the repo root **and one directory down**,
because polar has no root manifest at all and declares its whole stack in
`server/pyproject.toml`. Ruby's Gemfile becomes one instance of the facility and
its behaviour stays byte-identical. (3) A `PythonFrameworkVocabulary` registry
in the Ruby `defineFrameworkVocabulary` shape — a typed array, one module per
framework — gives the `memberTypeOf` fold a boundary predicate: when a receiver
type's MRO reaches a declared framework boundary class, an unrecognised member
DROPs at the boundary instead of continuing to `globalShortName`. The facets
that ship are the ones with a measured consumer; the ones that measured zero are
written down as declined, with their counts, rather than shipped dark.

**Tech Stack:** TypeScript (NodeNext, `strict`), vitest, tsx for the corpus
harnesses. No new dependency, no schema migration, no new payload key. Walker
version **STAYS 5** — the wrapper table is read at resolve time through the
annotation facet's existing channels and no extraction channel changes shape.
The manifest facility touches `contracts/types/language.ts`,
`contracts/types/codegraph-resolution.ts`, the chunker pool options and the
codegraph run state, which is why it carries a Ruby parity gate.

**Spec:** `docs/superpowers/specs/2026-09-10-python-frontier-e4-design.md` —
"E4.2 — transparent wrappers, SQLAlchemy, pydantic" (the sketch this plan
replaces with measurements), D8 row 7 (the execution-order table that puts this
increment last by recall mass), D9 (the precision audit and the +0.5 pp bar
E4.0.5 already had to defend), D10 (the falsified `single` component — the
standing evidence that a name-shaped guess fabricates on Python). The E3
deferrals it revives are
`docs/superpowers/plans/2026-09-10-python-django-managers.md` Task 1 and Task 3,
both marked DEFERRED → E4, and its sibling handoff is
`docs/superpowers/plans/2026-09-10-python-e4-6-typed-residuals.md` decision 4,
which routes 36 `untypedFieldHop` rows here and excludes them from its own gain
claim.

---

## Decision record

### 1 — The attribution, measured before anything was designed

Row dumps from the E4.0.4 family attribution
(`/Users/artk0re/.claude/jobs/dffe3647/tmp/e4-attr/final-*.ndjson`, five
corpora, `--oracle merged --dispatch`), re-tagged with the CURRENT
`scripts/lib/py-residual-families.ts` (post-`483b4cf9c`, which added
`PROXY_GLOBAL_RECEIVERS`) and with the corrected corpus roots — flask is
`~/Dev/OpenSource/codegraph-test/flask` and ugnest is
`~/Dev/Collaborate/ugnest`, neither of which lives under
`tea-rags-bench/corpora`, which is why the D8 table under-reads both corpora's
tier-2 families. Counts are ROWS.

**1a. `transparentWrapper` — 9 recall rows, every one a `Mapped[T]`.**

| corpus | recall | edge | wrapper spelling on the binding                           |
| ------ | ------ | ---- | --------------------------------------------------------- |
| polar  | **9**  | 68   | `Mapped` 54, `ClassVar` 8, `Annotated` 4, `NotRequired` 2 |
| flask  | 8      | 3    | none — all 8 are `LocalProxy` globals (decision 5)        |
| netbox | 0      | 3    | —                                                         |
| httpx  | 0      | 0    | —                                                         |
| ugnest | 0      | 0    | —                                                         |

All nine polar rows, opened at the declaring model:

| site                                  | receiver                  | annotation                              | oracle target                       |
| ------------------------------------- | ------------------------- | --------------------------------------- | ----------------------------------- |
| `backoffice/payouts/endpoints.py:403` | `payout.status`           | `status: Mapped[PayoutStatus]`          | `PayoutStatus#is_cancelable`        |
| `models/product_price.py:406`         | `self.tiers`              | `tiers: Mapped[Tiers]`                  | `Tiers#calculate`                   |
| `models/slack_app.py:97,102,107`      | `self.*_encrypted`        | `Mapped[EncryptedString \| None]`       | `EncryptedString#decrypt`           |
| `models/user.py:122,127`              | `self.*_token_encrypted`  | `Mapped[EncryptedString]` / `\| None`   | `EncryptedString#decrypt`           |
| `models/subscription.py:452`          | `self.meter_interval`     | `Mapped[MeterInterval \| None]`         | `RecurringInterval#get_next_period` |
| `models/subscription.py:588`          | `self.recurring_interval` | `Mapped[SubscriptionRecurringInterval]` | `RecurringInterval#get_next_period` |

Three shapes and all three already work once `Mapped` unwraps: a bare inner type
(`Mapped[Tiers]`), a nilable one (`Mapped[EncryptedString | None]` — the
`Optional` arm already builds a union and `typeRefReceiverForm` collapses it to
the single non-nil arm), and an inner type that reaches the oracle's class
through the MRO (`SubscriptionRecurringInterval` → `RecurringInterval`), which
`resolvePythonMemberOnTypeThroughMro` has answered since seam 4. **Seven of the
nine name the oracle's class outright; the other two reach it by inheritance.**

Where the annotation SITS matters and is measured: all nine are class-body
annotated assignments (`x: Mapped[T] = mapped_column(…)`), which
`pushAssignmentFact` already publishes as an `ivar` fact into BOTH
`classFieldTypes` and `classFieldTypesByClassKey`
(`python-type-channels.ts:57-75`). Not one is a parameter, a return type or a
dataclass `InitVar`. So the consumer path already exists end to end; the fact
being written today is simply the wrong one — `subscriptTypeRef` falls through
its whole table and answers `nominalTypeRef("Mapped")`, so the field is typed as
a class named `Mapped` that no project declares.

**1b. The 36 `untypedFieldHop` rows are the same shape, one file away.**

E4.6's decision 4 splits `untypedFieldHop` by sub-shape and routes
`obj.field / head annotated, field is Mapped[T]` — 36 rows, all polar — here.
They read as `untypedFieldHop` rather than `transparentWrapper` for a purely
instrumental reason: the classifier's `bindingLine` scans the CALLER's file
backwards, and a model's `Mapped[T]` declaration lives in `models/*.py` while
the call site is a service or an endpoint. Independently re-measured here: 51 of
polar's 82 residual `untypedFieldHop` rows have a receiver tail that SOME file
in the corpus declares as `Mapped[…]`, and **20 of them name the oracle's own
target class exactly**:

| site                                         | receiver                            | oracle target                        |
| -------------------------------------------- | ----------------------------------- | ------------------------------------ |
| `backoffice/benefits/endpoints.py:35,40`     | `item.type`                         | `BenefitType#get_display_name`       |
| `…/modals/delete_payout_account_modal.py:53` | `self.payout_account.type`          | `PayoutAccountType#get_display_name` |
| `billing_entry/service.py:237`               | `metered_price.meter.aggregation`   | `CountAggregation#is_summable`       |
| `checkout/service.py:1186,1271,2981,2998`    | `checkout.customer_billing_address` | `Address#has_address` / `#to_dict`   |

**The plan's headline is E4.6's 36**, because the two plans must not disagree
about a shared number; 20 is the floor this attribution can defend row by row
and 51 is the ceiling the name test allows. Nothing else in the 82 is a wrapper:
31 have a tail no file annotates with a subscript at all, and 8 are
`NotRequired[…]` TypedDict keys, which already unwrap.

### 2 — `sqlalchemyRow` and `pydanticRow` gain zero edges, and that is measured, not assumed

D8 books these two families as "0 recall / 3,095 edges" and the spec's bar for
the increment is `edgesGained`. **Both are oracle-scorable: no — edges + hand
sample.** So the number that decides whether the arms ship is not their row
count, it is how many of those rows would end in a call to a PROJECT member once
their receiver is typed. Measured on the polar dump, that number is **zero**,
and it is zero twice over.

**2a. The rows themselves are calls INTO the library.** polar's 2,850
`sqlalchemyRow` rows, by shape:

| shape                                                                  | rows      | what the call targets            |
| ---------------------------------------------------------------------- | --------- | -------------------------------- |
| `select(X)` and `select(X).where(…)` / `.order_by(…)` / `.join(…)` …   | **1,407** | `sqlalchemy.sql::Select` methods |
| `session.execute(stmt)`                                                | 414       | `AsyncSession#execute`           |
| `stmt.where(…)` on a bound local                                       | 354       | `Select#where`                   |
| `session.add` / `flush` / `commit` / `scalar` / `refresh` / `delete` … | 675       | `AsyncSession` methods           |

Verdicts across the 2,850: 2,258 `agreeExternal`, 592 `bothUnresolved`, **0
residual**. The member of every row is a SQLAlchemy verb (`where` 799, `select`
481, `execute` 414, `add` 215, `join` 140, `flush` 126 …). Typing the receiver
as `Select[X]` or `Session` names an EXTERNAL owner for the member, and the
codegraph persists in-project edges only — so a fully correct fold over all
2,850 rows adds **0 edges** and leaves 2,258 `agreeExternal` rows exactly where
they are. Any edge it did produce would be a phantom by construction.

pydantic is the same picture at 1/13 the size: 223 rows, members
`model_validate` 114, `model_dump` 89, `model_dump_json` 9,
`model_validate_json` 6, `model_copy` 5; verdicts 197 `agreeExternal` + 26
`bothUnresolved`, 0 residual. `AccountCreditSchema.model_validate(credit)`
targets pydantic's own `BaseModel.model_validate`, not a project def.

**2b. The chain CONTINUATION the arms exist to serve does not occur.** The
interesting shape is not `session.execute(stmt)` — it is
`session.get(Order, id).mark_paid()`, where typing the library call's RESULT
reaches a project member. Counted directly over polar's whole dump, rows whose
receiver TEXT is a SQLAlchemy result or statement expression
(`session.execute(…)`, `.scalars()`, `.scalar_one()`, `select(…)`, `.unique()`):
**1,222 rows, of which 0 are residual** — 833 `agreeExternal`, 389
`bothUnresolved`, not one `missed` / `fileOnly` / `wrongFile`. Rows whose
receiver is a pydantic factory result (`X.model_validate(d).…`): **5 rows, 0
residual.** There is no population to gain.

The conclusion this plan encodes: `frameworks/sqlalchemy.ts` ships
`boundaryClasses` and NOTHING ELSE, and `frameworks/pydantic.ts` ships
`boundaryClasses` plus the one `classFactories` entry that is type-correct by
definition (`X.model_validate(d)` IS an `X`) and whose blast radius is 5 rows.
No `fluentSelfMembers` and no `instanceTerminalMembers` for either. A facet with
no consumer is not shipped dark; it is written down here with its count.

### 3 — The Django arms: 0 fluent, 0 terminal, 21 queryset-local that need a different mechanism

E3's D2/D3/D4 counted the receiver SHAPES (fluent 194 `agreeExternal` / 443
`bothUnresolved`, terminal 4 / 15, queryset-locals 41 / 348). What E4.2 needs is
narrower: how many of those rows END in a call to a member a project QuerySet or
Manager class actually declares — everything else DROPs at the boundary and
changes nothing. netbox declares 22 such classes with 34 custom verbs
(`restrict`, `valid_models`, `unread`, `annotate_config_context_data`,
`get_for_site`, `get_for_model`, `with_feature`, `public`, …) and exactly ONE
Django-name override (`create`). Measured over the whole netbox dump:

| arm                                                                   | rows | member is a project queryset/model verb | verdicts of those                      |
| --------------------------------------------------------------------- | ---- | --------------------------------------- | -------------------------------------- |
| fluent — `X.objects.<django verb>(…).<m>()`                           | 546  | **0**                                   | —                                      |
| terminal — `X.objects.get/first/create(…).<m>()`, `get_object_or_404` | 1    | **0**                                   | —                                      |
| queryset-local — `queryset.<m>()` / `self.queryset.<m>()`             | 381  | **21**                                  | 21 `bothUnresolved`, 0 `agreeExternal` |

The fluent and terminal arms have no measured consumer on the one corpus that
carries Django. This corroborates E3's decision 3 from the other direction: E3
showed that no netbox project QuerySet declares a Django built-in, so the fold
would DROP; this shows that no fluent chain ends in a project verb, so the fold
has nothing to carry. Both arms are precision-safe AND worthless.

The 21 queryset-local rows are real and they are all `bothUnresolved`, so
answering them is edge density with zero phantom exposure. They split 12 bare
`queryset` (a filterset method PARAMETER —
`def filter_x(self, queryset, name, value)`) and 9 `self.queryset` (a Django/DRF
view class attribute, five of them the two-hop
`self.queryset.model.objects.restrict(…)`). Neither is answerable by a member
vocabulary: the blocker is TYPING the receiver, which needs a class-body RHS arm
for `queryset = <Model>.objects.<verb>()` — a shape E3's
`pythonClassBodyFieldType` deliberately declines — plus a `.model` hop from a
queryset back to its model class. That is a different mechanism with its own
precision argument, and it leaves this plan as follow-up bead `w205u.2b` with
these counts attached rather than being smuggled into a vocabulary facet.

### 4 — Manifest presence across the five corpora, re-measured with NESTED reading

E3's decision 5 read the ROOT only and recorded polar as ungated. Re-measured
here at the root AND one directory down, with the real corpus roots:

| corpus | manifest files found (root, then depth 1)                                                                              | declares                                                                    | django | sqlalchemy | pydantic |
| ------ | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------ | ---------- | -------- |
| netbox | `pyproject.toml` (`dynamic = [… "dependencies"]`), `requirements.txt`                                                  | `Django==6.0.8`, `djangorestframework`, 14 `django-*` distractors           | **on** | off        | off      |
| ugnest | `pyproject.toml` (`dependencies = ["django>=6.0.3", …]`), `requirements.txt` (`Django==6.0.3`), `requirements-dev.txt` | `django` twice, two spellings                                               | **on** | off        | off      |
| flask  | `pyproject.toml`                                                                                                       | blinker, click, itsdangerous, jinja2, markupsafe, werkzeug                  | off    | off        | off      |
| httpx  | `pyproject.toml`, `requirements.txt`                                                                                   | certifi, httpcore, anyio, idna                                              | off    | off        | off      |
| polar  | **no root manifest**; `server/pyproject.toml` at depth 1                                                               | `fastapi`, `sqlalchemy[asyncio]`, `pydantic`, `pydantic-settings`, `stripe` | off    | **on**     | **on**   |

Four facts the parser must respect, each from a corpus that produces it.
**netbox's `pyproject.toml` names Django NOWHERE** —
`dynamic = ["version", "dependencies"]` — so `requirements*.txt` is not an
optional extra, it is the only place netbox declares its framework. **The token
is spelled `Django`**, so the match is case-insensitive. **The match is EXACT
after PEP 503 normalisation**: `django-cors-headers`, `django-filter`,
`django-mptt`, `djangorestframework` and eleven more normalise to themselves and
must not satisfy a `django` gate. And **extras are stripped**: polar writes
`sqlalchemy[asyncio]>=2.0.51`.

`polar/sdk/python/pyproject.toml` is at depth 2 and the bounded scan does NOT
reach it. That is deliberate and it costs nothing measurable: polar's SQLAlchemy
and pydantic declarations are already in `server/pyproject.toml`, and the sdk
subtree declares the same `pydantic`. Widening the scan is a per-directory
nearest-manifest walk, which is more machinery than any measured row needs.

**The gate's measured value is a NEGATIVE one, and it is real.** flask's 18 and
httpx's 1 `sqlalchemyRow` rows are classifier false positives — flask's
`session` proxy and a `sqlite3` connection bound to `db`, matched by
`SQLALCHEMY_RECEIVERS`. On a corpus whose manifest names no SQLAlchemy, a gated
vocabulary can never look at them. That is the whole point of shipping the gate
even when the arms behind it are thin: it is the mechanism that keeps a
framework's grammar off a project that does not use it, and E4.3 needs it before
it can add DRF or Celery.

### 5 — flask's 8 `LocalProxy` rows are in the family and are NOT in this plan

The current classifier books `current_app` / `g` / `request` / `session` as
`transparentWrapper` (`PROXY_GLOBAL_RECEIVERS`, `483b4cf9c`), so with flask's
corrected root the family reads 9 polar + 8 flask. The 8 are
`current_app.url_for` / `make_response` / `ensure_sync` / `open_resource` /
`make_shell_context` and `g.pop`, oracle-targeted at `Flask#…` and
`_AppCtxGlobals#pop` — real in-project misses.

They are declined here because they are a different mechanism with a bigger
cost. `src/flask/globals.py:44` reads `current_app: FlaskProxy = LocalProxy(…)`
at MODULE level, and `pushAssignmentFact` drops a module-level annotated
assignment outright ("Module level has no channel that reads it") — there is no
`classFieldTypesByClassKey` analogue for a module global. Answering them needs a
NEW extraction channel plus a resolver read, and then a second hop: `FlaskProxy`
is declared under `if t.TYPE_CHECKING:` as
`class FlaskProxy(ProxyMixin[Flask], Flask): …`, so the MRO walk has to reach
`Flask` through a conditional class. Eight rows on one corpus do not buy a new
channel and a walker version bump. Recorded as bead `w205u.2c` with this
paragraph as its statement of work; E4.6's own decision 4 lists the same 8 rows
as declined, so neither plan claims them.

### 6 — The owner tag is NOT built, because its only consumer measures zero

E3's Task 3 designed a `RestrictedQuerySet@Site` type-name tag so a terminal
member (`.get(…)`) could answer with the MODEL rather than the queryset, plus
`pythonBareTypeName` and a four-site strip funnel to keep every class lookup
honest. The tag exists for exactly one facet, `instanceTerminalMembers`, and
decision 3 measured that facet at **1 row on netbox, 0 of them targeting a
project model verb**.

So the answer to "the `@`-tag or a cleaner facet" is **neither**: no tag, no
`python-django-type.ts`, no strip funnel, no fifth-read hazard.
`fluentSelfMembers` needs no owner because it returns the receiver ref
unchanged, and that is the only self-typing facet that ships. If a corpus ever
produces terminal rows, the tag is re-derivable from E3's design in an hour —
and it will then arrive with a measured consumer instead of ahead of one. This
is the single largest simplification the attribution bought: it removes a
cross-cutting representation change from four resolver reads.

### 7 — Precision: every answer is a project symbolId or DROP

Unchanged from E3 decision 8 and the spec's E4.2 bar, restated with this
increment's exposure. ugnest is the canary — its manifest declares Django, so
the vocabulary ACTIVATES there, and its phantom count must stay **0**. polar has
**1,978 `agreeExternal` rows** exposed to a flip and is where the wrapper change
lands, so its `agreeExternal` column is read explicitly per corpus. The cap is
**+0.5 pp of edges** on any corpus.

Two structural reasons the wrapper change cannot fabricate. It only ever
REPLACES a type name that no project declares (`Mapped`) with the inner one, so
a site that resolves today keeps resolving to the same target — the only way an
edge appears is if the inner type is a project class DECLARING the member, which
is the definition of a correct answer. And it changes nothing when the inner
type is external: `Mapped[datetime | None]` becomes `datetime`, which no project
file declares, so the fold stops exactly where it stops today. That is 33 of
polar's 68 edge rows, measured — they stay `agreeExternal` and the plan predicts
so up front, rather than reading a flat column as a broken build.

**Per-arm remove clauses, evaluated at Task E4.2d.** Phantom up by more than
+0.5 pp of edges on any corpus, or ugnest off phantom 0, ⇒ delete the offending
ARM and re-run: the wrapper table entry, `boundaryClasses`, `fluentSelfMembers`
or `classFactories`, whichever the A/B implicates. Do NOT tune the member sets.

### 8 — What is oracle-scorable and what is not, per shape

| shape                            | rows         | oracle-scorable          | the gate                                    |
| -------------------------------- | ------------ | ------------------------ | ------------------------------------------- |
| `transparentWrapper` `Mapped[T]` | 9 (polar)    | **yes**                  | `missed` → `match` in the row-level A/B     |
| `untypedFieldHop` `Mapped[T]`    | 36 (polar)   | **yes**                  | same A/B; E4.6 excludes them from its claim |
| `transparentWrapper` edge rows   | 68 (polar)   | no — edges + hand sample | `edges` delta + `agreeExternal` flat        |
| `sqlalchemyRow`                  | 2,872        | no — edges + hand sample | `edges` delta, predicted 0                  |
| `pydanticRow`                    | 223          | no — edges + hand sample | `edges` delta, predicted 0                  |
| Django fluent / terminal         | 547 (netbox) | no — edges + hand sample | `edges` delta, predicted 0                  |
| Django queryset-local            | 21 (netbox)  | no — edges + hand sample | not in this plan (bead `w205u.2b`)          |

The oracle says `agreeExternal` for `.scalars()` and for `session.execute` —
that is agreement about an EXTERNAL target, not recall, and it can never become
a `match`. So the only honest gate for every non-recall shape is the pair
"`edges` before → after" plus a **50-row manual precision sample of the NEW
edges**, opened and classified correct/incorrect, with a bar of **≥ 96 %
correct**. Task E4.2d owns that sample. If the increment produces fewer than 50
new edges — which decisions 2 and 3 predict — the sample is the WHOLE new-edge
set and the bar is 100 % of it, stated as such rather than quietly waived.

---

## Global Constraints

- **TDD, every task.** Write the failing test first, watch it fail for the right
  reason, then implement. Existing tests are never rewritten to fit a change —
  moving one is fine, rewriting the assertion is not
  (`.claude/rules/test-invariants.md`).
- **A/B ×5 per task**, `--oracle merged --dispatch --workers 8`, all five
  corpora, BEFORE and AFTER, row dumps kept. The A side is re-measured at the
  task's own base commit; a stale A side is not a baseline.
- **Chain tally ×5 per task**, `chainDrift` 0 and `dispatchDrift` 0. Report the
  `edges` delta per corpus explicitly — on E4.2c edges ARE the result.
- **Perf A/B on netbox AND polar**, two runs each side: wall ≤ +25 %, RSS ≤ +20
  %. polar is in the perf gate because it is where the wrapper fires.
- **Ruby parity 0.** `npx vitest run tests/core/domains/language/ruby` green
  with no test edits, and the chain tally on mastodon (`--lang ruby`) → `edges`
  / `fileOnly` / `unresolved` byte-identical. Ruby is byte-identical everywhere
  EXCEPT the Gemfile-to-manifest adapter in Task E4.2b, whose whole contract is
  that it is byte-identical too.
- **Walker version STAYS 5.** No extraction channel changes shape in this plan.
  A task that finds itself needing a channel has left this plan's scope — stop
  and say so.
- **`npx tsc --noEmit` clean and `npm run test:coverage` exit 0** at every task
  boundary. Coverage below threshold ⇒ delegate to `coverage-expander`
  (`subagent_type: "coverage-expander"`, `run_in_background: true`), never
  inline tests and never a lowered threshold.
- **One fresh Opus executor per task.** Tasks are ordered by measured value and
  E4.2a is independently shippable — it must not wait on anything below it.
- **Tool calls ≤ 8 min; writes ≤ 120 lines per call.** A corpus A/B is a
  background job, not a foreground wait.
- **Commits:** `type(scope): subject (w205u)` with the trailer
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and no other
  trailer. Commit on the worktree branch only; never merge and never push.
- **No `bd` from inside the worktree** — the redirect hook makes it a trap. Bead
  updates are the parent session's.

---

## File Structure

All paths relative to the repo root. `MOD` = modified, `NEW` = created.

| path                                                                                         |     | what changes                                          |
| -------------------------------------------------------------------------------------------- | --- | ----------------------------------------------------- |
| `src/core/contracts/types/language.ts`                                                       | MOD | `dependencyManifest` on `WalkInput` and `WalkContext` |
| `src/core/contracts/types/codegraph-resolution.ts`                                           | MOD | `dependencyManifest` on `CallContext`                 |
| `src/core/domains/language/kernel/dependency-manifest.ts`                                    | NEW | bounded nested read, PEP 503 parse, content memo      |
| `src/core/domains/language/kernel/extraction-passes.ts`                                      | MOD | `toWalkContext`: one more absent-key `if`             |
| `src/core/domains/language/python/walker/passes/python-type-annotation.ts`                   | MOD | `Mapped` into the two frozen sets                     |
| `src/core/domains/language/python/resolver/frameworks/types.ts`                              | NEW | `PythonFrameworkVocabulary` facet contract            |
| `src/core/domains/language/python/resolver/frameworks/define-framework-vocabulary.ts`        | NEW | the factory, Ruby's shape                             |
| `src/core/domains/language/python/resolver/frameworks/django.ts`                             | NEW | `boundaryClasses` + `fluentSelfMembers`               |
| `src/core/domains/language/python/resolver/frameworks/sqlalchemy.ts`                         | NEW | `boundaryClasses` only (decision 2)                   |
| `src/core/domains/language/python/resolver/frameworks/pydantic.ts`                           | NEW | `boundaryClasses` + one `classFactories` entry        |
| `src/core/domains/language/python/resolver/frameworks/index.ts`                              | NEW | `PYTHON_FRAMEWORKS` array + `pythonActiveFrameworks`  |
| `src/core/domains/language/python/resolver/python-receiver-type-ports.ts`                    | MOD | the boundary arm in `memberTypeOf`                    |
| `src/core/domains/language/python/resolver/strategies/shared.ts`                             | MOD | export `pythonReceiverClassKey` (no second copy)      |
| `src/core/domains/language/python/resolver/strategies/python-chain-type.ts`                  | MOD | DROP instead of CONTINUE at a framework boundary      |
| `src/core/domains/language/python/resolver/python-resolver.ts`                               | MOD | thread the vocabularies into the ports factory        |
| `src/core/domains/language/python/index.ts`                                                  | MOD | thread the manifest through the composition           |
| `src/core/domains/trajectory/codegraph/symbols/run-state.ts`                                 | MOD | `loadDependencyManifest` + four resets                |
| `src/core/domains/trajectory/codegraph/symbols/provider.ts`                                  | MOD | three load calls, one walk attachment                 |
| `src/core/domains/trajectory/codegraph/symbols/resolution-runner.ts`                         | MOD | two `CallContext` attachments                         |
| `src/core/domains/ingest/pipeline/base.ts`                                                   | MOD | read once, pass into the chunker pool options         |
| `src/core/domains/ingest/pipeline/chunker/infra/worker.ts`                                   | MOD | one option field, threaded to `walker.walk`           |
| `tests/core/domains/language/kernel/dependency-manifest.test.ts`                             | NEW | the parser's whole surface                            |
| `tests/core/domains/language/python/walker/passes/python-type-annotation.test.ts`            | MOD | the `Mapped` rows                                     |
| `tests/core/domains/language/python/resolver/frameworks/python-framework-vocabulary.test.ts` | NEW | activation + boundary + fold                          |
| `scripts/ts-codegraph-typechecker-oracle.ts`                                                 | MOD | fifth parameter, threaded to `walk`                   |
| `scripts/codegraph-chain-tally.ts`                                                           | MOD | read once, thread to extract and to the call context  |
| `scripts/py-codegraph-jedi-oracle.ts`                                                        | MOD | the same, rooted at `corpusRoot`                      |

---

## Context the implementer needs

### The wrapper table, exactly as it stands

`python-type-annotation.ts` holds ONE subscript rule table read by both entry
points (`pythonTypeRefFromNode` for a subtree, `pythonTypeRefFromText` for a
forward reference or a docstring type). Its order is: `Optional` → nilable
union; `Union` → union; `Type`/`type` → class form; `PYTHON_OPAQUE_GENERICS`
(`Callable`, `Literal`) → undefined; `PYTHON_TRANSPARENT_FIRST` → first
argument; `PYTHON_TRANSPARENT_LAST` (`Coroutine`) → last argument;
`PYTHON_CONTAINER_FIRST` → `container(first)`; `PYTHON_CONTAINER_LAST` →
`container(last)`; then the fallthrough `nominalTypeRef(base)` — "an unknown
generic base keeps the BASE as the receiver". `Mapped[Tiers]` takes that last
branch today and produces `instance Mapped`, a class no project declares.

`PYTHON_TRANSPARENT_FIRST` already contains `ClassVar`, `Final`, `Annotated`,
`Awaitable`, `Required`, `NotRequired` and `InitVar`.
`PYTHON_DECLINED_TYPE_NAMES` already contains the BARE forms of `Optional`,
`Union`, `Type`, `Literal`, `Callable`, `Annotated`, `ClassVar` and `Final` — an
un-subscripted wrapper name must never become a receiver. `Mapped` is missing
from both sets and from nothing else.

Forward references need no work. `pythonTypeRefFromText` strips a WHOLE-string
literal before parsing, and `pythonTypeRefFromNode`'s `case "string"` hands the
quoted text to it — so `Mapped["Customer"]` reaches `subscriptTypeRef` with its
argument already resolved to `instance Customer`, and `Mapped[list["Order"]]`
reaches it as `container(instance Order)`, which the container rule and RF.7's
element rule already consume. Nothing in this plan re-implements either.

### Where a class-body `Mapped[T]` becomes a resolvable fact

Three hops, all already built, which is why the change is one line of data:

1. `pythonAnnotationTypeSource.extract` → `pushAssignmentFact` sees the
   annotated assignment. Class body, identifier LHS, `site.methodName` undefined
   and `classChain.length > 0` ⇒ an `ivar` fact whose type is
   `pythonNominalReceiverName(ref)` — the COLLAPSED nominal name, which is why
   `Mapped[X | None]` has to collapse rather than stay a union. It does:
   `typeRefReceiverForm` returns the single non-nil arm.
2. `pythonTypeChannels` splits `ivarTypes` into `classFieldTypes` (per file, by
   class SHORT name) and `classFieldTypesByClassKey`
   (`<relPath>::<dotted class FQ>`), the run-global address the MRO fold reads.
3. `pythonInheritedMemberType` answers `memberTypeOf` from the class-key channel
   for the receiver's own class AND every ancestor the C3 linearizer returns,
   then `resolvePythonMemberOnTypeThroughMro` resolves the member on that type.

Hop 3 is what carries `Mapped[SubscriptionRecurringInterval]` to
`RecurringInterval#get_next_period` without this plan touching inheritance.

### The Gemfile precedent, end to end, with the real line numbers

| layer             | Ruby today                                                                   | Python equivalent to build                                   |
| ----------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------ |
| contract, walk    | `WalkInput.gemfileContent` (`language.ts:454`), `WalkContext` (`:248`)       | `dependencyManifest` on both                                 |
| contract, resolve | `CallContext.gemfileContent` (`codegraph-resolution.ts:325`)                 | `CallContext.dependencyManifest`                             |
| projection        | `toWalkContext` (`kernel/extraction-passes.ts:73`)                           | the same function, one more `if`                             |
| resolve root      | `CodegraphRunState.loadGemfile` (`run-state.ts:678`), field at `:593`        | `loadDependencyManifest`, same one-per-run guard             |
| resets            | `run-state.ts:990`, `:1074`, `:1152`, `:1191`                                | reset BOTH new fields at all four                            |
| load calls        | `provider.ts:964`, `:1159`, `:1192`                                          | one call each, beside                                        |
| attach            | `resolution-runner.ts:317`, `:464`; `provider.ts:1760`                       | one attachment each, beside                                  |
| chunker root      | `IndexingPipelineBase#createChunkerPool` (`pipeline/base.ts:337`, `:349`)    | read once, pass into the pool options                        |
| worker            | `worker.ts:73` (options), `:98`, `:142` (`walker.walk`)                      | one field, threaded the same way                             |
| parse + memo      | `catalogueForGemfile` (`ruby/gemfile.ts:64`), `Map` keyed by CONTENT         | `dependencyNamesOf`, `Map` keyed by content                  |
| activation        | `filterActiveFrameworks` + `activatedBy` (`dsl/catalogue.ts`)                | `pythonActiveFrameworks`, same intersect-or-unconditional    |
| registry          | `FRAMEWORKS` array + `defineFrameworkVocabulary` (`dsl/framework-module.ts`) | `PYTHON_FRAMEWORKS` + `definePythonFrameworkVocabulary`      |
| harnesses         | not threaded                                                                 | `extractFile(…, manifest)` + `buildCallContext(…, manifest)` |

### How an external base is spelled

`collectPythonClassAncestors` → `qualifyPythonBase` writes
`<moduleText>::<ClassName>`, so the spelling depends on the IMPORT style and the
boundary set has to carry both: `from django.db.models import QuerySet` plus
`class X(QuerySet)` gives `django.db.models::QuerySet`, while
`from django.db import models` plus `class X(models.Manager)` gives
`django.db.models::Manager`. A computed base (`Manager.from_queryset(QS)`) is
`PYTHON_UNRESOLVABLE_BASE` (`"<unresolvable>"`, `walker/walker.ts:521`), which
`python-ancestor-policy.ts:188` answers as `UNKNOWN_BASE`. The boundary
predicate treats it as "keep walking the other bases", NEVER as "this is not a
boundary type".

---

## Task E4.2a — `Mapped[T]` is a transparent wrapper

The whole recall of this increment: 45 polar rows, 0 elsewhere. It ships ALONE,
before anything else in this plan, and its A/B is read on its own.

**Files:**

- MOD `src/core/domains/language/python/walker/passes/python-type-annotation.ts`
- MOD
  `tests/core/domains/language/python/walker/passes/python-type-annotation.test.ts`
- MOD
  `tests/core/domains/language/python/walker/passes/python-annotation-type-source.test.ts`

**Interfaces:** none. Two frozen `Set`s gain one member each; no signature, no
export and no channel changes.

**Steps:**

- [ ] Add the RED rows to
      `tests/core/domains/language/python/walker/passes/python-type-annotation.test.ts`,
      in the table the neighbouring subscript cases already use, asserting
      through `pythonTypeRefFromText` (the text entry point is the cheaper one
      and shares the rule table with the node entry point):

```ts
    // SQLAlchemy's `Mapped[T]` is transparent: the column's VALUE is a T, and a
    // receiver typed `Mapped` names a class no project declares (bd w205u, E4.2).
    ["Mapped[Tiers]", { form: "instance", name: "Tiers" }],
    ["Mapped[EncryptedString | None]", typeRefUnionOf([{ form: "instance", name: "EncryptedString" }, NIL_TYPE_REF])],
    ["Mapped[list[Order]]", { form: "container", element: { form: "instance", name: "Order" } }],
    ['Mapped["Customer"]', { form: "instance", name: "Customer" }],
    ["Mapped[dict[str, Address]]", { form: "container", element: { form: "instance", name: "Address" } }],
    ["Mapped[datetime]", { form: "instance", name: "datetime" }],
    // The BARE wrapper names no receiver, exactly as bare `Annotated` does.
    ["Mapped", undefined],
```

- [ ] Add one RED row asserting the collapse the `ivar` channel depends on:
      `pythonNominalReceiverName(pythonTypeRefFromText("Mapped[EncryptedString | None]") as TypeRef)`
      is `"EncryptedString"`. This is the property that makes
      `slack_app.py:97`'s `Mapped[EncryptedString | None]` resolvable at all,
      and it is worth pinning separately from the ref shape.
- [ ] Run the file. Every new row must FAIL, and the `Mapped[Tiers]` row must
      fail with `{ form: "instance", name: "Mapped" }` — the fallthrough branch.
      A different failure means the table order changed and the rest of this
      task's reasoning needs re-checking before continuing.
- [ ] Add `"Mapped"` to `PYTHON_TRANSPARENT_FIRST` in
      `python-type-annotation.ts`, and extend that set's doc comment:

```ts
/** Subscripted forms whose argument IS the answer — the wrapper is transparent. */
const PYTHON_TRANSPARENT_FIRST: ReadonlySet<string> = new Set([
  "ClassVar",
  "Final",
  "Annotated",
  "Awaitable",
  "Required",
  "NotRequired",
  "InitVar",
  // SQLAlchemy 2.0's declarative column type. LANGUAGE-level here rather than
  // framework-level: `Mapped[T]` states "this attribute holds a T" the way
  // `ClassVar[T]` does, no manifest gate decides whether that is true, and every
  // one of polar's 45 measured rows is a class-body `x: Mapped[T] = mapped_column(…)`
  // whose inner type is a project class (bd tea-rags-mcp-w205u, E4.2a).
  "Mapped",
]);
```

- [ ] Add `"Mapped"` to `PYTHON_DECLINED_TYPE_NAMES`, in the block that already
      holds the bare constructors:

```ts
  // Bare, un-subscripted forms of the constructors handled structurally below.
  "Optional",
  "Union",
  "Type",
  "Literal",
  "Callable",
  "Annotated",
  "ClassVar",
  "Final",
  "Mapped",
```

- [ ] Delete the now-false sentence from the module doc — the header still says
      "Unwrapping a framework wrapper (SQLAlchemy `Mapped[Foo]`) is E3's job,
      driven by manifest-gated data rather than by a guess here." Replace that
      third bullet's last two sentences with:

```
 *     An unknown generic base keeps the BASE as the receiver — `QuerySet[Foo]`
 *     is a `QuerySet`, and that is the honest reading of the annotation.
 *     `Mapped[Foo]` is NOT such a case and sits in the transparent set instead:
 *     it is a declarative column wrapper, the value IS the `Foo`, and E4.2
 *     measured all 45 of its rows as class-body annotations whose inner type is
 *     a project class. No manifest gates it — the annotation says it outright.
```

- [ ] Turn the test file GREEN. `npx tsc --noEmit` clean.
- [ ] Add one integration row to `python-annotation-type-source.test.ts`: a
      class body containing `tiers: Mapped[Tiers] = mapped_column(JSONB)` emits
      ONE `ivar` fact named `tiers` with type `Tiers` — the end-to-end proof
      that the table entry reaches the channel a resolver reads, not just the
      ref algebra.
- [ ] `npm run test:coverage` exit 0. No other file has been touched.
- [ ] **Row-level oracle A/B, five corpora**,
      `--oracle merged --dispatch --workers 8`, five runs each side. Expected:

| corpus               | expected                                                                                                                                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| polar                | `missed` DOWN by 27–45 (floor 27 = the rows whose inner type names the oracle's class exactly; ceiling 45 = the 9 + 36 attributed); `phantom` +0; the 33 `Mapped[external]` edge rows stay `agreeExternal` |
| netbox               | **0 rows changed** — 0 `Mapped` annotations in the corpus                                                                                                                                                  |
| ugnest, flask, httpx | **0 rows changed**                                                                                                                                                                                         |

- [ ] **The A/B is the gate, and a shortfall is a finding, not a retry.** Fewer
      than 27 rows recovered ⇒ do NOT add a second mechanism; dump the rows that
      did not move, name why (the head's own type unknown, the field declared on
      a base whose file the class-key channel does not carry, the member absent
      from the inner type's MRO), and record the count. That table is this
      task's deliverable as much as the delta is.
- [ ] **Chain tally ×5**: `chainDrift` 0, `dispatchDrift` 0; report the `edges`
      delta per corpus (expected: polar up, everything else exactly 0).
- [ ] **Perf A/B**, netbox and polar, two runs each side: wall ≤ +25 %, RSS ≤
      +20 %. The change is one `Set.has` on a branch already taken.
- [ ] **Ruby parity 0** — the file is Python-only, so this is a formality; run
      it anyway, because "Python-only" has been wrong before.
- [ ] Commit:
      `feat(language): unwrap SQLAlchemy Mapped[T] as a transparent annotation (w205u)`.

---

## Task E4.2b — The dependency-manifest facility (bead `w205u.1`)

E3's Task 1, revived with the nested read the polar measurement forces. It reads
NOTHING yet — the neutrality gate below is that every row dump is byte-identical
after this task. Its consumer arrives in E4.2c.

**Files:**

- NEW `src/core/domains/language/kernel/dependency-manifest.ts`
- NEW `tests/core/domains/language/kernel/dependency-manifest.test.ts`
- MOD `src/core/contracts/types/language.ts`,
  `src/core/contracts/types/codegraph-resolution.ts`
- MOD `src/core/domains/language/kernel/extraction-passes.ts`
- MOD `src/core/domains/trajectory/codegraph/symbols/run-state.ts`,
  `provider.ts`, `resolution-runner.ts`
- MOD `src/core/domains/ingest/pipeline/base.ts`,
  `src/core/domains/ingest/pipeline/chunker/infra/worker.ts`
- MOD `scripts/ts-codegraph-typechecker-oracle.ts`,
  `scripts/codegraph-chain-tally.ts`, `scripts/py-codegraph-jedi-oracle.ts`

**Interfaces:**

```ts
/** Manifest file names read at the project root and one directory down, in this order. */
export const DEPENDENCY_MANIFEST_FILES: readonly string[];
/** Directories skipped by the depth-1 scan, and the cap on how many it visits. */
export const DEPENDENCY_MANIFEST_MAX_DIRS: number;
/** Bytes read per manifest file. */
export const DEPENDENCY_MANIFEST_MAX_BYTES: number;

/** Every manifest at `root` and one directory below it, joined by newlines. Absent ⇒ undefined. */
export function readDependencyManifestAt(root: string): string | undefined;
/** PEP 503: lowercase, and every run of `-`, `_` or `.` becomes a single `-`. */
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
      FIRST, RED, with the strings measured on the five corpora in decision 4:
      `Django==6.0.8` ⇒ declares `django` (case-insensitive);
      `django-cors-headers==4.9.0`, `django-mptt==0.18.0`,
      `djangorestframework==3.17.1` alone ⇒ does NOT declare `django`; the PEP
      621 array
      `dependencies = [\n  "fastapi==0.141.1",\n  "sqlalchemy[asyncio]>=2.0.51",\n  "pydantic>=2.13.4",\n]`
      ⇒ declares `fastapi`, `sqlalchemy` and `pydantic`, extras stripped;
      `dynamic = ["version", "dependencies"]` ⇒ declares nothing (netbox's
      pyproject); a poetry table
      `[tool.poetry.dependencies]\npython = "^3.12"\ndjango = "^5.0"` ⇒ declares
      `django` but not `python`, while a bare `dependencies = [` line OUTSIDE a
      poetry table does NOT declare `dependencies`; `# Django==1.0` ⇒ nothing;
      `-r base.txt`, `--index-url https://x`, `-e .` ⇒ nothing;
      `pytest ; python_version < "3.11"` ⇒ declares `pytest`; `undefined` ⇒ the
      empty set and `dependencyManifestDeclares(undefined, "django") === false`;
      and calling `dependencyNamesOf` twice with the same string returns the
      SAME Set identity.
- [ ] Add the READ tests against a temp tree: a root holding only
      `pyproject.toml` is read; a root holding NOTHING but a
      `server/pyproject.toml` one directory down IS read (this is polar, and it
      is the whole reason the scan is not root-only);
      `sdk/python/pyproject.toml` at depth 2 is NOT read; a
      `.venv/pyproject.toml` and a `node_modules/pyproject.toml` are NOT read;
      an unreadable root answers `undefined` rather than throwing.
- [ ] Create `kernel/dependency-manifest.ts`. Language-neutral by design — it
      turns a text blob into distribution names and knows nothing about Python
      syntax beyond the three spellings the corpora produce. Header and data:

```ts
/**
 * A project's dependency manifest, as a raw string, and the distribution names
 * it declares (bd tea-rags-mcp-w205u.1, E4.2b).
 *
 * The generalisation of `ruby/gemfile.ts`, and deliberately the same SHAPE: the
 * composition root reads the manifest ONCE per run and threads the RAW string;
 * the parse lives here behind a memo keyed by that string, so a project pays for
 * it once and every call site is an O(1) `Set.has`. Ruby's Gemfile is one
 * instance of the facility, not a separate mechanism.
 *
 * Root AND one directory down, unlike the Gemfile. E3 shipped root-only and it
 * was measured USELESS on the one corpus that needs it: polar has no root
 * manifest at all and declares fastapi / sqlalchemy / pydantic in
 * `server/pyproject.toml`. Depth 1 reaches that; depth 2
 * (`sdk/python/pyproject.toml`) is not reached and does not need to be — it
 * declares the same distributions.
 *
 * The reader is line-oriented rather than a TOML parser on purpose. netbox's
 * `pyproject.toml` says `dynamic = ["version", "dependencies"]` and names Django
 * NOWHERE — only `requirements.txt` does — so the facility has to read both
 * shapes anyway, and one scanner that handles both is smaller than a TOML parser
 * plus a requirements parser plus the code that decides which file is which.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Manifest file names read at the root and at each scanned depth-1 directory. */
export const DEPENDENCY_MANIFEST_FILES: readonly string[] = [
  "pyproject.toml",
  "requirements.txt",
  "requirements-dev.txt",
  "setup.cfg",
  "setup.py",
  "Gemfile",
];

/** Bytes read per manifest file. A manifest is metadata; anything larger is not one. */
export const DEPENDENCY_MANIFEST_MAX_BYTES = 262_144;
/** Depth-1 directories visited before the scan gives up. A monorepo root is small. */
export const DEPENDENCY_MANIFEST_MAX_DIRS = 64;

/** Directory names the depth-1 scan never enters — vendored trees and caches. */
const SKIPPED_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  "__pycache__",
  "venv",
  ".venv",
  "site-packages",
  "vendor",
  "build",
  "dist",
]);
```

- [ ] The parse. Three spellings, all of which the five corpora produce:

```ts
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

/** PEP 503: lowercase, and every run of `-`, `_` or `.` becomes a single `-`. */
export function normalizeDistributionName(raw: string): string {
  return raw.toLowerCase().replace(/[-_.]+/g, "-");
}

/** Record `raw` as a requirement specifier, if it looks like one. */
function addRequirement(into: Set<string>, raw: string): void {
  const match = REQUIREMENT.exec(raw.trim());
  if (match === null) return;
  into.add(normalizeDistributionName(match[1]));
}
```

- [ ] The two exported readers, verbatim:

```ts
/**
 * Distribution names a manifest declares, PEP 503 normalised.
 *
 *   - a bare requirements line   `Django==6.0.8`
 *   - a quoted array entry       `  "sqlalchemy[asyncio]>=2.0.51",`
 *   - a poetry table key         `django = "^5.0"` under `[tool.poetry.dependencies]`
 *
 * A quoted line is read as ARRAY entries and never also as a bare line: a TOML
 * assignment's left-hand side outside a poetry table is a key like
 * `dependencies` or `requires-python`, not a distribution. That is what keeps
 * netbox's `dynamic = ["version", "dependencies"]` from declaring anything.
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
    const trimmed = line.split("#")[0].trim();
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

- [ ] The bounded read. One `readdirSync` at the root, then the same five names
      per surviving directory — the cost is `O(1 + dirs)` `readFileSync`
      attempts and it happens ONCE per run:

```ts
/** Read every manifest file present in `dir`, capped, and push what was found. */
function pushManifestsIn(dir: string, into: string[]): void {
  for (const file of DEPENDENCY_MANIFEST_FILES) {
    try {
      into.push(
        readFileSync(join(dir, file), "utf8").slice(
          0,
          DEPENDENCY_MANIFEST_MAX_BYTES,
        ),
      );
    } catch {
      // This directory does not carry that manifest file.
    }
  }
}

/**
 * Every manifest at `root` and at each of its immediate subdirectories, joined
 * by newlines; `undefined` when there is none. Depth 1 rather than a
 * nearest-manifest walk because the walk is per-FILE state and this facility is
 * per-RUN state: one string, read once, threaded everywhere, memoised by
 * content. polar is the corpus that forces depth 1 and nothing measured needs
 * depth 2 (decision 4).
 */
export function readDependencyManifestAt(root: string): string | undefined {
  const parts: string[] = [];
  pushManifestsIn(root, parts);
  let visited = 0;
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (visited >= DEPENDENCY_MANIFEST_MAX_DIRS) break;
      if (
        !entry.isDirectory() ||
        entry.name.startsWith(".") ||
        SKIPPED_DIRS.has(entry.name)
      )
        continue;
      visited++;
      pushManifestsIn(join(root, entry.name), parts);
    }
  } catch {
    // An unreadable root is a project with no manifest, not a failure.
  }
  return parts.length === 0 ? undefined : parts.join("\n");
}
```

- [ ] Run the test file GREEN. No other file has been touched yet.
- [ ] Thread the contract. In `contracts/types/language.ts`, add to BOTH
      `WalkInput` and `WalkContext`, immediately after `gemfileContent`:

```ts
  /**
   * Raw contents of the project's dependency manifests — every file in
   * `DEPENDENCY_MANIFEST_FILES` present at the root or one directory below it,
   * joined by newlines, read ONCE per run (bd tea-rags-mcp-w205u.1). The
   * generalisation of {@link gemfileContent}: extraction-time consumers gate
   * framework-conditional grammar on it via `dependencyManifestDeclares`.
   * Undefined ⇒ no manifest ⇒ every framework gate falls back to per-file
   * import evidence, which is what E3 already runs on. Ruby keeps reading
   * `gemfileContent` until its adapter is flipped; the two fields carry the same
   * bytes for a Ruby project.
   */
  dependencyManifest?: string;
```

      Add the same field, with a `CallContext`-flavoured comment, beside
      `gemfileContent` in `contracts/types/codegraph-resolution.ts:325`.

- [ ] `kernel/extraction-passes.ts::toWalkContext` — mirror the existing
      absent-key discipline exactly, a second `if` and not a spread:

```ts
if (input.dependencyManifest !== undefined) {
  ctx.dependencyManifest = input.dependencyManifest;
}
```

- [ ] Composition root 1, the resolve path. In `run-state.ts`, beside
      `gemfileContent` (`:593`) add `dependencyManifest: string | undefined` and
      `private dependencyManifestLoaded = false`, plus a
      `loadDependencyManifest(root)` guarded exactly as `loadGemfile` is
      (`:678`) and delegating the read to `readDependencyManifestAt`. **Reset
      BOTH new fields at every seam that today resets `gemfileContent` — `:990`,
      `:1074`, `:1152`, `:1191`.** A missed reset is a cross-project leak, the
      bug class `6goqa` is named for.
- [ ] Call it beside each `this.runState.loadGemfile(root)` in `provider.ts`
      (`:964`, `:1159`, `:1192`). Attach
      `dependencyManifest:     this.runState.dependencyManifest` beside each
      `gemfileContent:` in `resolution-runner.ts` (`:317`, `:464`) and in the
      `walker.walk({…})` at `provider.ts:1760`.
- [ ] Composition root 2, the chunker walk path. In `ingest/pipeline/base.ts`,
      call `readDependencyManifestAt(absolutePath)` where `readGemfile` is
      called today, pass the result into `createChunkerPool` alongside
      `gemfileContent` (`:337`, `:349`), add the field to the pool's options
      type (`chunker/infra/worker.ts:73`, `:98`) and thread it to
      `walker.walk({…})` at `:142` as
      `dependencyManifest: engine.dependencyManifest`.
- [ ] Harnesses, so the A/B measures production, not a different composition. In
      `scripts/ts-codegraph-typechecker-oracle.ts` give `extractFile` a fifth
      parameter `dependencyManifest?: string` and pass it into
      `walker.walk({…})`. In `scripts/codegraph-chain-tally.ts` call
      `readDependencyManifestAt(root)` once before the pass-1 loop, pass it to
      every `extractFile`, and add `dependencyManifest` to the object
      `buildCallContext` returns. Same in `scripts/py-codegraph-jedi-oracle.ts`,
      rooted at `corpusRoot`.
- [ ] `npx tsc --noEmit` clean; `npm run test:coverage` exit 0.
- [ ] **Ruby parity gate.** `npx vitest run tests/core/domains/language/ruby`
      green with no test edits, and the mastodon chain tally byte-identical.
      Ruby still reads `gemfileContent`; this task adds a field beside it and
      changes no Ruby behaviour.
- [ ] **Python neutrality gate.** Row dumps ×5, BEFORE and AFTER,
      byte-identical. Nothing reads `dependencyManifest` yet, so a single
      changed row means the threading altered something it should not have.
- [ ] **Manifest recognition check** (not a code change — a printed fact). For
      each corpus root, print
      `[...dependencyNamesOf(readDependencyManifestAt(root))]` filtered to
      `django`, `sqlalchemy`, `pydantic`, and assert it matches decision 4's
      table exactly: netbox `django`, ugnest `django`, polar `sqlalchemy` +
      `pydantic`, flask none, httpx none. A mismatch here is a parser defect and
      it must be fixed before E4.2c, which trusts this answer.
- [ ] Commit:
      `feat(language): read a nested dependency manifest through walk and resolve (w205u)`.

---

## Task E4.2c — The framework-vocabulary registry and the boundary DROP (bead `w205u.2`)

Zero measured recall and, on these five corpora, zero measured edges (decisions
2 and 3). It ships for the SEAM: a typed registry in Ruby's shape, a manifest
gate with a consumer, and one behaviour — an unrecognised member on a receiver
whose MRO reaches a framework boundary class DROPs instead of continuing to
`globalShortName`. That is the arm E4.3 hangs DRF and Celery on, and it is the
arm that makes `Site.objects.filter(x).nonexistent()` a non-answer rather than a
name-shaped guess. **Read decision 2 before writing a facet: `fluentSelfMembers`
for SQLAlchemy and `instanceTerminalMembers` for anything are NOT in this task,
and their absence is a measurement, not an omission.**

**Files:**

- NEW `src/core/domains/language/python/resolver/frameworks/types.ts`,
  `define-framework-vocabulary.ts`, `django.ts`, `sqlalchemy.ts`, `pydantic.ts`,
  `index.ts`
- MOD `src/core/domains/language/python/resolver/python-receiver-type-ports.ts`
- MOD `src/core/domains/language/python/resolver/python-resolver.ts`,
  `src/core/domains/language/python/index.ts`
- NEW
  `tests/core/domains/language/python/resolver/frameworks/python-framework-vocabulary.test.ts`

**Interfaces:**

```ts
// frameworks/types.ts
export interface PythonFrameworkVocabulary {
  /** The framework's own name, for diagnostics and for the dup-key guard. */
  readonly framework: string;
  /** PEP 503 distribution names any of which activates this vocabulary. */
  readonly activatedBy: ReadonlySet<string>;
  /** `classAncestors` spellings that make a project class one of this framework's types. */
  readonly boundaryClasses: ReadonlySet<string>;
  /** Members that return the SAME receiver type. Empty for a framework with none. */
  readonly fluentSelfMembers: ReadonlySet<string>;
  /** `Cls.member(…)` returning an INSTANCE of `Cls`. Empty for a framework with none. */
  readonly classFactories: ReadonlySet<string>;
  /** Does this vocabulary claim `base`, one `classAncestors` spelling? */
  readonly claimsBase: (base: string) => boolean;
}

// frameworks/index.ts
export const PYTHON_FRAMEWORKS: readonly PythonFrameworkVocabulary[];
/** The vocabularies a manifest activates, memoised by the manifest STRING. */
export function pythonActiveFrameworks(
  manifest: string | undefined,
): readonly PythonFrameworkVocabulary[];
/** The first active vocabulary whose boundary a type's MRO reaches, or undefined. */
export function pythonFrameworkBoundaryFor(
  typeName: string,
  ctx: CallContext,
  mapper: PythonImportFileMapper,
  linearizer: AncestorLinearizer<CallContext> | undefined,
  frameworks: readonly PythonFrameworkVocabulary[],
): PythonFrameworkVocabulary | undefined;
```

**Steps:**

- [ ] `frameworks/define-framework-vocabulary.ts` — the factory, mirroring
      `ruby/dsl/framework-module.ts`: membership logic lives HERE once so no
      consumer reaches into the storage shape, and an absent facet becomes an
      empty frozen `Set` rather than `undefined`:

```ts
/**
 * Build a `PythonFrameworkVocabulary` from one framework's data (bd
 * tea-rags-mcp-w205u.2). A factory, not a container — each framework module
 * calls it with its own facets, and `frameworks/index.ts` lists the results in a
 * typed array. Adding a framework is one module file plus one array line, with
 * ZERO resolver edits; that property is the whole reason the registry exists
 * (`.claude/rules/resolver-architecture.md`, sections 2 and 3).
 *
 * Every facet defaults to the EMPTY set. A framework that declares only
 * `boundaryClasses` — SQLAlchemy, measured — is a complete vocabulary: it says
 * "these types are mine", which is enough for the fold to DROP at the boundary
 * instead of guessing, and it claims no member it cannot type.
 */
const EMPTY_MEMBERS: ReadonlySet<string> = Object.freeze(new Set<string>());

export function definePythonFrameworkVocabulary(
  framework: string,
  activatedBy: ReadonlySet<string>,
  boundaryClasses: ReadonlySet<string>,
  facets: Partial<
    Pick<PythonFrameworkVocabulary, "fluentSelfMembers" | "classFactories">
  > = {},
): PythonFrameworkVocabulary {
  return Object.freeze({
    framework,
    activatedBy,
    boundaryClasses,
    fluentSelfMembers: facets.fluentSelfMembers ?? EMPTY_MEMBERS,
    classFactories: facets.classFactories ?? EMPTY_MEMBERS,
    claimsBase: (base) => boundaryClasses.has(base),
  });
}
```

- [ ] `frameworks/django.ts`. The fluent set is E3's, unchanged: it was checked
      against Django's `QuerySet` API and against the 24 built-in member names
      netbox's rows produce, and E3's decision 3 verified that no netbox project
      QuerySet declares any of them — so every member here DROPs at the boundary
      today and continues to. `values` / `values_list` are excluded because they
      return dicts and tuples; `get_or_create` / `update_or_create` are excluded
      because they return a TUPLE and element typing is not a mechanism this
      increment has:

```ts
export const DJANGO_VOCABULARY = definePythonFrameworkVocabulary(
  "django",
  new Set(["django"]),
  new Set([
    "django.db.models::QuerySet",
    "django.db.models::Manager",
    "django.db.models::BaseManager",
    "django.db.models.query::QuerySet",
    "django.db.models.manager::Manager",
    "django.db.models.manager::BaseManager",
  ]),
  {
    fluentSelfMembers: new Set([
      "filter",
      "exclude",
      "all",
      "order_by",
      "reverse",
      "distinct",
      "select_related",
      "prefetch_related",
      "annotate",
      "alias",
      "only",
      "defer",
      "using",
      "none",
      "union",
      "intersection",
      "difference",
    ]),
  },
);
```

- [ ] `frameworks/sqlalchemy.ts` — boundary classes and NOTHING else, with the
      measurement in the comment so the next reader does not "complete" it:

```ts
/**
 * SQLAlchemy declares its types and claims no member (bd tea-rags-mcp-w205u.2).
 *
 * Measured on polar, E4.2 decision 2: all 2,850 `sqlalchemyRow` rows are calls
 * INTO the library — `select(X)` 1,407, `session.execute` 414, `stmt.where` 354,
 * `session.add` / `flush` / `commit` 675 — whose target is an external
 * definition and therefore not an edge, 0 of them residual. And 0 of the 1,222
 * rows whose RECEIVER is a SQLAlchemy result or statement expression are
 * residual either: `session.get(Order, id).mark_paid()` does not occur on any
 * corpus. A fluent or terminal facet here could not gain an edge; it could only
 * convert one of polar's 2,258 `agreeExternal` rows into a phantom. The boundary
 * set alone is the honest vocabulary.
 */
export const SQLALCHEMY_VOCABULARY = definePythonFrameworkVocabulary(
  "sqlalchemy",
  new Set(["sqlalchemy"]),
  new Set([
    "sqlalchemy.orm::Session",
    "sqlalchemy.ext.asyncio::AsyncSession",
    "sqlalchemy.orm::DeclarativeBase",
    "sqlalchemy.orm::MappedAsDataclass",
  ]),
);
```

- [ ] `frameworks/pydantic.ts` — the boundary plus the ONE factory that is
      type-correct by definition. `X.model_validate(d)` IS an `X`; the measured
      population is 5 polar rows, 0 residual, and the facet cannot fabricate
      because the member resolved on `X` afterwards must still be one `X`
      declares:

```ts
export const PYDANTIC_VOCABULARY = definePythonFrameworkVocabulary(
  "pydantic",
  new Set(["pydantic"]),
  new Set(["pydantic::BaseModel", "pydantic.main::BaseModel"]),
  // `model_dump` / `model_dump_json` are NOT here: they return a dict and a str.
  {
    classFactories: new Set([
      "model_validate",
      "model_validate_json",
      "model_construct",
    ]),
  },
);
```

- [ ] `frameworks/index.ts` — the typed array, the activation fold and the
      boundary walk. Two memos, both keyed the way Ruby keys its equivalents:

```ts
/** The registry. Adding a framework is one import and one line here. */
export const PYTHON_FRAMEWORKS: readonly PythonFrameworkVocabulary[] = [
  DJANGO_VOCABULARY,
  SQLALCHEMY_VOCABULARY,
  PYDANTIC_VOCABULARY,
];

const activeByManifest = new Map<
  string,
  readonly PythonFrameworkVocabulary[]
>();
const NONE: readonly PythonFrameworkVocabulary[] = Object.freeze([]);

/**
 * The vocabularies a project's manifest activates, memoised by the manifest
 * STRING so the parse and the filter are paid once per run (the shape
 * `catalogueForGemfile` uses). NO manifest ⇒ NO vocabulary: unlike Ruby, whose
 * absent Gemfile falls back to the FULL catalogue, a Python project with no
 * manifest gets the pre-task behaviour. Ruby's default is safe because its
 * catalogue is mostly grammar; ours changes RESOLUTION, and E3 decision 5's
 * fallback position is per-file import evidence, not "assume every framework".
 */
export function pythonActiveFrameworks(
  manifest: string | undefined,
): readonly PythonFrameworkVocabulary[] {
  if (manifest === undefined) return NONE;
  const cached = activeByManifest.get(manifest);
  if (cached !== undefined) return cached;
  const active = Object.freeze(
    PYTHON_FRAMEWORKS.filter((f) =>
      [...f.activatedBy].some((dist) =>
        dependencyManifestDeclares(manifest, dist),
      ),
    ),
  );
  activeByManifest.set(manifest, active);
  return active;
}
```

- [ ] The boundary walk, in the same file. It reuses the linearizer already
      threaded into the ports, folds over the registry rather than testing each
      framework inline (`resolver-architecture.md` section 2), and memoises per
      `(classAncestors identity, typeName)` the way
      `PythonNamingConventionSymbolResolutionStrategy.descendantsOf` does:

```ts
/**
 * The first ACTIVE vocabulary whose `boundaryClasses` one of `typeName`'s
 * ancestors matches, or `undefined`.
 *
 * `PYTHON_UNRESOLVABLE_BASE` ("<unresolvable>", a computed base such as
 * `Manager.from_queryset(QS)`) means "keep walking the other bases", NEVER
 * "this is not a boundary type" — netbox's dominant manager form has exactly
 * one base and it is that token.
 */
export function pythonFrameworkBoundaryFor(
  typeName: string,
  ctx: CallContext,
  mapper: PythonImportFileMapper,
  linearizer: AncestorLinearizer<CallContext> | undefined,
  frameworks: readonly PythonFrameworkVocabulary[],
): PythonFrameworkVocabulary | undefined {
  if (frameworks.length === 0) return undefined;
  const classKey = pythonReceiverClassKey(typeName, ctx, mapper);
  if (classKey === null) return undefined;
  const keys =
    linearizer === undefined
      ? [classKey]
      : linearizer.linearize(classKey).order;
  for (const key of keys) {
    for (const base of ctx.classAncestors?.[key] ?? []) {
      if (base === PYTHON_UNRESOLVABLE_BASE) continue;
      const claimed = frameworks.find((f) => f.claimsBase(base));
      if (claimed !== undefined) return claimed;
    }
  }
  return undefined;
}
```

      `pythonReceiverClassKey` is a module-private function in
      `strategies/shared.ts:324` today; export it rather than writing a second
      copy — the two must agree about which file declares a receiver's class or
      the boundary walk and the field walk will disagree on the same receiver.
      `linearizer.linearize(classKey).order` INCLUDES the class itself, which is
      what makes a project class that subclasses `QuerySet` directly answer on
      the first iteration. Memoise the whole function per
      `(ctx.classAncestors identity, typeName)` in a `WeakMap`, the pattern
      `PythonNamingConventionSymbolResolutionStrategy.descendantsOf` uses, so the
      walk is paid once per type per run rather than once per call site.

- [ ] Write
      `tests/core/domains/language/python/resolver/frameworks/python-framework-vocabulary.test.ts`
      FIRST, RED. Build a `CallContext` the way the neighbouring resolver tests
      build one, with `classAncestors`, `classFieldTypesByClassKey`,
      `dependencyManifest` and a symbol table, and assert:

      1. `pythonActiveFrameworks("Django==6.0.8")` is `[DJANGO_VOCABULARY]`;
         `pythonActiveFrameworks("django-mptt==0.18.0")` is `[]`;
         `pythonActiveFrameworks(undefined)` is `[]`; the same string twice
         returns the SAME array identity.
      2. `pythonActiveFrameworks` on polar's `server/pyproject.toml` body is
         `[SQLALCHEMY_VOCABULARY, PYDANTIC_VOCABULARY]` — registry order, not
         manifest order.
      3. `Site.objects.restrict(user)` where `Site.objects` is
         `RestrictedQuerySet` and `RestrictedQuerySet(QuerySet)` declares
         `restrict` ⇒ `resolved(RestrictedQuerySet#restrict)`. The project's own
         MRO answers; the vocabulary is not consulted for it.
      4. `Site.objects.filter(x).restrict(user)` ⇒ the same target — the fluent
         arm kept the receiver type across `filter`.
      5. `Site.objects.filter(x).nonexistent()` ⇒ **DROP**, never CONTINUE. This
         is the behaviour the task ships.
      6. `Site.objects.values(x).restrict(user)` ⇒ CONTINUE — `values` is not
         fluent, the fold stops, nothing is claimed.
      7. `ObjectType.objects.create(x)` where `create` is declared on
         `ObjectTypeQuerySet` but `ObjectType.objects` is `ObjectTypeManager()`
         ⇒ DROP. E3 decision 3's measured precision case.
      8. `ContentType.objects.get_for_model(m)` with no field fact on
         `ContentType` ⇒ CONTINUE — the fold never types hop 1, which is what
         keeps netbox's 183 `agreeExternal` `ContentType` rows still.
      9. A project class `FooBar(QuerySet)` under a manifest naming no django ⇒
         every arm silent, boundary answer `undefined`.
      10. `Schema.model_validate(d).own_method()` where `Schema(BaseModel)` and
          the manifest declares pydantic ⇒ `resolved(Schema#own_method)`; the
          same chain under a manifest without pydantic ⇒ CONTINUE.
      11. A SQLAlchemy-active context: `session.execute(stmt)` where `session`
          has no project type ⇒ CONTINUE, unchanged. The vocabulary declares no
          member and must not invent one.

- [ ] Wire the fold. In `python-receiver-type-ports.ts`, `pythonMemberTypeOf`
      gains the vocabularies as a parameter and one arm AFTER
      `pythonInheritedMemberType` answers `undefined`, so nothing that already
      answers can change:

```ts
function pythonMemberTypeOf(
  recv: TypeRef,
  member: string,
  ctx: CallContext,
  mapper: PythonImportFileMapper,
  linearizers: PythonAncestorLinearizerCache | undefined,
): TypeRef | undefined {
  if (recv.form !== "class" && recv.form !== "instance") return undefined;
  const linearizer = linearizers?.for(ctx);
  const inherited = pythonInheritedMemberType(
    recv.name,
    member,
    recv.form,
    ctx,
    mapper,
    linearizer,
  );
  if (inherited !== undefined) return inherited;
  // The framework arm. A project class answers its OWN members through the walk
  // above; this is only for the LIBRARY verbs, which no project class declares
  // and which therefore reach here untyped (bd tea-rags-mcp-w205u.2).
  const frameworks = pythonActiveFrameworks(ctx.dependencyManifest);
  const boundary = pythonFrameworkBoundaryFor(
    recv.name,
    ctx,
    mapper,
    linearizer,
    frameworks,
  );
  if (boundary === undefined) return undefined;
  if (recv.form === "instance" && boundary.fluentSelfMembers.has(member))
    return recv;
  if (recv.form === "class" && boundary.classFactories.has(member)) {
    return { form: "instance", name: recv.name };
  }
  return undefined;
}
```

      Two properties are load-bearing and must survive review. The arm never
      runs when `pythonInheritedMemberType` answered, so every non-framework
      answer is byte-identical to the pre-task tree. And the fluent arm returns
      `recv` ITSELF, which is what carries the type across
      `filter(…).exclude(…)` without any owner tag — decision 6.

- [ ] The DROP. `undefined` from `memberTypeOf` already stops the fold; what
      this task adds is that `chainType` must answer **DROP rather than
      CONTINUE** when the receiver's own type reached a framework boundary and
      the member was not claimed. Add that condition where `chainType` decides
      its unresolved outcome, gated on `pythonFrameworkBoundaryFor` having
      answered for the LAST typed hop — never on the head, and never when the
      fold stopped for any other reason. A stop with no boundary keeps
      CONTINUEing exactly as today.
- [ ] Thread the registry. `createPythonReceiverTypePorts` already closes over
      `mapper` and `linearizers`; the vocabularies are read per call from
      `ctx.dependencyManifest` through the memo, so no new constructor parameter
      is needed and no call site outside this file changes.
- [ ] Turn the new test file GREEN. `npx tsc --noEmit` clean.
- [ ] **Row-level oracle A/B, five corpora**, five runs each side. Expected, and
      every one of these is a PREDICTION the A/B either confirms or refutes:

| corpus       | expected                                                                                                                                                                                  |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| netbox       | recall UNCHANGED from E4.2a; `phantom` +0; all 239 exposed `agreeExternal` rows unchanged; `edges` **+0** — decision 3 measured 0 fluent rows ending in a project verb                    |
| ugnest       | **0 rows changed.** Django ACTIVATES (its manifest declares it) and it declares no project Manager or QuerySet class at all, so no boundary is ever reached. Phantom stays 0 — the canary |
| polar        | SQLAlchemy and pydantic activate; `edges` **+0 to +5** (the `model_validate` chains); `agreeExternal` unchanged on all 1,978 exposed rows                                                 |
| flask, httpx | **0 rows changed** — no manifest names any of the three, so the 18 + 1 `sqlalchemyRow` classifier false positives are unreachable by construction                                         |

- [ ] **A flat A/B is the expected result here, not a failure.** Do NOT add
      members to make a column move. If a column DOES move, that is the finding:
      report which arm, which rows, and evaluate the remove clause.
- [ ] **Remove clause (decision 7).** Phantom up by more than +0.5 pp of edges
      on any corpus, or ugnest off phantom 0 ⇒ delete the offending ARM —
      `fluentSelfMembers`, `classFactories`, or a `boundaryClasses` entry — and
      re-run. Do NOT tune the member sets.
- [ ] **Chain tally ×5**: `chainDrift` 0, `dispatchDrift` 0; report the `edges`
      delta per corpus, because on this task edges ARE the result.
- [ ] **Perf A/B**, netbox and polar, two runs each side: wall ≤ +25 %, RSS ≤
      +20 %. The added work is one memo lookup plus, only on an
      otherwise-unanswered hop, one memoised ancestor walk and one `Set.has`.
- [ ] `npm run test:coverage` exit 0; Ruby parity 0.
- [ ] Commit:
      `feat(language): gate python framework vocabularies on the dependency manifest (w205u)`.

---

## Task E4.2d — The hand-sample precision gate, the navigators, and the close

The oracle cannot score an edge whose target it calls external, so the edges
this increment adds are checked by hand or not at all. This task is that check
plus the increment's paperwork.

**Files:**

- MOD `src/core/domains/language/python/CLAUDE.md` (the navigator, if one exists
  at that path; otherwise `src/core/domains/language/CLAUDE.md`)
- MOD
  `docs/superpowers/plans/2026-09-10-python-e4-2-wrappers-and-vocabularies.md`
  (this file — the measurement record)
- No source change unless the sample finds a defect.

**Steps:**

- [ ] Build the NEW-edge set. Diff the AFTER row dump of E4.2c against the
      BEFORE dump of E4.2a, per corpus, keeping every row whose
      `chainTargetSymbolId` went from `null` to a value or changed value. That
      set is the increment's whole edge delta and it is what the sample is drawn
      from — not the residual, and not the families.
- [ ] **Sample and classify 50 rows**, or the WHOLE set when it is smaller than
      50 — which decisions 2 and 3 predict it will be. Stratify by corpus in
      proportion to the set. For each row, open the call site AND the target
      definition and record: the receiver's real type, whether the target is the
      member that Python would actually dispatch to, and correct / incorrect.
      Record the seed and the row list so the sample is reproducible.
- [ ] **The bar is ≥ 96 % correct.** Below it, the increment does not close:
      identify the arm that produced the incorrect edges and apply its remove
      clause. When the set is smaller than 50 the bar is **100 % of the set**,
      stated as such — a 4-row set with one wrong edge is a 75 % sample and a
      failure, not a rounding artifact.
- [ ] **Re-state the phantom delta per corpus** from the same dumps: `phantom`
      and `wrongFile` before → after, as counts and as a percentage of edges,
      against the +0.5 pp cap. ugnest must read 0 → 0.
- [ ] Update the navigator with the facts a future editor cannot infer from the
      code: that `Mapped` is in the transparent set as a LANGUAGE rule and is
      deliberately not manifest-gated; that a framework vocabulary declaring
      only `boundaryClasses` is complete and its empty member facets are a
      measurement; that `pythonActiveFrameworks(undefined)` is NONE while Ruby's
      `catalogueFor(undefined)` is FULL, and why the two defaults differ. LINK
      to this plan for the counts; do not restate them.
- [ ] Write the **Measurement record** section at the end of this plan: the A/B
      deltas per corpus per task, the chain-tally edge deltas, the hand sample's
      size / bar / result, the perf numbers, and the rows that did NOT move with
      the reason each did not. A shortfall named is worth more than a delta
      claimed.
- [ ] Capability text for the epic close, one paragraph, no adjectives: what a
      user can now resolve that they could not, and on which corpus.
- [ ] Commit: `docs(plans): record the E4.2 measurement (w205u)`.

---

## Follow-ups this plan files rather than does

| bead       | rows        | what it is                                                                                                                                                                                                                                                                                                                                                                    |
| ---------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `w205u.2b` | 21 (netbox) | Django queryset LOCALS — 12 bare `queryset` (a filterset method parameter) and 9 `self.queryset` (a view class attribute, 5 of them the two-hop `self.queryset.model.objects.restrict(…)`). All `bothUnresolved`, so edge density at zero phantom exposure. Needs a class-body RHS arm for `queryset = <Model>.objects.<verb>()` plus a `.model` hop, NOT a member vocabulary |
| `w205u.2c` | 8 (flask)   | `LocalProxy` globals — `current_app` / `g`. Needs a module-level annotated-global channel plus a `TYPE_CHECKING` alias-class hop (decision 5)                                                                                                                                                                                                                                 |
| `w205u.2d` | 0 measured  | `instanceTerminalMembers` and the owner-tag representation E3 designed. Re-open only when a corpus produces terminal rows whose member a project model declares (decision 6)                                                                                                                                                                                                  |
| `w205u.1b` | 0 measured  | Flip Ruby's `gemfileContent` reads onto `dependencyManifest` and delete the duplicate field. Pure relocation with a parity-0 gate; deliberately NOT in this plan, which must not risk Ruby for a rename                                                                                                                                                                       |

---

## What this plan does NOT claim

- **It does not claim edge density from SQLAlchemy or pydantic.** 3,073 of the
  3,095 edge-density rows are calls into a library and their targets are
  external; the measured project-edge yield is 0 to 5 rows, all pydantic
  factories. The spec sized this increment at "3,095 edge rows"; the honest size
  is 45 recall rows and a seam.
- **It does not claim the Django arms buy anything on netbox.** Fluent 0,
  terminal 0. They ship because the boundary DROP is the precision behaviour
  E4.3 builds on, and because a flat A/B on a corpus that ACTIVATES the
  vocabulary is the evidence that the gate works.
- **It does not claim the 45 rows are all recoverable.** 27 are confirmed
  row-by-row against the oracle's own target class; the remaining 18 are
  attributed by annotation and by E4.6's sub-shape split. The A/B is what
  settles the number, and Task E4.2a is required to report the rows that did not
  move rather than to reach for a second mechanism.
- **It does not claim the manifest scan is complete.** Depth 1, five file names,
  three declaration spellings, 64 directories. `polar/sdk/python/pyproject.toml`
  at depth 2 is not read and does not need to be. A monorepo whose only manifest
  sits three levels down is undescribed and falls back to per-file import
  evidence, which is what E3 already runs on.
- **It does not touch the walker.** Walker version stays 5, no channel changes
  shape, and the two shapes that WOULD need a new channel — flask's module-level
  proxies and netbox's `queryset` class attribute — are filed as beads with
  their mechanisms written down.
