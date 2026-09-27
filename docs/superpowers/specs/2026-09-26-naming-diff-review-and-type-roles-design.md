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
   file now has no primary.
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
unchanged: 0/17 caught, 9 flagged-other, 8 silent, control 5/40.

The `Cookies` ancestor seen on `ApplicationController` is not a defect in role
evidence. The Ruby walker records `include ActionController::Cookies` as a
supertype, and families key on the last segment. The role it yields
(`controller`) is right; only the scope label is a mixin. Last-segment keying
does merge distinct ancestors that share a name (`Base` is eight classes on
taxdome). Resolving written supertypes to declared type ids would separate them,
but that is a per-language lookup and was left out of this change.

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

Roles are computed at read time from `cg_type_declarations` (§1b) by one store
query behind a daemon op. They are not persisted: they are cheap aggregates, and
a stored copy would go stale on every incremental run.

## 3. Judging a type-name draft

The draft gains `kind: "type"` with `{ name, path, extends?, concept? }`. `path`
is the file the type will live in; `extends` its planned ancestor.

| Verdict   | When                                                                                                                           |
| --------- | ------------------------------------------------------------------------------------------------------------------------------ |
| MISFIT    | the family (via `extends`) or the directory (via `path`, members only, §2) has a role the name lacks; suggestion = name + role |
| COLLISION | the short name already exists as a type in another module (homonym risk, e.g. `Commit` vs `CommitInfo`)                        |
| NEW_TERM  | no role evidence and no aligned term (section 4); carries `alternatives` when section 4 found candidates                       |
| CONFORMS  | the name carries the role and its terms align; may carry head `alternatives` (section 4, head by meaning)                      |

Casing follows the file language of `path`, as for value names.

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
   request's `path`; without it no head is established by usage.
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
