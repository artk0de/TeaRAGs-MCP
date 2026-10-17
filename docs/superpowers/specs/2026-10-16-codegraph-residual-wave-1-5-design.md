# Codegraph residual resolution — wave 1.5: coverage

Epic: `tea-rags-mcp-2m83f`. Follows
[`2026-10-09-codegraph-residual-resolution-design.md`](2026-10-09-codegraph-residual-resolution-design.md)
(wave 1). Live validation `2m83f.24` is paused until this wave lands.

## Problem

Wave 1 shipped a precise mechanism that closes almost nothing. Measured on
TaxDome Ruby, 2026-10-16 (build `f227be3c7`, `--force-enrichments codegraph`,
verdict store from the Kev A/B run):

|               | wave 1 design (2026-10-09)           | TaxDome, measured                                       |
| ------------- | ------------------------------------ | ------------------------------------------------------- |
| residual      | ~35.5k sites → ~13.3k questions      | 12,966 sites → 1,251–2,639 questions                    |
| Kev precision | 0.945 on 91 YARD questions           | 0.989 on 93 labelled edges                              |
| effect        | "a local model can close most of it" | 101 sites edged; Ruby recall 0.9049 → 0.9055 (+0.06 pp) |

Where the 10,556 residual sites of the last run went:

| outcome                                 | sites | share |
| --------------------------------------- | ----- | ----- |
| menu > 40 (`menuOverflow`), never asked | 7,119 | 67%   |
| menu < 4 (`menuTooSmall`), never asked  | 1,297 | 12%   |
| verdict below p 0.7                     | 1,755 | 17%   |
| edged                                   | 101   | 1%    |

The wave 1 benchmark measured P(correct | true target in menu, menu ≤ 40). On a
real corpus the yield is P(menu ≤ 40) × P(true target in menu) × that, and the
first two factors were never measured. Concretely:

- **Overflow** is association readers, schema columns and contract-struct
  attributes shared by hundreds of classes: `firm` 1,164, `name` 809, `user`
  735, `as_json` 612, `firm_id` 465, `data` 454, `client` 342.
- **Too-small menus** are framework methods with one to three incidental project
  namesakes: `save!` 301, `presence` 222, `try` 62, `seconds` 45, `increment`
  42, `days` 41, `underscore` 29, `with_lock` 28. The true target is external;
  the call sits in the recall denominator as a miss.
- **Below threshold**: the question has no "none of these" answer, so when the
  target is external the model must pick a project class, and its probability,
  normalised over the menu, is low. Low p therefore conflates "unsure" with "the
  answer is not offered".
- The menu is built from ONE member. Every other call on the same receiver in
  the same method is ignored, although the receiver must answer all of them.

Wave 1's acceptance gate measured precision only (≥ 0.93), so it passed while
the epic's goal — coverage of the residual — failed.

## Goal and acceptance

Coverage first, precision held:

1. **Asked share** — sites that receive a question (or are settled statically by
   this wave) ≥ 70% of residual sites on TaxDome Ruby (wave 1: 21%).
2. **Recall** — Ruby `inProjectEdgeRecall` (model edges included, per `.38`) +≥
   3 pp over the wave 1 baseline 0.9055, at the same `--force-enrichments`
   scope.
3. **Precision** — ≥ 0.93 on a 200-edge stratified sample (stratified by
   mechanism below), calibration ECE reported; "none" verdicts ≥ 0.90 precision
   on their own 100-site sample.
4. **Pre-measurement before any Kev run** — 200 residual sites drawn uniformly
   (no YARD filter), hand- or LLM-labelled with spot check: share whose true
   target is (a) in the narrowed menu, (b) external, (c) neither. This replaces
   the YARD fixture as the go/no-go estimate for gate 2.

## Design

Four mechanisms, ordered by cost: the first two need no GPU.

### 1. Static: framework calls are external

Under `railsVocabularyActive`, a call on an untyped or dynamic receiver whose
member is a Rails framework instance method (ActiveRecord persistence and query,
ActiveModel, ActiveSupport `Object` / `Numeric` / `String` core extensions)
counts as `externalSkipped` and never becomes a residual row — unless static
evidence types the receiver as a project class that overrides the member.
Vocabulary comes from Rails only, through the existing gate; no gem
vocabularies. In flight on `res/ext`.

### 2. Static: consensus return type

When every candidate of an overflow site returns the same type — every
`belongs_to :firm` reader returns `Firm`; every `firm_id` column returns an
integer — the hop's _type_ is known even though its _target_ is not. The chain
continues from that type, so `x.firm.name` resolves `Firm#name` statically. The
hop itself gets no edge (its target is still ambiguous); downstream hops get
static edges. Return types come from association declarations, schema column
types and the kernel's return inference.

### 3. Narrowed receiver questions

The question moves from "which method is this call" to "which class is this
receiver", answered once per (method, receiver):

- **Constraint set** — every member called on the receiver in the method:
  residual, statically resolved and external calls alike. A candidate class must
  answer all of them, counting inherited members, concerns, schema columns and
  association readers (the inheritance closure).
- **Measured on residual members alone** (lower bound; full constraint set and
  closure not yet available): of 7,119 overflow sites, 1,731 have two or more
  residual members on one receiver; 962 of those narrow to ≤ 40 classes and 138
  to exactly one. 5,852 overflow sites see a single residual member, so the full
  constraint set is the lever that matters. 1,238 sites intersect to zero
  classes on direct definitions — inheritance closure fixes those or proves the
  receiver external.
- **Parameter receivers** — when the receiver is a method parameter, the
  argument types at the method's statically resolved call sites join the
  constraint (a union over callers; a single typed caller pins it).
- **Naming prior** — the receiver's last name (arguments, indexing and sigils
  dropped, the text after the last `.` / `::`) is matched against each class's
  short name as word tokens, best first: exact (`invoice` → `Invoice`), singular
  (`invoices` → `Invoice`, `companies` → `Company`), class suffix (`result` →
  `PaymentResult`, name ≥ 4 letters), reverse suffix (`current_user` → `User`,
  `signatory_users` → `User`). It orders the menu and opens the tournament; it
  never removes a candidate. On the TaxDome rows (7,919 grouped sites) it
  narrows 2,567 sites to 1..40 classes; of the 6,105 sites in groups over 40
  classes, 1,972 get a block 1 of 1..40 classes and 302 more a block 1 of the
  best-ranked 40.
- **Exactly one class** after narrowing → static edge (origin static, new run-
  stats bucket `narrowed`), no question.
- **Still > 40** → tournament. Block 1 is the name-matched classes (at most 40,
  best-ranked first) plus "none": a winner with p ≥ the provider threshold ends
  the tournament on one question (`earlyAcceptedGroups`). Otherwise the
  remaining classes run in blocks of 40, each asked with "none"; block winners
  above the floor form the next round, and the block-1 winner (when above the
  floor) joins the first round it fits into without adding a block; at most 3
  rounds after block 1; no winner → site stays residual. A group with no name
  match runs the plain rounds. `CODEGRAPH_RESIDUAL_TOURNAMENT_BUDGET` is spent
  on name-matched tournaments first; the others start once every name-matched
  one has its outcome.
- **Answer becomes a type fact** for the receiver in that method: static
  resolution re-runs for every call on it and for chain hops downstream (two
  fixpoint rounds). Every edge derived this way is `origin = 'model'` with the
  verdict's p, so `trace_path` `minP` and `find_cycles` `hasModelEdge` stay
  truthful.
- **Schema columns answer** (bd 2m83f.55). A class that reads the member as a
  schema column stays in the group's class set with no target and the column's
  value type as its return type. An accepted pick (direct or propagated) whose
  member is a column on that class emits no edge: the site moves to
  `attributeByModel`, which leaves the recall denominator like `externalByModel`
  (stored in `cg_residual_external_sites` with `outcome = 'attribute'`, 064). A
  propagated core value type (`Integer`, `String`, `Hash`, `Time`, …) settles
  the next hop as external (`externalByPropagation`). Column readers are left
  out of a menu only when they number more than the menu limit and would push a
  menu that fit past it. A site whose every narrowed class reads the member as a
  column — or the language excluded as a model column read — has no in-project
  definition: it moves to `noInProjectDef`, counted under `schemaAttribute`
  (`cg_run_stats.schema_attribute`, 064), and gets no row.
- **Too-long methods** — `methodSource` is windowed around the receiver's call
  lines instead of failing the group (`STATE_TOO_LONG`, 15 groups in the A/B).

### 4. "None" in every question

Every menu carries a final option "none of these — defined outside the project".
Probabilities are normalised over menu + none.

- `pick = none` with p ≥ `CODEGRAPH_RESIDUAL_NONE_THRESHOLD` (default 0.8,
  re-set from gate 3) → the site moves to a new run-stats bucket
  `externalByModel`: out of the recall denominator, counted and shown in prime
  next to the model share.
- `CODEGRAPH_RESIDUAL_MIN_MENU` drops to 1: a one-entry menu plus none is a
  binary question. The 150-of-162 "true target absent" finding that justified
  the floor is exactly what "none" answers.
- Verdict store: `pick` nullable for none; question payload version bumped, so
  wave 1 verdicts are not reused for the new question shape (menu hash includes
  the payload version).

## Measurement and rollout

1. Land 1 and 2; reindex TaxDome Ruby (`--force-enrichments codegraph`); record
   recall and residual size.
2. Land 3's static part (constraint set, closure, parameter typing, single-class
   static edges); reindex; record the narrowed-menu distribution.
3. Run the 200-site pre-measurement (gate 4) on the narrowed menus.
4. Land 4 and the Kev question change; Kev run on TaxDome by the user's explicit
   command; record asked share, q/s, GPU utilisation and power read from nucbox
   counters, edges, `externalByModel`.
5. Gates 1–3; then resume `2m83f.24` (lifecycle and corner cases) on this build.

## Out of scope

- Gem vocabularies (rejected by the user).
- Cross-request continuous batching in `kev-rocm-serving`: the A/B showed no GPU
  idle between requests; ≤ 5% recoverable.
- The `--force-enrichments` wall-time regression — P0 `pb435`, separate session.
- Non-Ruby languages: the mechanisms are kernel-level where possible (constraint
  set, tournament, none), Ruby-first in validation.

## Risks

- Parameter typing over callers can widen instead of narrow when callers are
  untyped; it only joins the constraint when at least one caller is typed.
- Tournament cost: a 3-round tournament over 1,000 classes is ~28 questions for
  one receiver. Cap total tournament questions per run
  (`CODEGRAPH_RESIDUAL_TOURNAMENT_BUDGET`) and report how many receivers it
  skipped.
- Type-fact propagation multiplies the effect of a wrong verdict across every
  call on the receiver. Precision gate 3 samples propagated edges as their own
  stratum.
