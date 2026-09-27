# Naming review over a diff, type-name roles and term alignment

Beads: `tea-rags-mcp-fdef2` (diff-time naming review), `tea-rags-mcp-vi0wx`
(type, module and constant names). Parent epic `tea-rags-mcp-4p3sb`. Extends
`2026-09-24-naming-lexicon-design.md`.

## Goal

The naming lexicon answers one question at three scales: what name would THIS
codebase give to this thing.

| Scale           | Tool                                | Status    |
| --------------- | ----------------------------------- | --------- |
| write-time      | `get_naming_lexicon` with `names[]` | shipped   |
| diff-time       | `get_naming_lexicon` with `changes` | this spec |
| repository-time | `get_ontology_report`               | shipped   |

Two gaps close here. An agent adding a class, module, interface, enum or
constant gets no judgement today, because `cg_identifiers` holds value
identifiers only. And a change the agent already wrote is never reviewed against
the vocabulary unless the agent re-lists every name by hand.

## Non-goals

- Declared naming policy (a rules file the tool enforces). Naming rules are
  configured in the agent; the tool judges style and reuse of the project's
  existing domain terms, both derived from the code.
- Architecture norms. `tea-rags-mcp-xb669` (another session) consumes the type
  roles defined here; its contract is in "Handoff to xb669".

## 1. Symbol kind in the codegraph

`cg_symbols` has no kind column: a class and a top-level function are both a
bare `symbol_id`. Guessing from members or inheritance misses member-less types
and misreads PascalCase functions (Go exported functions, Python factories).

- Migration 035 adds `cg_symbols.symbol_kind VARCHAR`:
  `class | module | interface | enum | type_alias | constant | function | method`.
  NULL on rows written before the migration; readers treat NULL as unknown and
  exclude it from type-name judgement rather than guessing.
- Each language walker writes the kind from the node type it already visits, on
  the chunks it already emits. No declaration becomes a NEW symbol: a codegraph
  symbol needs a chunk with the same symbolId, and the chunker gives small type
  declarations (TS `type` / `interface` / `enum`) no chunk of their own and
  module-level constants none at all. Type and constant names travel in their
  own channel instead (§1b).
- Versions: walker axes are already above `main` for every language this release
  cycle, so no bump, only a re-pin; a codegraph recompute
  (`--force-enrichments codegraph`) rewrites `cg_symbols`.

## 1a. Kind roles in call resolution (`jqvbn`)

Once definitions carry a kind, a lookup for a CALLEE must not return a
definition that cannot be called, and a same-named type must not count as a
namesake. Which kinds can be called is a property of the LANGUAGE, not of the
kind vocabulary: Ruby never calls a class by its bare name (`Money(x)` is a
method, the class is only a receiver of `.new`), Go calls interfaces and type
aliases (`Stringer(x)` is a conversion), Swift and Python call enums
(`Color(rawValue:)`, `Color(1)`).

- Each language capability declares
  `symbolKindRoles: { callee: ReadonlySet<SymbolDefinitionKind>; receiver: ReadonlySet<SymbolDefinitionKind> }`.
  The symbol table applies the CALLING file's policy to `lookupByShortName`,
  `lookup(fq)` and `shortNameDefCounts`. A lookup with no role is a type lookup
  and keeps every kind. An untagged definition (NULL kind) serves every role.
- Per language (callee / receiver):

| Language | class | module | interface / protocol / trait | enum | type_alias | constant |
| -------- | ----- | ------ | ---------------------------- | ---- | ---------- | -------- |
| TS / JS  | C R   | R      | —                            | R    | —          | R        |
| Java     | C R   | —      | R                            | R    | —          | R        |
| Swift    | C R   | —      | R                            | C R  | C R        | R        |
| Go       | C R   | R      | C R                          | —    | C R        | R        |
| Rust     | C R   | R      | R                            | R    | —          | R        |
| Python   | C R   | R      | —                            | C R  | C          | R        |
| Ruby     | R     | R      | —                            | —    | —          | R        |
| Bash     | —     | —      | —                            | —    | —          | —        |

`function` and `method` are C R everywhere they exist. A static interface member
call (`Comparator.naturalOrder()`) makes the interface a receiver. A Rust call
spelled with an enum's name builds a variant (`Style(s)` is a tuple variant or
struct, never `enum Style`), so a Rust enum is a receiver only. A Ruby constant
reference (`receiver === member`, e.g. an association class) looks up with the
receiver role.

- The first cut (commit on `worktree-naming-waves`) used one language-agnostic
  predicate and opted in TS/JS and Rust only. This table replaces it; Go, Swift,
  Java and Ruby join through their capability, not by being skipped.
- Gate per language: `codegraph-chain-tally --time-only --kind-stats` before and
  after on that language's corpus. A lost edge is inspected; it may only go if
  it was wrong.

## 1b. Type and constant declarations, every language

`FileExtraction.typeDeclarations` (`TypeDeclarationFact`) already exists and
only the Swift walker fills it, for the Swift resolver. It is generalized
instead of adding a second channel.

- The fact gains `symbolKind: SymbolDefinitionKind` and `line`. Swift's
  `declarationKind` stays as Swift detail. `supertypes` / `conforms` carry the
  ancestors, so roles read no join.
- Every walker emits one fact per type-level declaration and per file-level
  constant, whether or not it is a chunk or a symbol:

| Language   | Declarations                                                                                              |
| ---------- | --------------------------------------------------------------------------------------------------------- |
| TypeScript | class, interface, type alias, enum, exported/top-level `const` that is not function-valued                |
| JavaScript | class, top-level `const` that is not function-valued                                                      |
| Python     | class (Enum subclass → enum), `X: TypeAlias` / `type X =` / `NewType`, module-level UPPER_CASE assignment |
| Ruby       | class, module, constant assignment                                                                        |
| Go         | struct / defined type (class), interface, alias, package-level `const`                                    |
| Rust       | struct / union (class), enum, trait (interface), `type`, `const` / `static`, `mod`                        |
| Java       | class, record (class), interface, annotation (interface), enum, `static final` field                      |
| Swift      | class / struct / actor (class), protocol, enum, typealias; extensions stay `reopens: true`                |
| Bash       | none                                                                                                      |

- Resolution keeps what it reads today: run-state hydrates `typeDeclarations`
  only for languages whose resolver reads them (a capability flag), so the new
  facts of other languages do not enter the run-global maps.
- Persistence: migration 038 adds
  `cg_type_declarations(rel_path, language, type_id, short_name, symbol_kind, line, reopens, supertypes VARCHAR[])`,
  replaced per file at flush and deleted with the file, like `cg_identifiers`.
- `readTypeNameRows` (§2) reads `cg_type_declarations` (`reopens = false`) as
  its single source, for every language.
- Diff mode takes type and constant drafts straight from the in-memory
  extraction's `typeDeclarations`.

## 2. Type roles

A role is the suffix a family of types shares (`…Strategy`, `…Preset`,
`…Store`). Granularity is the TYPE; a file's role is the dominant role of its
top-level types.

Evidence, strongest first (owner decision: inheritance primary, directory
secondary):

1. **Inheritance family.** Types with a common ancestor in
   `cg_symbols_inheritance` whose names share a tail word: that word is the
   family's role. `extends SymbolResolutionStrategy` → `…Strategy`.
2. **Directory.** The directory's MAJORITY family: the plurality tail word of
   its primary types, carried by ≥ 2 files and by at least half (share ≥ 0.5) of
   the directory's files that have a primary. 0.5 is the definition of a
   majority, not a tuned value. A plurality tie is no role. A lower share (0.2)
   let two helper files name a directory on the live self-index.
3. **Project suffix.** A tail word carried by the primary types of ≥ k files in
   ≥ 2 directories. Filters one-off coincidences. k starts at 3 and is measured
   on the corpora below. The project suffix only CONFIRMS: a draft whose last
   word is one is CONFORMS on the role axis, and a draft whose last word is not
   one falls through to term alignment. It never produces MISFIT, because a
   suffix popular elsewhere with no inheritance or directory anchor is a guess,
   not an expected role.

Directory and suffix evidence read ONE type per file, its primary: the type
whose words overlap the file stem's words most, with a trailing plural
normalized on both sides (`errors.ts` matches `*Error`). A tie goes to the
fewest words beyond the stem's (`CompletionRunner` over `CompletionRunnerDeps`),
then to the kind (class > interface / enum / module > type alias > the rest),
then to the first declared; no overlap at all goes to the first declared. So one
`errors.ts` of ten `*Error` classes is one file's convention, and a
`RerankOptions` beside `Reranker` belongs to reranker.ts's subject, not to a
role. Inheritance evidence reads every type.

**What is not a role (`49fsr`).** Live on taxdome, a role-precision sample found
verbs, events and namespaces named as roles: `InitialSync::Finish` → `finish`,
`BatchCreateAsync` → `async`, `ActivateOnLogin` → `login`, `KbaAttemptCreate` →
`create` (all `include KindOfService`, which the Ruby walker records as a
supertype), `ClientPortalSettingsUpdated` → `updated` (an event under
`BaseEvent`), `module Communication` → `communication`, and the TS type aliases
`OverviewBlockType` → `type` and `ProposalPackage` → `package`. Five rules
remove them. Each comes from the project's own data or from the kind vocabulary,
not from a word list:

1. **A family's role is its majority head.** The inheritance family's plurality
   head must be carried by ≥ 2 members and by at least half the family (the same
   0.5 majority as the directory); a split family has none. `create` was the
   plurality of `KindOfService`'s 2,554 members at 324 (13%), and `updated` of
   `BaseEvent`'s 124 at 30 (24%).
2. **A head that varies inside a family is that family's slot.** When a family
   holds a majority (≥ 2, ≥ half) of a directory or suffix word's carriers and
   its role is not that word, and no family holding such a majority names it,
   the word is no role. The carriers are kin through the ancestor, and their
   heads are what varies. On taxdome this vetoes about 230 suffix and directory
   words, nearly all under `KindOfService` (`destroy`, `update`, `clone`,
   `async`, `finish`) or `BaseEvent` (`created`, `deleted`, `changed`). On the
   self-index it vetoes nothing. A mixin family with no role never vetoes a head
   that another majority family names: a `*Form` under both `BaseForm` and
   `ActiveModel::Model` keeps `form`.
3. **A namespace is not a primary.** A `module` row competes for the file's
   primary only when its name overlaps the file stem. One named for its file is
   the file's subject (a Ruby concern, a TS `export const fooHook = {…}` object,
   which the TS walker records as `module`). One that is not is the namespace
   wrapping the subject. A taxdome contract `request.rb` holds
   `module Communication` around `Request = Data.define(…)`, a constant, so the
   file now has no primary. The same test judges a DRAFT (`59q9c`): a draft
   whose `symbolKind` is `module` and whose name shares no word with its file's
   stem is a namespace, so no role applies to it. It gets no MISFIT and no role
   confirmation (neither from the directory or family role nor from a project
   suffix). Diff mode knows every draft's kind; a `names[]` draft carries it
   when the caller passes `symbolKind`. Live on taxdome, `module GettingPaid`
   and `module Quickbooks` around a worker class in
   `app/workers/getting_paid/quickbooks/` were MISFIT → `GettingPaidWorker` /
   `QuickbooksWorker`. A module named for its file is still that file's subject
   and is still judged by the directory role.
4. **A head restating the declaration kind is no role.** A name whose last word
   is one of the words of its own kind (`type_alias` → `type`, `alias`; `enum`;
   `interface`) says nothing its declaration does not. A TS `OverviewBlockType`
   carries no role, but a GraphQL `UserType` class still can.
5. **A project suffix counts distinct qualified names.** The ≥ k threshold
   counts distinct names in which a word precedes the head. A bare `Finish` is
   the concept itself, and a `ProposalPackage` declared in two files is one
   name, so `Package`, `ProposalPackage` ×2 and `SelectedPackage` make no
   `package` suffix. Once a suffix holds, a bare carrier (`Props`) shares it.

Measured with `t9-roles.mts` (seed 7, sample 30), read-only, on a copy of the
taxdome codegraph DB: type coverage fell from 62.8% to 51.5%, Ruby from 74.9% to
57.9%, TS from 52.1% to 45.8%. Precision on the hand-checked sample rose from
25/30 to 27/30. On the self-index, coverage went from 32.3% to 31.5% (18
assignments lost: `*Type` aliases, `Migration`'s `*Indexes`, and three suffixes
that had rested on a bare name) and the sample stayed 30/30. The rename eval was
unchanged: 0/17 caught, 9 flagged-other, 8 silent, control 5/40. Of the three
misses in that sample, `GuestBlob` → `blob` was a labelling error, not a wrong
role: `type GuestBlob = Pick<Blob<'signedId'>, 'signedId' | 'fileName'>` is a
projection of `Blob`, so `blob` is its role. The other two are removed by the
membership rules below.

The `Cookies` ancestor seen on `ApplicationController` is not a defect in role
evidence. The Ruby walker records `include ActionController::Cookies` as a
supertype, and families key on the last segment. The role it yields
(`controller`) is right; only the scope label is a mixin. Last-segment keying
does merge distinct ancestors that share a name (`Base` is eight classes on
taxdome). Resolving written supertypes to declared type ids would separate them,
but that is a per-language lookup and was left out of this change.

**The nearest family decides (`5ulz2`).** The merge above produced a wrong role
live on taxdome. A draft
`ExportAsyncWorkflow < Platform::Async::Workflow::Worker` came back MISFIT →
`ExportAsyncWorkflowWorker`, with examples `AccountsCleanupWorker` and
`ApplicationWorker`. The `Worker` family was six supertypes merged:
`Sidekiq::Throttled::Worker` (73 members), `Platform::Async::Batch::Worker`
(10), `Platform::Async::Operation::Worker` (8), `Sidekiq::Worker` (4),
`Platform::Async::Workflow::Worker` (2) and `Shoryuken::Worker` (1). The two
direct subclasses of the draft's supertype are `ImportAsyncWorkflow` and
`UpdateAsyncWorkflow`. Transitive supertypes (`projectSupertypes`) play no part:
families are keyed on a row's declared supertypes, and the role came from the
last-segment merge alone.

A namespaced supertype as written (leading `::` and generic arguments dropped)
is now a family of its own, nested in its last-segment family. It takes a role
by the same majority rule (≥ 2 members, ≥ half). When that role differs from the
last-segment family's, its members carry it as an inheritance assignment scoped
by the written name. When the two agree, nothing is added. A draft's `extends`
looks up the written family first and falls back to the last segment when the
written family has no role, whether it has too few subclasses or they split. No
id resolution is involved: a supertype written relatively (`Workflow::Worker`)
is a different key and simply falls back.

The role stays a single head word. Every evidence kind, `carriedInName`, the
head-alternative exclusions and the MISFIT suggestion (the role word inserted
after the head) work on one word, and `async` in `ImportAsyncWorkflow` is a
qualifier like any other. So `ExportWorkflow` CONFORMS to `workflow` too. A
multi-word tail convention (`AsyncWorkflow`) would change what a role is for all
three evidence kinds at once, and two members are too little evidence to measure
that on. A draft that misses the head (`ExportJob`) is MISFIT →
`ExportJobWorkflow`.

Measured read-only on a copy of taxdome `_v15`, with `t9-roles.mts` and a
per-type role dump diffed before and after:

| Measure                                         | Before               | After                                        |
| ----------------------------------------------- | -------------------- | -------------------------------------------- |
| taxdome coverage                                | 19,267 (57.3%)       | 19,271 (57.3%)                               |
| Ruby / TS                                       | 11,083 / 8,184       | 11,087 / 8,184                               |
| types whose roles changed                       | —                    | 20, all additions, 0 removed; 20 of 20 right |
| t9 seed 7 sample (30)                           | 30/30                | 30/30 (a different draw: the pool moved)     |
| rename eval (caught / other / silent / control) | 0 / 7 / 10 / 6 of 40 | 0 / 7 / 10 / 6 of 40, byte-identical         |
| live `ExportAsyncWorkflow` / `ExportWorkflow`   | MISFIT → `…Worker`   | CONFORMS, `workflow`, siblings as examples   |

The 20 changes are 2 `*AsyncWorkflow`s (`workflow`), 6 `*::Process` classes
under `GettingPaid::Quickbooks::Webhooks::Base` (`process`), 2 controllers under
`ActionController::Base`, 1 of them newly with a role, 3 templates and 2
`ClientDescription`s through a namespaced `InlineImages` mixin, 2 mailers
through `ActionView::Helpers::UrlHelper` (a mixin scope that names the right
role, as `Cookies` does above), and 3 `*Process` classes in
`activity_feed/processes/`. The last 3 come through the connector reading:
`process` is now a kind word (`typeNameParser`), so `SendToOpensearchProcess`,
`UploadToS3Process` and `DeleteExpiredMonthlyIndicesProcess` are headed by
`process` again. That fixes two of the six wrong changes the connector rule
below records.

**Directory-role membership (`tun7x`).** A directory role speaks only for the
family it names. Its family is COHESIVE when the role's carriers in the
directory share a supertype: the most carried supertype (last namespace segment
of `cg_type_declarations.supertypes`) is carried by ≥ 2 carriers and by at least
half of them, the same majority that defines the role. Ties at that count are
all the family's. A draft is a member when its KNOWN supertypes include one of
them. Its supertypes are known when it states `extends`, or when it names a
declaration already at its `path`, whose own supertypes then count. A draft
known not to be a member gets no directory role. The role neither demands the
suffix (no MISFIT) nor confirms it, and its word is no head alternative by
meaning for that draft. A new draft that states no `extends` has not said it
declares none, so it is judged as before. A family whose carriers share no
supertype also keeps the plain majority rule.

On the self-index 21 of 35 directory roles are cohesive: every `strategy`,
`preset`, `signal` and `accumulator` directory, plus `drift/`
(`IndexDriftMonitor`), `footprint/` (`CollectionArtifact`) and `migration/`
(`MigrationRunner`). The 14 without a shared supertype include `cli/commands/`
`*Args`, `api/internal/ops`, `*/chunking/` hooks and `facades/`.
`ruby/resolver/strategies/` has 15 `*SymbolResolutionStrategy` carriers, all
`extends SymbolResolutionStrategy`, beside four `*DispatchResolver` that
`implements DispatchResolverComponent`. Two of those four were control false
flags (MISFIT → `…Strategy`), and the rule clears both. `cli/commands/`
`FormatProjectsOptions` stays MISFIT → `…Args`, because no `*Args` declares a
supertype and the data cannot separate a CLI argument type from a formatter's
options. The five MISFITs of the 20-draft measurement set are new drafts with no
`extends` in cohesive directories, and all five stay.

**Family membership: form and supertype (`49fsr`).** The two wrong roles left in
the 27/30 taxdome sample were types that carry a family's tail word without
belonging to the family. `Billing::Invoices::SendFailedPaymentNotification` is a
verb-first command (`include KindOfService`) whose head is the object of its
verb; it took `notification` from the project suffix. The mixin
`module Communication::ClientPushBaseData` took `data` from a suffix family of
164 TS type aliases. Two rules decide membership, and one predicate
(`isRoleFamilyMember`) applies them both to an existing type during derivation
and to a draft during judgement, so the two are judged the same way:

1. **Kind homogeneity (project suffix).** A declaration is one of two forms: a
   `module` (a namespace, a mixin, a TS `const` object), or a type, whatever
   kind declares it (class, interface, type alias, enum). A suffix family names
   only its dominant form, the one at least half its carriers share; a tie means
   no dominant form. `*Data` is 164 type aliases, 13 classes and 2 modules, so
   the modules drop out. A directory family has no form test, because a module
   named for its file there is the file's subject and is still held to the
   directory's role (`59q9c`).
2. **Supertype cohesion (directory and project suffix).** This is the `tun7x`
   rule, now applied to members as well as drafts, and to suffix families. The
   dominant supertype is counted over the carriers of the family's form that can
   declare one. A type alias declares none, so it is neither counted nor
   excluded. A carrier whose supertypes do not include the dominant one is no
   member. `*Notification` is cohesive at 68 of its 103 classes extending
   `Notification`; counted over all 140 carriers, including the 37 TS aliases,
   it would be 48.6% and not cohesive. A type's supertypes include the type
   itself (`ApplicationForm` belongs to the family that extends it) and what the
   project declares for its supertypes, transitively, by last segment
   (`ReplaceForm < ActivateForm < ApplicationForm`). Without these two, the
   first cut dropped the family's own base classes and every second-generation
   subclass.

A draft's kind is the `symbolKind` it states, else that of the declaration it
names at its `path`. Its supertypes are known on the same terms as under
`tun7x`. When either is unknown, that test does not apply. A project suffix now
confirms a draft only if the draft is a member of its family: an existing
`SendFailedPaymentNotification` or a `module ClientPushBaseData` draft is no
longer CONFORMS on the strength of the suffix.

Measured read-only with `t9-roles.mts` on copies of the codegraph DBs. On a
fresh taxdome index (`_v15`, 33,623 types), coverage fell from 17,212 (51.2%) to
16,836 (50.1%). The 649 removed assignments split into 292 by form and 333 by
supertype on project suffixes, and 24 by supertype on directories. 376 types
lost every role. The largest groups are 37 `*Helper` classes in a
module-dominated family, 24 `*Form` classes without `ApplicationForm`, 20
`*Template` non-records, and 11 `*Query` classes. In a seeded sample of 40 of
those types, about 26 removals are right (verb-first `KindOfService` commands
such as `GetEvents` and `SendActionRequiredNotification`, and concern or
contract modules), about 8 are false negatives (helper classes, a
`NylasErrorHandler < Middleware`, `*Form` classes with no superclass), and 6 are
doubtful. On the older `_v14` copy of the 27/30 sample, coverage went from
17,155 to 16,780. Both wrong roles are gone, `GuestBlob` keeps `blob`, and all
27 correct items keep a role (`BatchHelper` keeps its directory `helper`), so
the sample is 28/28. On fresh seeds 7, 11 and 23 of `_v15`, 1 of the 90
assignments sampled before the change was removed: `SuggestionsResolver`, a
class in a module-dominated `*Resolver` family, which is a false negative.
Hand-checked after the change, the new samples hold 2 wrong roles out of 90,
`SendFirmAttributes` → `attributes` and `RenderShortcodeTexts` → `texts`. Both
are verb-first commands the change did not touch, since the change only removes
assignments. Their families are not cohesive: the 8 `*Attributes` classes split
4 `Model` and 4 `KindOfService`, and `*Texts` has one class. On the self-index,
coverage went from 725 (31.5%) to 715 (31.0%). Of the 10 types that lost every
role, most are false negatives from TS structural typing: `BatchAccumulator` and
`PointsAccumulator` are accumulators that do not declare
`implements StatsAccumulator`. The seed-7 sample stayed 30/30. The rename eval
was unchanged: 0/17 caught, 9 flagged-other, 8 silent, control 5/40.

A per-kind form, with an interface and a type alias merged but a class kept
apart, was measured and rejected. It removes both taxdome misses, but on the
self-index it splits every TS family whose contract is an interface:
`CacheStore`, `CodeChunker` and `EnrichmentProvider` lost their roles, and
coverage fell to 686. On taxdome it fell to 15,979.

**Only a declared supertype can miss.** A type that declares no supertype is not
evidence of non-membership. TS types match a family structurally without writing
`implements`, and Ruby duck-types. So the supertype test excludes a type only
when it declares at least one supertype and none of them reaches, transitively,
a supertype the family shares. A draft's supertypes count as declared under the
same rule: its `extends`, or its own row's ancestors.
`SendFailedPaymentNotification` declares `KindOfService` and stays out;
`BatchAccumulator`, which declares nothing, is back among the `*Accumulator`
family. Measured on the same copies, against the first cut:

| Measure                                         | first cut           | declared-only       |
| ----------------------------------------------- | ------------------- | ------------------- |
| taxdome `_v15` coverage                         | 16,836 (50.1%)      | 16,895 (50.2%)      |
| types losing every role (vs main)               | 376                 | 318                 |
| self-index coverage                             | 715 (31.0%)         | 723 (31.4%)         |
| self-index types losing every role              | 10                  | 2 (both by form)    |
| `_v14` 27/30 sample                             | 28/28               | 28/28               |
| wrong roles, fresh seeds 7/11/23 (of 90)        | 2                   | 1                   |
| self-index seed 7                               | 30/30               | 30/30               |
| rename eval (caught / other / silent / control) | 0 / 9 / 8 / 5 of 40 | 0 / 9 / 8 / 5 of 40 |

Of the 40 sampled types the first cut stripped, 3 come back, all right:
`NotificationUpdateForm` (a form with no superclass), `DrillOption` (a TS
interface) and `IndexTemplate`. The other 37 either fail the form test or
declare an unrelated supertype. The one wrong role left in the fresh samples,
`IssueReplacementInvoice` → `invoice`, is a verb-first command in a family where
`KindOfService` is the dominant supertype of the classes (12 of 21 in
`*Invoice`). There the command is a member by the rule, and no supertype test
can separate it.

**A dispersed family's kind.** `SendFirmAttributes`, `RenderShortcodeTexts` and
`IssueReplacementInvoice` are commands. Their head is the object of the verb,
not what they are, so a suffix family hands them `attributes`, `texts` and
`invoice`. What they are is written in two other places: the supertype
(`KindOfService`) and the directory (`app/services/`). The rule reads both. Take
an inheritance family that has no role, whose supertype the project declares,
and whose members mostly do not end in the supertype's head word (singular),
here `service`. A member whose path has a directory segment whose last word,
singularised, is that word takes it as an inheritance role flagged
`carriedInName: false`. Its own head is the family's varying slot, so it takes
no directory or suffix role except that same word. When two such families agree,
the larger one names the kind. Every threshold is an existing one: two members
make a family, and half of them is the familyShare majority. No verb list or
dictionary is involved.

Both gates are needed. Without the directory agreement, `ApplicationRecord`
(`record`, 384 members, 0 of them under a `records/` segment) would strip
`GuestBlob` of `blob`, together with 250 other model suffixes. Without the
project-declared test, the external `ActiveModel::Model` under `app/models/`
would take `settings` / `data` / `mapping` from 34 value objects that carry them
correctly. On taxdome `_v15`, `KindOfService` agrees on 2,544 members and
disagrees on 10, which live outside `app/services/`. `BaseEvent` agrees on 124
and `AsyncOperation` on 106. `ApplicationRecord`, `FindActor`, `ValidateJsonb`,
`Enforcement` and the `*Helper` mixins agree on none.

The draft verdict follows the same rule. A draft extending `KindOfService`
expects the role `service` with `carriedInName: false`. That role never produces
a MISFIT, and it is not the head that confirms the name.
`SendFailedPaymentNotification` and `SendFailedPaymentService` both get
`CONFORMS` with
`role: {word: "service", evidence: "inheritance", carriedInName: false}`,
provided lexical alignment finds nothing. The kind is also held back as a head
alternative. No new verdict state was needed: CONFORMS already means "consistent
with the vocabulary", and the role says what the type is.

Measured on the same copies against declared-only (C):

| Measure                                         | C                   | + dispersed kind                                |
| ----------------------------------------------- | ------------------- | ----------------------------------------------- |
| taxdome `_v15` coverage                         | 16,895 (50.2%)      | 19,311 (57.4%)                                  |
| types newly with a role / losing every role     | —                   | 2,416 / 0                                       |
| suffix / directory roles removed                | —                   | 389                                             |
| kind roles added (`carriedInName: false`)       | —                   | 2,831                                           |
| removed, 40 hand-checked                        | —                   | 38 right, 2 doubtful                            |
| added, 30 hand-checked                          | —                   | 30 right                                        |
| self-index coverage                             | 723 (31.4%)         | 741 (32.1%)                                     |
| self-index changes                              | —                   | +21 `migration`, −3, all right                  |
| wrong roles, fresh seeds 7/11/23 (of 90)        | 1                   | 0 (3 doubtful)                                  |
| `_v14` seed 7                                   | 28/28               | 29/30 (`ObjectsForFirm` → `firm`, pre-existing) |
| self-index seed 7                               | 30/30               | 30/30                                           |
| rename eval (caught / other / silent / control) | 0 / 9 / 8 / 5 of 40 | 0 / 9 / 8 / 5 of 40                             |

The kinds added are `KindOfService` → `service` 2,544, `BaseEvent` → `event`
124, `AsyncOperation` → `operation` 106, `Automation` 15, `BaseParams` 14, and
28 more across seven families. The two doubtful removals are `EidEasySignStep`
(`step`) and `TokenManager` (`manager`): both are services whose head may also
be their kind. All three target misses are fixed, and each now takes `service`.
`SendFailedPaymentNotification`, `ClientPushBaseData` and `GuestBlob` stay as
the membership rule left them.

Rejected, measured on the same copies:

- **Drop-only.** A dispersed project-declared family (≥ 2 members, no role)
  strips its members' suffix and directory roles, with no directory agreement
  and no role added. It removes 664 assignments, 250 of them from
  `ApplicationRecord` models that carry their suffix correctly (`ClientNote` →
  `note`, `WikiPage` → `page`). A 40-item hand check found 29 right, 10 false
  negatives and 1 doubtful. Coverage drops to 48.3%.
- **Verb-initial first word from the project's own identifiers.** A type whose
  first word W leads multi-word function and method names in at least θ of the
  names containing it (≥ 20 observations) takes no suffix role. The first
  formulation, W leading methods against W heading types (`m/(m+h)`), does not
  separate verbs from nouns: `chat` 1.00, `client` 0.81, `create` 0.90, `send`
  0.95, because Ruby and TS methods lead with nouns (`client_name`). The
  lead-versus-inner position ratio is sharper, but its distribution over the
  carriers' first words has no valley. It falls monotonically from 0.4 (words
  per 0.1 bucket from 0.4 up: 91, 62, 41, 23, 13, 25, 2), so θ = 0.85 is a tail
  cut, not a mode boundary. It catches `render`, `get`, `build`, `process` and
  `track`, but misses `send` (0.76), `create` (0.83), `update` (0.46) and
  `issue` (5 observations). It fixes 1 of the 3 target misses. Precision is 12
  of 40 on taxdome and 0 of 10 on the self-index. It strips roles the name does
  carry: `TrackSignupWorker` → `worker`, `CalculateSummaryForm` → `form`, the
  React-hook contract types `Use*Props` / `Use*Params` / `Use*Result`, and
  `GetCallersRequest`. Combining it with the kind adds only these false
  negatives, 215 of them on `_v15`.

**A trailing prepositional complement is not the head.** The `_v14` seed-7 miss
above: `Supporting::ActivityFeed::Queries::ObjectsForFirm` took `firm` from its
directory and from the project suffix. Its head is `objects`; `ForFirm` names
what the objects belong to. Five of the seven primaries in
`activity_feed/queries/` are `*ForFirm` queries, so the directory's majority
head was the complement, and the same five names were five of the seven
qualified names that made `firm` a project suffix. The same shape recurs:
`ChatThreadMessageToPrint` (`print`), `JobToLink` (`link`), `NoteWithJobs`
(`jobs`), `FormWithErrors` (`errors`).

One function owns the reading, `typeNameParts` (`name-slots.ts`). Role
derivation, the draft verdict, head and qualifier counts, term alignment and
`splitNameSlots` all go through it. It returns qualifiers, head and complement.
A connector is a preposition in an interior position, never the first word nor
the last, so `SignIn`, `GroupBy` and `WithRouter` stay plain compounds. A name
with a connector is headed by the word before its first connector, the words
after the connector are its complement, and the complement is neither head nor
qualifier. It contributes no modifier use, no qualifier to align, and no MISFIT:
an expected role is inserted after the head (`ObjectsForClient` →
`ObjectsFinderForClient`). For CONFORMS by alignment the complement is read as a
name of its own and held to the same test (known head, established qualifiers).
A connector is never compared with a path term either: `for` is grammar, not a
word `supporting` could replace.

The last word stays the head when it is a KIND word. A kind word is an
inheritance or directory role that the population's names carry WITHOUT a
connector, derived by a first pass over exactly those names (`typeNameParser`).
`BatchMarkAsReadWorker` is a worker,
`SignedDocumentBySignerNotificationSerializer` a serializer. A project suffix
does not count as a kind. It is the evidence a bare entity noun earns: `firm` is
a project suffix of connector-free Ruby names (`CurrentFirm` and two more), and
an entity noun is exactly what a preposition takes as its object.

The connector words are a closed class, English prepositions:
`for by to from with in on at as via per into over without`. The user-approved
direction was a class derived from the project's own positional distribution,
and it was measured first. It does not separate. Take the interior share of each
word over distinct multi-word type names, for words seen ≥ 20 times.

| Corpus              | Words | Bins 0.80 → 1.00 | Top of the distribution                                                                                                                                                                |
| ------------------- | ----- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| taxdome `_v15` Ruby | 212   | 3 / 9 / 0 / 8    | `uploaded` 1.00 (27/27, never first or last) beside `and`, `to`, `for`, `with`, `from`, `as`, `by`; `on` 0.90 and `in` 0.88 inside the noun continuum (`intent`, `return`, `requests`) |
| taxdome TS          | 188   | 3 / 1 / 3 / 4    | `to`, `and`, `threads` 1.00, `for`; `with` 0.92 between `sidebar` 0.93 and `preset` 0.91; `by` 0.83 below `cell`                                                                       |
| self-index TS       | 82    | 1 / 0 / 1 / 3    | `db`, `program` 1.00 and `resolution` 0.95, no preposition at all; at n ≥ 5 `by` (n = 5) sits among 20+ nouns at 1.00                                                                  |

Each bin is 0.05 wide.

The Ruby bins show a dip at 0.90–0.95, but the band above it holds `uploaded`,
and the self-index band holds only compound interiors. Applying that band as a
rule would head `SymbolResolutionStrategy` by `symbol`. Neighbour diversity does
not separate them either (`as` L 0.15, `intent` L 0.13). The same words in
method and identifier names were measured too (taxdome ≈ 26k Ruby / 47k TS
names, self-index 12k). Prepositions spread from 0.07 (`on`: TS `onClick`
handlers) to 0.9, mixed with nouns (`spec` 0.98, `v1` 1.00, `hub` 1.00). No
valley there either. By position, a preposition and the inner word of a fixed
compound look the same, so the class is taken from grammar. Three words were
left out on data:

- `of` is the partitive of a classifier: the members of `KindOfService` are
  services, and the same holds for `OutOfScope…`.
- `and` / `or` coordinate inside one compound, and the compound's head stays
  last: `CardAndBankPaymentMethodType`, `FindOrCreate`,
  `ConfigureAndSendDraftSigner`.

Measured on the copies, per-language evidence as production reads it: 484 Ruby
and 264 TS connector names on `_v15`. Of these, 204 Ruby and 85 TS stay
head-final by a kind word (Ruby `worker` 55, `error` 36, `serializer` 32; TS
`context` 14, `props` 12), and 280 and 179 are headed before the connector (Ruby
`firm` 15, `user` 9, `clients` 8; TS `confirm` 10, `id` 9, `print` 4). The
self-index has 20: 9 head-final, 11 complement.

| Measure                                         | Before                          | After                                                    |
| ----------------------------------------------- | ------------------------------- | -------------------------------------------------------- |
| taxdome `_v15` coverage                         | 19,311 (57.4%)                  | 19,270 (57.3%)                                           |
| `_v15` Ruby / TS                                | 71.6% / 45.3%                   | 71.4% / 45.2%                                            |
| `_v14` coverage                                 | 19,248 (57.7%)                  | 19,207 (57.6%)                                           |
| self-index coverage                             | 741 (32.1%)                     | 741 (32.1%), 0 changes                                   |
| `_v15` strongest-role changes                   | —                               | 173: 89 own head moved, 84 neighbour recount             |
| changes, 30 hand-checked (seed 7)               | —                               | 19 right, 6 wrong, 5 doubtful                            |
| `_v14` seed 7                                   | 29/30                           | 30/30                                                    |
| `_v15` seeds 7 / 11 / 23                        | —                               | 30 / 30 / 30                                             |
| self-index seed 7                               | 30/30                           | 30/30                                                    |
| rename eval (caught / other / silent / control) | 0 / 9 / 8 / 6 of 40             | 0 / 7 / 10 / 6 of 40                                     |
| live `ObjectsForClient` in `queries/`           | MISFIT → `ObjectsForClientFirm` | CONFORMS, alternative `supporting` for `objects` (0.716) |

Most own-head changes are the target class: `ChatThreadMessageToPrint` →
`message`, `JobToLink` → `job`, `AutomationToConfirm` → `automation`,
`ResponseWithMeta` → `response`, `InvoiceLineItemWithTimeEntries` → `item`, and
the `queries/` directory losing `firm`. Neighbour recounts are suffixes that the
complements themselves had propped up. `token` lost `GetByToken`,
`ConfirmWithToken` and `ResendByExpiredToken`. `blob` lost `CreateFromBlob` and
`EmailTemplateWithBlob`. `owner`, `attributes` and `api` went the same way.

All six wrong changes come from the rule's one blind spot: a complement that
ends in the name's real head while that head is a kind nowhere in the
population.

- `SendToOpensearchProcess` and its neighbour
  `DeleteExpiredMonthlyIndicesProcess` lose `directory:process`.
- `AsyncOperation` loses the `operation` suffix in the recount.
- `BulkAddClientsToPipelineBody` is headed `clients`, and the recount gives
  `NewProposalDefaultClients` a `clients` suffix.
- `TemplateSelectWithHookParamsBase` loses `base`.

The rename eval row compares the pre-fix `main` build and this build, run
interleaved twice against the same index. Each build reproduced itself across
both runs, and the two outputs differ on exactly two pairs. An earlier `main`
run read control 5/40, but the auto-update watcher refreshed the index after it.
Measured together, `main` also gives 6/40, including the `FileScanner` →
`reader` flag. That flag is index drift, not this change. Rebuilt offline from
the same rows and concept names, `FileScanner` has identical pairs under both
lexicons: m = 5, quantile 0.9^(1/5) = 0.979, floor 0.642, `scanner`~`reader`
0.687.

The two pairs that move are `SnapshotV1ToV2` → `SnapshotV2MtimeSize` and
`SnapshotV2ToSharded` → `SnapshotV3Sharded`, from NEW_TERM to silent. Before the
fix their only unestablished word was `to`: `snapshot` and `sharded` are
established, and `v1` and `v2` are version tokens. The owner did drop `to` in
both renames, but the flag named no replacement. The one alternative it offered,
`access` on `SnapshotV2ToSharded`, points nowhere near `v3`. It fired because a
preposition was counted as a qualifier, and every `XToY` name trips that no
matter what it means. That is the defect this rule removes, so the eval's
flagged-other count falls by two wrong-reason flags. The version-token-as-head
reading (`SchemaV9` → `v9`) is untouched.

Rejected, measured on the same copies:

- **Unguarded: head before the first connector, always.** 443 strongest-role
  changes on `_v15`, most of them the families that end in a kind: `error` −43,
  `worker` −42, `serializer` −35, `form` −11, `context` −7, `notification` −6.
- **Guard by the project suffixes of connector-free names too.** The guard's
  roles already come from connector-free names only, so the `*ForFirm` names
  cannot feed it. `firm` still qualifies there: Ruby services name their object
  last (`UpdateFirm`, `TrackNewFirm`, `ResolvesUserFirm`, `AssignsCurrentFirm`,
  `RepairTaskTagsCrossFirm`, `DemoFirm`). On `_v15` this variant flips 54 Ruby
  and 65 TS connector names back to their complement: `firm` ×15, `user` ×9,
  `email` ×6, `id` ×9, `type` ×7, `policy` ×6, `ResponseWithMeta` → `meta`,
  `NoteWithId` → `id`. `ObjectsForFirm` is headed `firm` again. Of the six wrong
  changes above it fixes one, `…PipelineBody`. `process`, `base` and `operation`
  are no connector-free suffix, so the other five stay. A suffix count cannot
  tell a kind from an entity noun that verb-object names also end in.
- **Guard by the type's own supertypes.** Under this guard, a connector name
  stays head-final when its last word, singular, is the head of one of its own
  declared supertypes, followed transitively through project types
  (`projectSupertypes`). It flips no name on `_v15`, `_v14` or the self-index,
  so none of the six is fixed. `SendToOpensearchProcess`,
  `DeleteExpiredMonthlyIndicesProcess`, `TemplateSelectWithHookParamsBase`,
  `BulkAddClientsToPipelineBody` and `NewProposalDefaultClients` declare no
  supertype at all. `RunBatchApplyToClientsAsyncOperation` extends
  `KindOfService` and `KindOfServiceTask`, not `AsyncOperation`.
  `AsyncOperation` itself carries no connector: it lost its suffix only in the
  recount. `ObjectsForFirm` declares none, so it keeps `objects`.
- **Guard by the file's own directory word.** Under this guard, the last word
  stays the head when it equals the singular last word of the directory the file
  sits in (`processes/send_to_opensearch_process.rb`). On `_v15` it flips 93
  Ruby and 5 TS declarations. Most are false. The Ruby API contracts live in
  `list_by_contact/request.rb`, a directory named after the type itself, so
  `ListByContact`, `FindForEmail` and `ListByUser` are headed `contact`, `email`
  and `user`. Verb services sit in a directory named for their object:
  `MigrateBlobsToImages` in `inline_images/` and `AssignApToFirm` in `firms/`.
  Of a 20-item hand check, 3 flips are right and 17 wrong. The right ones are
  `SendToOpensearchProcess`, `UploadToS3Process` and
  `DocumentsUploadedByConcern`. Across all 98 flips, about 8 are right,
  including the three TS `…NotificationType` names in `types/`. The guard fixes
  two of the six wrong changes, both Process names, at that cost.
- **Guard by the head-share of the word before the connector.** The idea: a noun
  there (`objects` in `ObjectsForFirm`) heads the name, while a verb or a
  compound interior (`send`, `apply`, `select`, `clients`) means the name is a
  verb phrase or a modifier chain headed by its last word. The signal is the
  word's head-share in the same population: connector-free distinct names ending
  in it, over connector-free distinct names containing it. On `_v15`, 421 of 747
  connector names are complement-headed, and their pre-connector words fall in
  deciles 118 / 117 / 61 / 47 / 15 / 12 / 2 / 15 / 7 / 3 / 10. The mass sits
  below 0.2, and the only trough, `[0.6, 0.7)`, lies far above every word in
  question. The wrong words are `select` 8/99 (0.08), `apply` 2/26 (0.08),
  `clients` 9/76 (0.12) and `send` 19/135 (0.14). The right ones are interleaved
  with them: `objects` 0/3 (0), `automation` 5/48 (0.10), `job` 25/185 (0.14),
  `message` 32/203 (0.16), `note` 6/37 (0.16), and higher up `template` 0.23,
  `notification` 0.30, `event` 0.49, `response` 0.50, `form` 0.55. Folding
  singular and plural does not separate them: `send` 0.14 and `client` 57/458
  (0.12) against `automation` 7/67 (0.10) and `job` 34/263 (0.13), with `object`
  rising to 20/38. In Ruby the overlap persists: `apply` is 1/20 and `send`
  18/100, against `objects` 0/3 and `job` 4/89
  (`DisablePreviewImageJobForHeic`). TypeScript alone leaves a gap between
  `clients` 3/34 (0.09) and `automation` 5/46 (0.11), but it is a gap between
  two words, not a valley: the TS histogram holds 22 names below 0.1 and 46 in
  `[0.1, 0.2)`, so a cut there would be tuned to the sample. Any cut above 0.14
  that catches all four wrong words turns 188 of the 421 names back to
  head-final, `ObjectsForFirm`, `AutomationToConfirm` and `JobToLink` among
  them. The zero-head variant (keep head-final when the word ends no
  connector-free name) hits 51 names, none of the wrong ones, and reverts
  `ObjectsForFirm` itself. On the self-index the right heads sit at the bottom
  too: `DocumentForValidation` 0/7, `CommitWithChangedFiles` 1/21. The signal
  measures how often a word ends a compound. An entity noun in a compound-heavy
  namespace is mostly a modifier (`MessageTemplate`, `JobStatus`), so head-share
  cannot tell a noun from a verb here.
- **Positional distribution (above).** No valley on any corpus.

**A kind profile per head (`ffxfc`): measured, rejected for both uses.** The
idea: a head word's carriers say what kind of thing the word names. Per head,
per type namespace, over its carriers (connector-aware heads): the declaration
form (class; interface / type alias / enum; module), the member bucket (no
member in `cg_symbols` vs at least one, by symbol-id prefix), whether a project
type names it as a supertype, and the cohesive supertype (the `tun7x` rule).
Each axis is decided only when its dominant value holds ≥ 2 carriers and at
least half of them, the familyShare majority. Two uses were measured, each with
a stop rule: ship only if the profile separates and the flips are mostly right.
Neither use shipped, and no code changed.

What the profile is made of, on the copies:

- The member bucket adds nothing to the form in TypeScript and separates nothing
  in Ruby. `cg_symbols` records no interface members, so every TS interface and
  type alias has 0, and 0 of the self-index's 584 classes have none. In Ruby,
  attribute accessors are methods: `*Data` has members on 93% of its 175
  carriers, `*Error` on 3% of 1,316. The member share of the 493 Ruby heads with
  ≥ 3 carriers falls in deciles 39 / 13 / 17 / 41 / 13 / 33 / 40 / 21 / 38 / 24
  / 214, with no valley.
- The form separates only in TypeScript. All 355 Ruby heads with ≥ 3 non-module
  carriers sit in the top class-share decile. On the self-index the class share
  of the 191 heads is bimodal: 126 heads in the lowest decile, 8 in the top. On
  taxdome's TS, 358 of 373 heads sit in the lowest decile, because it declares
  84 classes among 18,105 types.
- Subtypes do not separate data from behaviour. `*Descriptor` (0.25) and
  `*Overlay` (0.50) have more subtyped carriers than `*Strategy` (0.04).

**A. A draft whose kind contradicts its head's profile** (a class named by a
data head, `PipelineBatchSize`; an interface named by a behaviour head).
Measured as a leave-one-out over existing types, which are mostly named right,
so a flag there approximates a false flag:

| Measure                                           | Result                                                                                                                  |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| self-index classes under a data-majority head     | 61 / 516 (65 / 563 when an implemented interface counts as behaviour); 0 of 25 hand-checked is a value-named component  |
| self-index data types under a class-majority head | 71 / 1,370; the sample is contracts (`ExploreStrategy`, `CacheStore`, `OidBatchResolver`)                               |
| taxdome TS classes under a data-majority head     | 60 / 77, all `*Error` and `*Store` classes among type aliases                                                           |
| taxdome Ruby                                      | 0 / 11,214: no head has a data majority, so no class can contradict one                                                 |
| synthetic value-named components (10)             | 4 / 10 flagged: self-index 4 / 5, taxdome Ruby 0 / 5                                                                    |
| rename eval, 17 pairs                             | unchanged, 0 caught: no pair draft states its kind or names a declaration at its path                                   |
| rename eval, 40 controls                          | 1 carries the flag, `MaterializedNode` (class; `node` 4 of 5 data), already a false flag (alt `tree`): 6 / 40 unchanged |
| t9 20-draft set                                   | unchanged by construction: no draft states its kind or exists at its path                                               |

The self-index flags are behaviour heads whose carriers are mostly interfaces,
because a TS interface is the contract a behaviour family is typed by and
structural typing rarely writes `implements`: `DuckDbGraphSession` (`session`, 3
of 3 data), `IndexMetricsQuery` (`query`, 12 of 12), `LanguageFactory`
(`factory`, 8 of 12), `DuckDbMethodEdgeReader` (`reader`, 13 of 17). A pure data
head does not help: `session`, `query` and `map` are 100% data and still wrong.
The bead's own examples fail too. `GitFileMetadata` was an interface, like
`GitFileSignals` today, so it has no kind contradiction; its defect is the word.
`PipelineBatchSize` stays silent, because the self-index's one `*Size` carrier
is a class. The synthetic set was fixed before any output: the first five
classes with ≥ 3 members, in path order, under
`src/core/domains/ingest/pipeline/` and under `app/services/`, with the head
replaced by `Size`, `Count`, `Info`, `Metadata`, `Config` in turn. The
self-index flags `BaseIndexingCount`, `ChunkInfo`, `AstSymbolMetadata` and
`CharacterConfig`, and misses `AdaptiveBatchSize`.

A kind contradiction needs interface members typed as methods versus properties.
The walkers do not record interface members, so the profile cannot tell
`CacheStore` (methods) from `GitFileSignals` (fields).

**B. Connector disambiguation by the type's own profile.** For a connector name,
the candidates are the word before the connector (the current head) and the last
word. The type matches a candidate's profile (its carriers without the type
itself) when at least one axis is decided on both sides and none disagrees. A
candidate with no decided axis neither matches nor mismatches. The name is read
head-final only when the type matches the last word's profile and mismatches the
pre-connector word's. Otherwise the current rule stands. A first cut that
counted an undecided profile as a mismatch flipped `ObjectsForFirm` (`objects`
has one carrier) and was dropped.

| Measure                                             | Result                                                                                  |
| --------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `_v15` connector-headed names (declarations)        | 459 (606): 280 Ruby, 179 TS                                                             |
| flips to head-final                                 | 19 names (25 declarations), all Ruby; TS 0                                              |
| `_v14` / self-index flips                           | 20 names / 1 (`PipelineWithConfig` → `config`, wrong: it is a `Pipeline` with a config) |
| 19 flips, all hand-checked                          | 2 right, 1 doubtful, 16 wrong                                                           |
| six wrong changes of `de19327df`                    | 0 fixed                                                                                 |
| `_v15` strongest-role changes                       | 13: 4 right, 9 wrong                                                                    |
| the 173 changes of `de19327df`                      | 3 wrong ones fixed (`converter` ×3), 4 right ones broken (`attributes` ×4)              |
| coverage `_v15` / `_v14` / self-index               | 19,270 → 19,277 / 19,207 → 19,213 / 741 → 741                                           |
| samples `_v14` s7, `_v15` s7/11/23, self s7         | none of the sampled types changes role                                                  |
| `ObjectsForFirm`, `AccountsForFirm`, `EventForFirm` | keep the pre-connector head, but `ActorsForFirm` and `EventsForFirm` flip to `firm`     |

The two right flips are `TextToImageConverter` and `SignInAllowance`. The wrong
ones are verb-object commands: `MigrateBlobsToImages` → `images`,
`UnlinkPaymentFromBill` → `bill`, `MarkNotificationAsRead` → `read`,
`ListContactsForEmail` → `email`, the contracts `ListByContact(s)` →
`contact(s)`. The cause is the same one that defeated the suffix guard: a
`KindOfService` command ending in an entity noun gives that noun its own profile
(class, members, `KindOfService`), so a command with a complement matches its
object. `firm` is 13 such carriers. None of the targets move:

- `SendToOpensearchProcess`: `send` and `process` have one profile (class,
  members, `KindOfService`), so both match.
- `TemplateSelectWithHookParamsBase` and `BulkAddClientsToPipelineBody`: the
  carriers of both candidates (`select` / `base`, `clients` / `body`) are type
  aliases with no members, like the names themselves, so both match.
- `RunBatchApplyToClientsAsyncOperation`: `operation`'s carriers share
  `ApplicationRecord` (the `AsyncOperation` model), which the command does not
  declare, and `apply` matches, so the current head stays.
- The recount targets (`DeleteExpiredMonthlyIndicesProcess`, `AsyncOperation`,
  `NewProposalDefaultClients`) follow the heads above, so they do not move
  either.

The strongest-role changes: `HtmlConverter`, `PDFConverter` and a bare
`Converter` regain `converter` beside `TextToImageConverter` (right). The four
`*Attributes` models regain a suffix that `GetAuthAttributesByDeeplink`, a
command, props up. `TaxPayments`, `GroupOfPayments` and `Payment` lose theirs.
`ActorsForFirm` and `EventsForFirm` gain `firm`.

Roles are computed at read time from `cg_type_declarations` (§1b) by one store
query behind a daemon op. They are not persisted: they are cheap aggregates, and
a stored copy would go stale on every incremental run.

## 3. Judging a type-name draft

The draft gains `kind: "type"` with `{ name, path, extends?, concept? }`. `path`
is the file the type will live in; `extends` its planned ancestor.

| Verdict   | When                                                                                                                           |
| --------- | ------------------------------------------------------------------------------------------------------------------------------ |
| MISFIT    | the family (via `extends`) or the directory (via `path`, members only, §2) has a role the name lacks; suggestion = name + role |
| COLLISION | the short name already exists as a type in another module (homonym risk, e.g. `Commit` vs `CommitInfo`), unless conventional   |
| NEW_TERM  | no role evidence and no aligned term (section 4); carries `alternatives` when section 4 found candidates                       |
| CONFORMS  | the name carries the role and its terms align; may carry head `alternatives` (section 4, head by meaning)                      |

Casing follows the file language of `path`, as for value names.

**One type namespace per draft** (`icuxg`). The draft is judged against the
declarations of its own TYPE NAMESPACE only: the language of `path` plus every
language whose naming capability declares the same `typeNamespace`. A language
that declares none owns its namespace alone. This covers the COLLISION check and
all role and term evidence: the directory and family roles, established
modifiers, head counts, the null similarity distribution, and `evidence.n`. A
Ruby `Result` beside a TSX `Result` is no collision, because neither file can
import the other's type. TypeScript and JavaScript both declare `ecmascript`,
because they do import each other's types (`allowJs`, a `.d.ts` beside its
`.js`, a JS entry point loading TS source), so a TS `Widget` draft collides with
a JS `Widget`. When the draft's path has no known language, every language is
read, which was the behaviour before this rule.

The answer's top-level `language` is the language the answer is written in. It
is the request's; else the `pathPattern`'s; else the language of the evidence
rows for the asked types and callees; else the language most type drafts' paths
are written in; else the project's dominant language. A type draft judged in any
other language names its own language in `names[].language`. Diff mode already
answers once per language, so each name is judged in its own language and the
field never reaches `review.findings`.

**A conventional short name is no collision** (`icuxg`). COLLISION exists to
catch a new homonym of a RARE name. A short name the project declares in many
modules is its convention: per-namespace `Result` objects, qualified at use. The
bar is the project-suffix role's own criterion, so one rule decides "the project
writes this" (`meetsProjectConventionSpread`). The short name must be declared
as a type in at least `projectSuffixMinTypes` files (3) across at least
`projectSuffixMinDirs` directories (2). Only declarations in the draft's type
namespace count, and the draft's own file and ambient `.d.ts` files are
excluded. Above the bar there is no COLLISION, and the draft goes on to the role
and term stages. A name below the bar still collides: one or two existing
declarations, or several in one directory, are a real homonym.

Measured on taxdome with the vi0wx N2 request (20 Ruby type drafts). The
answer's `language` went from `typescript` to `ruby`. The `Result` draft at
`app/services/getting_paid/payments/result.rb` had collided with the TSX
`Result` in `ImportSidebar.tsx` (`n: 271`, counted across languages). Namespace
scoping alone made it collide with the Ruby `AbstractPolicy::Result` (`n: 260`).
Taxdome declares 260 Ruby `Result` types, so it is a convention, and the draft
now CONFORMS with a head alternative `summary` (0.632). 18 verdicts are
unchanged. `ClientDataManager` stays CONFORMS but carries a head alternative
(`methods`, 0.68) it lacked before namespace scoping: the null similarity
distribution is measured over Ruby heads only, so its floor moved. On tea-rags
the rename eval and the t9 alignment set are unchanged.

Every verdict judges VOCABULARY. CONFORMS means consistent with the project's
vocabulary: its words, roles and spellings. It says nothing about whether the
name fits the behaviour of the code it names. A `Parser` that validates conforms
if the project writes `Parser`. Whether the name matches the behaviour is the
reviewer's call.

## 4. Term alignment: reuse the project's words

A name is split into slots: the HEAD (the tail words naming the entity, `Doc`)
and QUALIFIERS (the words before it, `Calculated`). Each slot is aligned with
the project's existing vocabulary.

**Head slot.** For one concept the project has a dominant spelling. If the
project writes `Doc` 200 times and `Document` 3, a draft `CalculatedDocument`
gets `…Doc`. Compared among heads of the same family or role.

A spelling variant is a CLIPPING of one word: the shorter abbreviates the longer
(same first letter, letters in order, at most 60% of its length). A stem plus an
inflection or an agent ending (`-s`, `-es`, `-ed`, `-ing`, `-er`, `-or`, and
their plurals, allowing a doubled final consonant or a dropped silent `e`) is
another word, not a spelling (`tun7x`). `scan` / `scanner` and `run` / `runner`
name the act and the actor. `doc` / `document`, `stats` / `statistics` and
`meta` / `metadata` stay variants. The ending set is closed-class English
morphology, like the plural rules of `singularizeIdentifierWord`. It is not a
tuned list. Live, the control type `FileScanner` had been offered `scan`. After
the rule it conforms, and no head by meaning takes the offer's place.

`SnapshotMeta` → `metadata` is not a defect. The project writes `Metadata` 4
times and `Meta` twice, and `meta` is a clipping of `metadata`. That is the
dominant-spelling rule doing what this section asks. The eval scores it as a
false flag only because the owner never renamed the type.

**Version tokens are not vocabulary (`tun7x`).** A word of the project's
vocabulary is letters only, the same test the abbreviation rule already applies.
A token with a digit (`v1`, `v11`) names a value, not a concept. It is never an
established modifier. A draft qualifier carrying one is neither replaced nor
compared by meaning, and it does not count in the draft's m. Live, `V11Store`
was offered `v1` for `v11` (similarity 0.736). Now it conforms: `store` is a
project suffix.

**Qualifier slot.** The project's modifier vocabulary is the set of words that
stand before a head in type names. A modifier is ESTABLISHED when it combines
with several distinct heads in several directories (`PredefinedTemplate` in
`templates/`, `PredefinedField` in `fields/`).

A similar case is found by meaning, and the attempt is ALWAYS made:

1. The concept query is the agent's `concept` when given; otherwise the draft's
   own words (`calculated doc`); in diff mode, also the code of the chunk that
   encloses the declaration.
2. A semantic search over the index returns the code nearest to that concept.
3. Each established modifier gets a lift: its frequency in the returned code
   over its frequency in the project.
4. The draft's qualifier is not established, and an established modifier has
   lift above the floor → `alternatives: [{ word, heads, domains, lift }]`, for
   example
   `Predefined — PredefinedTemplate (templates/), PredefinedField (fields/)`.
5. Nothing clears the floor → a new concept: NEW_TERM with no alternatives. That
   is a legitimate outcome, not a failure.

**Head by meaning (`433d2`).** A draft can name a known concept with a synonym
head: `EmbeddingBackend` for `EmbeddingProvider`, `ProjectCatalog` for
`CollectionRegistry`. Neither spelling nor lift catches that, and the project
suffix rule even confirms the draft (`backend` is a suffix here). So:

1. Candidates are the heads of production types ANCHORED to the draft: sharing a
   qualifier word with it (`Embedding*`) or living in its directory. A head
   fewer than 2 project types end in is dropped: it is one type's choice, not
   the project's word. The exception is a head exactly ONE type carries whose
   file is imported at least as much as the project's `popular` files. The
   threshold is the lower bound of the `codegraph.file.fanIn` band `popular` in
   the draft's language, read from the same label map `get_index_metrics`
   publishes and the reranker labels by (self-index: 2). `Reranker` is one
   central type, while `site`-style noise is many weak carriers. It needs the
   request's `path`; without it no head is established by usage. Every index
   read of one request (the concept searches, this metrics read) addresses the
   collection resolved once for the request, in the resolver's priority
   collection > project > path (`2kplu`). Before that, a `{collection, path}`
   request, which is how a worktree is validated against its project's index,
   read the metrics of the collection the path hashes to. That collection did
   not exist, so the notice "type-name alignment skipped" turned alignment off
   for the whole request.
2. The draft's directory words are candidates too, at the slot of the draft word
   they are compared with, head or qualifier (`IndexStalenessChecker` in
   `maintenance/freshness/` → `freshness` for `staleness`). A pair sharing a
   stem (`chunk` / `chunker`) is not compared.
3. Every candidate must be grounded in the concept code (step 2 above): a head
   candidate heads a type name there, and a directory word is a word of one.
   Only grounded candidates are embedded.
4. Each word is embedded twice, bare and as `class <word>`, in ONE batch per
   draft (cached per request). Similarity is the mean of the two cosines. The
   most similar head candidate whose similarity EXCEEDS the draft's floor is
   offered as `{ word, slot: "head", similarity, examples }`. The most similar
   directory-word pair above it is offered as
   `{ word, slot?, replaces, similarity, domains: [dir] }`.
5. The floor is adaptive, not a constant, and it is corrected for the number of
   comparisons. The null distribution is the same similarity over every pair of
   the project's own heads carried by ≥ 2 types. The sample is 64 of those heads
   in the order of a hash of the word, deterministic and unbiased: ≤ 2,016
   pairs, embedded in one batch the first time a request needs it and reused for
   candidate words it already holds. A draft compared on m pairs
   (`typeDraftMeaningPairs`: its head with the spelling variant and with each
   grounded head candidate, each draft qualifier with each lifted qualifier
   candidate, every draft word with each directory word, stem pairs excepted,
   each distinct pair once) must exceed the null quantile `0.9^(1/m)`
   (`perComparisonQuantile`). That is the Šidák correction of the family-wise
   level `NULL_SIMILARITY_QUANTILE` = 0.9: the chance that ANY of the draft's m
   random pairs clears its floor stays 10%, whatever m is. m = 1 is the plain
   p90. The level is a definition of "unusually close", not a tuned value. m is
   counted before any pair is judged, so a pair a spelling variant would
   pre-empt still counts and the floor never depends on its own outcome. The
   corrected quantile is capped at what the sample resolves, `1 − 1/pairs`
   (0.9995 for 2,016 pairs, reached at m ≈ 210; 0.978 for the 45 pairs of a
   10-head sample, reached at m ≈ 5): beyond it the quantile is the sample's
   maximum, not a measured tail. Under 10 such heads there is no alignment by
   meaning.
6. With embeddings, a spelling variant must also exceed the floor. `site`
   abbreviates `splitter` letter by letter at similarity 0.29, so it goes. A
   head the spelling rule already aligned gets no second head by meaning.
7. The alternative attaches to NEW_TERM, and to a CONFORMS that rests only on a
   project suffix or on known words. The verdict stays CONFORMS, and in diff
   mode such a CONFORMS is a finding. A name carrying its expected family or
   directory role gets no alternative by meaning. MISFIT outranks all of this.
8. Embedding unavailable or failing: one notice, the same one as a failed
   concept search. Drafts are judged as before, without alignment by meaning and
   with the spelling variant and the lifted qualifiers ungated. The same holds
   when the population has too few heads to place a floor on.

**Lexical qualifiers under the same floor.** Lift says a modifier is frequent in
the concept code, not that it means the draft's qualifier. For a new concept the
concept search returns unrelated code, and lift picks its noise. Live, in diff
mode over this wave's commits, `HeadCandidate` drew `markdown`, `git` and
`commit`, and `MeaningGate` drew `documentation`, `is` and `similar`. So with
embeddings a qualifier alternative passes the same per-draft floor as every
other alternative. The three most lifted candidates are chosen by lift alone,
before any similarity is read. Each is paired with every draft qualifier, and
those pairs count in m. A candidate stands in for the qualifiers as a whole, not
for one word, so it is offered when its most similar pair exceeds the floor and
it carries that qualifier as `replaces`, plus the `similarity`. Measured with m
= 3 and a floor of 0.624: `HeadCandidate` peaks at `git` (0.394) and gets no
alternative. `MeaningGate` keeps `documentation` for `meaning` (0.697) and drops
`is` (0.622) and `similar` (0.608). The rule does not decide whether
`documentation` is a good word for this draft, and `is` misses the floor by
0.002. The 20-draft measurement set carries no lifted qualifier, so its m,
floors and offers are unchanged: `stats`, `provider`, `manager`, `executor`, 0
wrong.

**Null distribution.** Over all 296 heads of the self-index carried by ≥ 2 types
(43,660 pairs, jina-embeddings-v2-base-code), the head-pair similarity has p50
0.410, p90 0.562, p95 0.604, p98 0.654 and p99 0.686. The 64-head hash sample
reproduces it within 0.015: p50 0.402, p90 0.558, p95 0.596, p98 0.645, p99
0.672. The 64 MOST-carried heads do not. They are generic words (`result`,
`options`, `config`) closer to each other than the population is, and they put
p90 at 0.593, which silently dropped `chunker` (0.571).

**Measurement.** 20 drafts naming known concepts by synonyms, 11 with ground
truth. With a single p90 floor (0.558) for every draft the run gave 6 hits and 5
wrong. The wrong alternatives sat at 0.565 to 0.667, the null distribution's own
p90 to p98: a draft compared on several pairs at p90 each lets a random pair
through far more often than one time in ten. A p95 floor (0.596) gave 5 hits and
1 wrong, but that is a tuned value. The per-draft correction replaces both.
Live, p90 of the (re-indexed) sample 0.562:

| Draft                 | m   | Floor | Best pair (similarity)              | Offered    | Truth        |
| --------------------- | --- | ----- | ----------------------------------- | ---------- | ------------ |
| SignalStatistics      | 4   | 0.637 | `stats` (0.926, spelling)           | `stats`    | hit          |
| EmbeddingBackend      | 3   | 0.624 | `provider` (0.661)                  | `provider` | hit          |
| ProjectCatalog        | 7   | 0.663 | `registry` (0.639)                  | —          | missed       |
| PayloadFieldDoc       | 10  | 0.674 | `descriptor` (0.625)                | —          | missed       |
| IndexStalenessChecker | 6   | 0.654 | `freshness` for `staleness` (0.617) | —          | missed       |
| ChunkSplitter         | 2   | 0.603 | `chunker` (0.571)                   | —          | missed       |
| ChunkChurnInfo        | 10  | 0.674 | `stats` (0.667)                     | —          | wrong gone   |
| SearchScorer          | 7   | 0.663 | `explore` for `search` (0.580)      | —          | 2 wrong gone |
| EnrichmentWorkerPool  | 3   | 0.624 | `executor` (0.770)                  | `executor` | real term    |
| VectorDbAdapter       | 8   | 0.667 | `manager` (0.675)                   | `manager`  | real term    |

Result: 2 hits, 0 wrong, 2 real terms outside the ground truth. The correction
does what it claims — no alternative on these drafts is within the reach of
chance — and the price is recall: four true synonyms (0.571 to 0.639) sit below
their corrected floors. They are as close to the draft as the null p90–p97, so
at this embedding model they cannot be told from chance once the draft's other
comparisons are paid for. Recovering them needs a stronger signal, not a lower
floor. Out of reach as before: `reranker` (0.469), `metrics` (0.493), `overlay`,
`signals`, and `outline` (`FileSummaryView` is a MISFIT). The held-out set is
uninformative: MISFIT or COLLISION for five drafts, and `PipelineBatchSize` (m =
4, floor 0.637) conforms with nothing to offer.

How the directory-word rule was chosen: first the project's vocabulary alone
decided a term ("a word of any type, or a directory of ≥ 2 files"). That let
`core`, `api`, `static`, `explore`, `ingest` and `maintenance` through, each
0.57 to 0.62 similar to some draft word, as close as the one true pair
(`staleness` / `freshness`, 0.617): 7 wrong, 0 hits. `checker` / `maintenance`
(0.621) even outranked it. Grounding in the concept code is what separates them.

**Measured and rejected: co-change neighbourhood as a candidate source.** Heads
taken from the files that co-change with the draft's directory, lift-normalized,
put the truth first for 4 of 14 drafts, including the held-out `RubyBodyGrouper`
→ `chunker`. In union with concept grounding it added 1 hit and 2 to 3 wrong
alternatives above the floor, so it is not used.

Cost: about 65 ms per type draft, plus one null-sample batch per request (128
short texts). The 20-draft call went from 2.1 s without embeddings to 4.4 to 6.0
s warm; the correction itself is arithmetic on the cached distribution.

The verdict stays soft (NEW_TERM + alternatives, never MISFIT). This is a
judgement by meaning, and the agent decides whether to reuse the term or
introduce a new one. The same alignment applies to value names
(`calculatedDoc`).

**Rename eval (`tun7x`).** `scripts/naming-rename-eval.ts` judges the project's
own 17 type renames, each OLD name at NEW's path, and a frozen control of 40
types that were never renamed and are older than 90 days. The three rules above
(directory membership, stem vs spelling, version tokens) were measured one at a
time:

| Step                       | Control false flags | Renames caught / flagged-other / silent |
| -------------------------- | ------------------- | --------------------------------------- |
| baseline                   | 9/40 (22.5%)        | 0 / 9 / 8                               |
| + directory membership     | 7/40 (17.5%)        | 0 / 9 / 8                               |
| + stem is not a spelling   | 6/40 (15.0%)        | 0 / 9 / 8                               |
| + version tokens not words | 5/40 (12.5%)        | 0 / 9 / 8                               |

All 17 rename verdicts are byte-identical to the baseline. Only the four
targeted controls changed, and each moved to CONFORMS. The 20-draft measurement
set above is unchanged too: `stats`, `provider`, `manager`, `executor` and the
same five MISFITs. Without the head-by-meaning exclusion for non-members, the
membership rule alone cut the control to 8/40, because
`RubyDynamicDispatchResolver` turned from MISFIT → `…Strategy` into CONFORMS
with the head alternative `strategy`: the same demand, offered by meaning.

Five control flags remain, and none is a defect of the rules:

- `FormatProjectsOptions` MISFIT → `…Args`: the `cli/commands/` family is not
  cohesive, see §2.
- `SnapshotMeta` → `metadata`: the dominant spelling, correct by this section.
- `DangerousCompositePreset` → `bug` for `dangerous` (0.748): a lifted qualifier
  that cleared the corrected floor. It is not a spelling variant. Neither
  `dangerous` nor `composite` is established (`composite` qualifies only
  `preset`), and the concept code is the bug-hunt presets. The qualifier
  discriminates one member of a role family from its siblings. Suppressing
  qualifier alternatives on role-carrying names would also silence the mechanism
  that could catch the six `search` → `explore` renames, so it is not done.
- `FilterSpec` → `descriptor` (0.721) and `MaterializedNode` → `tree` (0.657):
  heads by meaning that cleared the Šidák floor. The floor is not moved to
  remove them.

Known limit: when the semantic search does not retrieve the code where
`Predefined*` lives, no alternative is offered. Recall is bounded by the
embedding model; the live measurement below quantifies it.

**Field report `i569j` (taxdome stack review, 2026-09-27).** Four offered
alternatives were embedding-neighbour noise. Each was diagnosed against the
gates above; the per-draft floor is not moved, and each rule below is the one
the data confirmed.

- A concept hit's NAMESPACE is not concept code. `preparation` was offered for
  `helper` (`RefusalsHelper`, similarity 0.706, lift 0) and for `args`: a
  directory word grounded only because every hit under `TaxPreparation::…` made
  the declared module `TaxPreparation` a concept type name. The concept type
  names of a hit are now its own segments, after its last `::`, split at `#` /
  `.`. The namespace locates the hit the way its directories do, so it grounds
  no term, lifts no modifier and anchors no head. TypeScript symbol ids carry no
  `::`, so the self-index is unaffected by construction.
- A clipping of several project words spells none of them. `Refusals` was
  offered `refs` (similarity 0.788) as the project's spelling of `refusals`, but
  taxdome writes `refs` for `references`, and also writes `refunds`. A spelling
  variant that also clips another project word (the draft word's own singular or
  plural excepted) is dropped. `stats` still spells `statistic(s)`.
- A candidate sharing the replaced word's stem restates it.
  `TaxpayerLookupError` was offered `taxes` for `taxpayer`. Two words now also
  share a stem when one of them is their common prefix (at least three letters)
  plus an inflection or agent ending, the closed-class morphology of `tun7x`:
  `taxes` / `taxpayer`, `refs` / `refusals`. A lifted qualifier sharing a draft
  qualifier's stem and a head candidate sharing the draft head's stem are no
  candidates, and do not count in m. The spelling channel keeps its own rule: a
  clipping of the draft word is what it is for.
- Not changed: `RefusalsConcern` in diff mode drew `inconsistent` for `refusals`
  (lift 89.7, similarity 0.678). The concept query carries the declaration's
  code, a list of error classes, so `Inconsistent*Error` types lift; the pair
  clears the corrected floor with no stem or path link. It is the
  `DangerousCompositePreset` case above, and is not suppressed.

Measured on the rename eval, base `7f0301b1b` and the branch interleaved, two
runs each: byte-identical reports, caught 0 / flagged-other 7 / silent 10,
control 6/40. On the 20-draft set, `stats`, `provider` and `executor` are
unchanged (`manager` is absent from the base build too since the self-index
rebuild), and `ChunkSplitter` now gets its ground-truth synonym `chunker`
(0.571): with the stem-sharing candidates out of m, its floor drops below it.

## 5. Novel free names

A value draft of FREE shape that is not among the names the project already uses
for that type is NEW_TERM, with the type's top names as context (for
`x: SymbolDefinition`: `defs`, `candidates`, `fallback`). Before this spec it
was CONFORMS, because the shape share of FREE passed the 0.2 bar. A known free
name stays CONFORMS.

The same holds for the rows of the call a draft is bound to (bd
tea-rags-mcp-hn2vt). `thing = registry.findByName(n)` against the project's
`entry = registry.findByName(…)` rows is NEW_TERM with `entry` as context, not
CONFORMS: a FREE share licenses the roles the project already gives that call's
value, not any word. The comparison is by words in either number, so `row`
against `rows` is known. A draft bound to a call with no rows at all, and with
no type the project holds, still has nothing to compare with and stays `novel`
(`thing = mysteryCall()`, `other = client.quickbooks_customer` on taxdome).
Reporting those would need a judgement of the name itself. The ontology's
`genericName` is that judgement, and it needs the name's own history across
types.

## 5a. What counts as evidence (bd tea-rags-mcp-xsxkr)

A field review of a taxdome stack found verdicts resting on the draft itself:
`RefusalsConcern` CONFORMS with its own declaration as the one carrier, a
nonexistent `RefusalsHelper` CONFORMS with `n = 0`, `store_entity!` CONFORMS
with its own symbol as the only example, `collision: true` on names that exist
only as themselves, and names mode disagreeing with diff mode on the same
declaration. The rules below close those.

1. **A draft's own declaration is never its evidence.** Diff mode already leaves
   changed files out of every read. Names mode now does the same for any draft
   that names its file: a type draft drops the rows declared at its path under
   its own short name before counting heads, directory roles, families or `n`
   (`typeDraftEvidence`). Its supertypes and kind are kept as facts ABOUT the
   draft, since they decide membership rather than support it. A value draft
   (`local`, `param`, `return`) with a `path` is judged with that file excluded
   from the store, so its own row neither counts toward `n` nor collides with
   it. A value draft with no `path` has no identity names mode could exclude;
   that is the caller's contract, stated in the resource text.
2. **CONFORMS rests on evidence.** A type CONFORMS names the role it rests on
   (`role`: the expected family role or the project suffix, with examples). A
   value draft that nothing compares — no type rows, no callee rows, no concept
   terms — CONFORMS only when other rows carry the name (`nameRows > 0`), else
   it is novel: NEW_TERM with no topTerms. That also removes the
   location-dependent flip of `result` (CONFORMS where the bound call derives no
   name, NEW_TERM `[]` where it derives an unlicensed one): both paths now read
   the same count.
3. **A value MISFIT needs a convention.** The suggestion must be carried by at
   least `MIN_ROLE_MEMBERS` (2) rows; against thinner evidence the draft is
   NEW_TERM with the row names as context. The store has no distinct-holder
   count, so the bar is on rows, not holders.
4. **A local named after its own type conforms** (EXACT or TAIL shape) when
   there is no convention, or when another kind of the type's values (a param, a
   return) spells the name that way. `tax_preparation: TaxPreparation` against
   `existing` (3 locals) and `tax_preparation` (18 params) is CONFORMS; against
   `existing` alone it stays a MISFIT.
5. **A MISFIT suggestion keeps what the draft says about WHICH value.** The
   draft is split at its connector (`for`, `by`, `under`, … — the closed
   `CONNECTOR_WORDS` list, which gained `under`). If the words before the
   connector already are the suggestion, the draft CONFORMS
   (`tax_automation_documents_for_payload`). Otherwise only the head part is
   replaced and the complement kept (`filed_under_another_entity` →
   `tax_automation_documents_under_another_entity`). A suggestion that would
   only delete words of a connector-free draft (`other_node` → `node`) is not a
   rename: NEW_TERM naming the project's word.
6. **A collision names what it collides with.** `evidence.collisions` lists up
   to three symbol ids of other declarations of the name (own file excluded), so
   an override (`same_firm?` against `AbstractPolicy#same_firm?`) reads as one.
   It is absent without a collision, in diff mode, and when the lookup is
   unavailable.

Diff mode and names mode still differ on concept terms: the diff's concept query
carries the enclosing code, names mode only the name.

## 6. Diff mode (`fdef2`)

Input: `changes: { base?: string }` (default `HEAD`: working tree against HEAD,
untracked files included) or `files: string[]`. It is a third draft source next
to `names[]` and `concept`.

1. **Changed files.** `git diff --name-only <base>` plus untracked files,
   through the existing git CLI adapter. Capped at 200 files per call.
2. **Drafts.** Each changed file's working-tree text runs through its language's
   extraction in memory: the `identifierDeclarations` channel and the
   identifier-row builder for value names, and the symbol pass for type names.
   No indexing. A draft carries exactly what an agent would pass:
   `{ name, kind, type?, typeMultiplicity?, callee?, path, extends? }`.
3. **Hunk filter.** `git diff -U0 <base>` gives the added line ranges; a draft
   is judged only when its line is in one. Untracked files count whole.
4. **No self-confirmation.** Every evidence read (by type, by callee, generic
   names, roles, modifier vocabulary) takes `excludePaths` = the changed files.
   An incremental reindex or an auto-update run that already indexed the change
   can therefore not let a new misfit vote for itself.
5. **Output.** The conforming declarations are counted in a summary; only
   findings are listed, each with `file:line`. GENERIC is a value draft whose
   verdict carries the existing `genericName` caveat, even when it otherwise
   conforms:

```
Naming review (base: HEAD) — 42 declarations checked, 37 conform
MISFIT    src/x.ts:12   meta: GitFileSignals      → fileSignals  (computeFileSignals)
GENERIC   src/x.ts:30   result: ParseResult       13 unrelated types carry this name
NEW_TERM  src/y.ts:8    environment: FooContext   no precedent; type vocabulary: ctx, context
NEW_TERM  src/y.ts:21   CalculatedDoc             alternative: Predefined (templates/, fields/)
COLLISION src/y.ts:40   Commit (new class)        short name exists: src/git/commit.ts
```

## 7. Code placement

| Unit                              | Owner                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------ |
| `symbol_kind` extraction          | each `domains/language/<lang>/walker`                                                |
| migration 035                     | `domains/maintenance/migration/database`                                             |
| role, head and modifier reads     | DuckDB adapter store + daemon op                                                     |
| role derivation, slot split, lift | pure functions in `domains/explore/naming-lexicon`                                   |
| diff reading                      | existing git CLI adapter                                                             |
| in-memory extraction              | `LanguageFactory` (factory encapsulates construction)                                |
| orchestration                     | `NamingLexiconOps`                                                                   |
| DTO + schema                      | `api/public/dto/naming-lexicon.ts`, `src/mcp/tools/codegraph.ts` (byte budget holds) |

Backbone touch points (tea-rags enrichment): `adapters/duckdb/client.ts` (fanIn
6, 49 commits), `daemon/op-commands.ts` and `daemon/client.ts` (bugFixRate
concerning). New daemon ops go through the existing protocol pattern and rebuild
`build/` before any integration test.

## 8. Consumers

- `mr-review` skill: naming as its eighth signal dimension, fed by diff mode.
- `data-driven-generation` skill: a naming-review step before commit.
- Both are plugin edits: minor plugin version bump.

## 9. Validation

- Unit: TDD per verdict; fixtures shaped like the live data (the GitFileSignals
  lesson: an assumed row shape hid a live defect).
- Live, on the tea-rags self-index and on taxdome (Ruby-scoped recompute):
  - role coverage: share of types with a role, per language;
  - a hand-checked sample of 30 role assignments (precision);
  - term alignment: 20 known reuse cases (a qualifier or head the project
    already uses for the meaning), how many produce the right alternative;
  - diff mode: a diff introducing `meta: GitFileSignals` into an ALREADY indexed
    file still reports MISFIT `fileSignals`.
- Recompute: `--force-enrichments codegraph` under the heavy-measure lock.

## Handoff to xb669

When `vi0wx` lands, message session 95aadf75 with:

- the role API: the daemon op and ops method names; roles are derived at read
  time from DuckDB tables, not a payload key;
- granularity: type; a file's role = dominant role of its top-level types;
- the measured role coverage and the sampled precision.

## Open risk

A write-time draft that spells the collection in `type` (`type: "Item[]"`) finds
no rows: the tool expects the element type plus `typeMultiplicity`. Diff mode is
immune (drafts come from the walker). The schema says so; whether to also parse
common collection spellings in the ops layer is decided after the live
measurement.
